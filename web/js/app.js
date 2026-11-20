import { parseCsv, sampleValues } from "./csv.js";
import { familiarity, MATCH_ROLE_IDS, ROLES, suggestMapping } from "./headers.js";

const STORAGE_KEY = "sfdc-dupe-review-dismissed-v1";
const PAGE_SIZE = 40;
const MATCH_LABELS = {
  name: "Name",
  website: "Website",
  domain: "Domain",
  linkedin_url: "LinkedIn URL",
  linkedin_id: "LinkedIn ID",
  zoominfo: "ZoomInfo",
};

const state = {
  screen: "upload",
  file: null,
  headers: [],
  samples: {},
  mapping: {},
  suggested: {},
  confidence: {},
  familiarity: "unknown",
  phase: "Starting",
  pct: 0,
  error: "",
  groups: [],
  records: {},
  warnings: [],
  accountCount: 0,
  rowCount: 0,
  query: "",
  tier: "all",
  typeFilter: "all",
  showDismissed: false,
  page: 0,
  selectedId: null,
  dismissed: new Set(Object.keys(readStore())),
};

let worker = null;

const app = document.querySelector("#app");

document.addEventListener("keydown", (event) => {
  if (state.screen !== "review") return;
  const tag = (event.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  const visible = visibleGroups();
  const index = visible.findIndex((group) => group.id === state.selectedId);
  if (event.key === "j" || event.key === "ArrowDown") moveSelection(visible, index + 1);
  else if (event.key === "k" || event.key === "ArrowUp") moveSelection(visible, index <= 0 ? 0 : index - 1);
  else if (event.key === "d" || event.key === "D") {
    const group = visible[index];
    if (group) toggleDismiss(group);
  } else if (event.key === "Escape") {
    state.selectedId = null;
    render();
  } else return;
  event.preventDefault();
});

render();

function render() {
  if (state.screen === "upload") app.innerHTML = uploadHtml();
  else if (state.screen === "mapping") app.innerHTML = mappingHtml();
  else if (state.screen === "progress") app.innerHTML = progressHtml();
  else app.innerHTML = reviewHtml();
  bind();
}

function bind() {
  const input = document.querySelector("#file-input");
  const zone = document.querySelector(".dropzone");
  if (input && zone) {
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) void acceptFile(file);
    });
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("drag");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("drag");
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) void acceptFile(file);
    });
  }

  document.querySelectorAll("[data-single]").forEach((select) => {
    select.addEventListener("change", () => {
      const role = select.dataset.single;
      setColumns(role, select.value ? [select.value] : []);
    });
  });
  document.querySelectorAll("[data-add]").forEach((select) => {
    select.addEventListener("change", () => {
      if (!select.value) return;
      const role = select.dataset.add;
      setColumns(role, [...(state.mapping[role] || []), select.value]);
    });
  });
  document.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const [role, column] = button.dataset.remove.split("\t");
      setColumns(role, (state.mapping[role] || []).filter((item) => item !== column));
    });
  });

  document.querySelectorAll(".js-find").forEach((button) => button.addEventListener("click", startMatch));
  const reset = document.querySelector("#reset-mapping");
  if (reset) {
    reset.addEventListener("click", () => {
      applySuggestion(suggestMapping(state.headers));
      render();
    });
  }
  const back = document.querySelector("#back-upload");
  if (back) back.addEventListener("click", resetUpload);
  const cancel = document.querySelector("#cancel-match");
  if (cancel) {
    cancel.addEventListener("click", () => {
      if (worker) worker.terminate();
      worker = null;
      state.screen = "mapping";
      render();
    });
  }

  const search = document.querySelector("#search");
  if (search) {
    search.addEventListener("input", () => {
      state.query = search.value;
      state.page = 0;
      render();
      const next = document.querySelector("#search");
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
  }
  const tier = document.querySelector("#tier");
  if (tier) {
    tier.addEventListener("change", () => {
      state.tier = tier.value;
      state.page = 0;
      render();
    });
  }
  const type = document.querySelector("#type-filter");
  if (type) {
    type.addEventListener("change", () => {
      state.typeFilter = type.value;
      state.page = 0;
      render();
    });
  }
  const showDismissed = document.querySelector("#show-dismissed");
  if (showDismissed) {
    showDismissed.addEventListener("change", () => {
      state.showDismissed = showDismissed.checked;
      state.page = 0;
      render();
    });
  }
  document.querySelectorAll("[data-group]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = Number(button.dataset.group);
      render();
    });
  });
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      state.page = Number(button.dataset.page);
      render();
    });
  });
  const dismiss = document.querySelector("#dismiss");
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      const group = state.groups.find((item) => item.id === state.selectedId);
      if (group) toggleDismiss(group);
    });
  }
  const closeDetail = document.querySelector("#close-detail");
  if (closeDetail) {
    closeDetail.addEventListener("click", () => {
      state.selectedId = null;
      render();
    });
  }
  const download = document.querySelector("#download");
  if (download) download.addEventListener("click", downloadCsv);
  const another = document.querySelector("#another");
  if (another) another.addEventListener("click", resetUpload);
  const columns = document.querySelector("#change-columns");
  if (columns) {
    columns.addEventListener("click", () => {
      state.screen = "mapping";
      render();
    });
  }
}

async function acceptFile(file) {
  const name = file.name || "upload";
  if (!/\.csv$/i.test(name) && !/csv|text/.test(file.type || "")) {
    state.error = "Save the sheet as a CSV file, then upload that. This app does not read Excel workbooks.";
    state.screen = "upload";
    render();
    return;
  }
  state.error = "";
  state.file = file;
  try {
    const parsed = await inspectFile(file);
    if (!parsed.headers.length) throw new Error("No header row was found.");
    state.headers = parsed.headers;
    state.samples = sampleValues(parsed.headers, parsed.rows);
    applySuggestion(suggestMapping(parsed.headers));
    state.screen = "mapping";
    render();
  } catch (error) {
    state.error = error.message || "The file could not be read.";
    state.screen = "upload";
    render();
  }
}

async function inspectFile(file) {
  let slice = Math.min(file.size, 1024 * 1024);
  let parsed = parseCsv(await file.slice(0, slice).text(), { maxDataRows: 8 });
  if ((parsed.headers.length < 2 || !parsed.rows.length) && slice < file.size) {
    slice = Math.min(file.size, 5 * 1024 * 1024);
    parsed = parseCsv(await file.slice(0, slice).text(), { maxDataRows: 8 });
  }
  if (slice < file.size && parsed.rows.length) parsed.rows.pop();
  return parsed;
}

function applySuggestion(suggestion) {
  state.mapping = structuredClone(suggestion.mapping);
  state.confidence = suggestion.confidence;
  state.familiarity = suggestion.familiarity || familiarity(suggestion.confidence);
  state.suggested = {};
  for (const [role, columns] of Object.entries(suggestion.mapping)) {
    state.suggested[role] = (columns || []).join("|");
  }
}

function setColumns(role, columns) {
  const unique = [];
  for (const column of columns) {
    if (column && !unique.includes(column)) unique.push(column);
  }
  for (const item of ROLES) {
    if (item.id === role) continue;
    state.mapping[item.id] = (state.mapping[item.id] || []).filter((column) => !unique.includes(column));
  }
  if (role !== "show") {
    state.mapping.show = (state.mapping.show || []).filter((column) => !unique.includes(column));
  } else {
    for (const item of ROLES) {
      state.mapping[item.id] = (state.mapping[item.id] || []).filter((column) => !unique.includes(column));
    }
  }
  state.mapping[role] = unique;
  const scroll = window.scrollY;
  render();
  window.scrollTo(0, scroll);
}

function startMatch() {
  if (!state.file || !selectedMatchIds().length) return;
  if (worker) worker.terminate();
  state.screen = "progress";
  state.phase = "Starting";
  state.pct = 1;
  state.error = "";
  render();
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (event) => {
    const message = event.data;
    if (message.type === "progress") {
      state.phase = message.phase;
      state.pct = message.pct;
      const phase = document.querySelector("#phase");
      const bar = document.querySelector("#bar");
      if (phase) phase.textContent = message.phase;
      if (bar) bar.style.width = `${message.pct}%`;
      return;
    }
    if (message.type === "error") {
      state.error = message.message;
      state.screen = "mapping";
      render();
      return;
    }
    state.groups = message.groups || [];
    state.records = message.records || {};
    state.warnings = message.warnings || [];
    state.accountCount = message.accountCount || 0;
    state.rowCount = message.rowCount || 0;
    state.page = 0;
    state.selectedId = null;
    state.query = "";
    state.tier = "all";
    state.typeFilter = "all";
    state.screen = "review";
    render();
  };
  worker.onerror = () => {
    state.error = "Matching stopped because the browser could not run it. Use a local server or Vercel, not a file:// address.";
    state.screen = "mapping";
    render();
  };
  worker.postMessage({ file: state.file, mapping: state.mapping });
}

function resetUpload() {
  if (worker) worker.terminate();
  worker = null;
  state.file = null;
  state.headers = [];
  state.screen = "upload";
  state.error = "";
  state.groups = [];
  state.records = {};
  render();
}

function uploadHtml() {
  return `
    <section class="stack">
      <div>
        <h1>Review duplicate accounts</h1>
        <p class="lede">Upload the account CSV. Headers are detected in this browser and the match columns are suggested. You confirm them before anything is compared. The file is not posted to a server.</p>
      </div>
      ${state.error ? `<p class="alert" role="alert">${escapeHtml(state.error)}</p>` : ""}
      <label class="dropzone">
        <input id="file-input" type="file" accept=".csv,text/csv,text/plain">
        <span class="drop-title">Drop a CSV here, or choose a file</span>
        <span class="hint">UTF-8 CSV. Large files stay on this computer.</span>
      </label>
    </section>
  `;
}

function mappingHtml() {
  const matchIds = selectedMatchIds();
  const intro = {
    familiar: "These headers look like an account export. The match columns are filled in. Change anything that is wrong, then find duplicates. Nothing runs until you continue.",
    partial: "Some columns were recognized. Confirm the match columns, and pick any that were left blank. Nothing runs until you continue.",
    unknown: "These headers are not a known account export. Choose which columns to match on. Nothing runs until you continue.",
  }[state.familiarity] || "";
  return `
    <section class="mapping-page">
      <h1>Confirm the columns</h1>
      <p class="lede">${escapeHtml(intro)}</p>
      <p class="hint" style="margin-top:0.4rem">${escapeHtml(state.file.name)} · ${formatBytes(state.file.size)} · ${state.headers.length} columns</p>
      ${state.error ? `<p class="alert" role="alert" style="margin-top:0.8rem">${escapeHtml(state.error)}</p>` : ""}
      <div class="actions" style="margin-top:0.9rem">
        <button class="primary js-find" type="button" ${matchIds.length ? "" : "disabled"}>Find duplicates</button>
      </div>
      <h2 class="section-title">Record identity</h2>
      ${roleBlock("identity")}
      <h2 class="section-title">Match on these columns</h2>
      <p class="hint">Tier 1 is only an exact normalized website, domain, LinkedIn company ID, or ZoomInfo company ID. A similar name is never tier 1 by itself. LinkedIn company URL is exact, and a numeric company ID in that URL counts as the LinkedIn company ID.</p>
      ${roleBlock("match")}
      <h2 class="section-title">Survivor suggestion only</h2>
      <p class="hint">Parent, country, stage, and ARR never create a match. They only suggest which record should survive.</p>
      ${roleBlock("survivor")}
      <details open>
        <summary>Other columns to show</summary>
        <p class="hint">These appear in the comparison. They are not match keys.</p>
        ${showEditor()}
        <div class="unused">${unusedHeaders().map((header) => `<span class="chip">${escapeHtml(header)}</span>`).join("") || `<span class="hint">Every column is mapped.</span>`}</div>
      </details>
      <div class="confirm-bar">
        <p class="summary">${escapeHtml(matchSentence(matchIds))}</p>
        <div class="actions">
          <button class="ghost" id="back-upload" type="button">Different file</button>
          <button class="quiet" id="reset-mapping" type="button">Reset suggestions</button>
          <button class="primary js-find" type="button" ${matchIds.length ? "" : "disabled"}>Find duplicates</button>
        </div>
      </div>
    </section>
  `;
}

function roleBlock(section) {
  return ROLES.filter((role) => role.section === section).map(roleEditor).join("");
}

function roleEditor(role) {
  const selected = state.mapping[role.id] || [];
  const badge = columnBadge(role.id);
  const control = role.multi ? multiControl(role.id, selected) : singleControl(role.id, selected[0] || "");
  return `
    <div class="role">
      <div>
        <h3>${escapeHtml(role.label)}</h3>
        <p class="help">${escapeHtml(role.help)}</p>
      </div>
      <div>
        ${control}
        <span class="badge ${badge.kind}">${escapeHtml(badge.text)}</span>
      </div>
      <p class="sample">${escapeHtml(truncate(sampleFor(selected), 80) || "No sample")}</p>
    </div>
  `;
}

function singleControl(role, selected) {
  const options = availableHeaders(role, selected).map((header) => {
    const picked = header === selected ? "selected" : "";
    return `<option value="${escapeHtml(header)}" ${picked}>${escapeHtml(header)}</option>`;
  });
  return `<select data-single="${escapeHtml(role)}" aria-label="${escapeHtml(role)}"><option value="">Don't use</option>${options.join("")}</select>`;
}

function multiControl(role, selected) {
  const chips = selected.map((column) => `
    <span class="chip">${escapeHtml(column)}
      <button type="button" data-remove="${escapeHtml(role)}\t${escapeHtml(column)}" aria-label="Remove ${escapeHtml(column)}">×</button>
    </span>
  `).join("");
  const options = availableHeaders(role, "").map((header) => `<option value="${escapeHtml(header)}">${escapeHtml(header)}</option>`);
  return `
    <div class="chips">${chips}</div>
    <select data-add="${escapeHtml(role)}" aria-label="Add a ${escapeHtml(role)} column">
      <option value="">Add a column</option>
      ${options.join("")}
    </select>
  `;
}

function showEditor() {
  const selected = state.mapping.show || [];
  return multiControl("show", selected);
}

function availableHeaders(role, current) {
  const used = usedColumns(role);
  return state.headers.filter((header) => header === current || !used.has(header));
}

function usedColumns(exceptRole) {
  const used = new Set();
  for (const role of ROLES) {
    if (role.id === exceptRole) continue;
    for (const column of state.mapping[role.id] || []) used.add(column);
  }
  if (exceptRole !== "show") {
    for (const column of state.mapping.show || []) used.add(column);
  }
  return used;
}

function unusedHeaders() {
  const used = usedColumns("");
  return state.headers.filter((header) => !used.has(header));
}

function columnBadge(role) {
  const current = (state.mapping[role] || []).join("|");
  const suggested = state.suggested[role] || "";
  if (!current) return { text: "Not used", kind: "none" };
  if (current !== suggested) return { text: "Edited", kind: "edited" };
  if (state.confidence[role] === "high") return { text: "Suggested", kind: "high" };
  if (state.confidence[role] === "check") return { text: "Check this", kind: "check" };
  return { text: "Chosen", kind: "edited" };
}

function sampleFor(columns) {
  for (const column of columns) {
    if (state.samples[column]) return state.samples[column];
  }
  return "";
}

function selectedMatchIds() {
  return MATCH_ROLE_IDS.filter((id) => (state.mapping[id] || []).length);
}

function matchSentence(ids) {
  if (!ids.length) return "Choose at least one match column.";
  const labels = ids.map((id) => ROLES.find((role) => role.id === id).label);
  return `Matching on ${joinList(labels)}. Parent, country, stage, and ARR only pick a suggested survivor.`;
}

function progressHtml() {
  return `
    <section class="card stack">
      <h1>Finding duplicates</h1>
      <p id="phase">${escapeHtml(state.phase)}</p>
      <div class="bar" aria-hidden="true"><div id="bar" style="width:${state.pct}%"></div></div>
      <p class="hint">The file stays in this browser. You can leave this tab open.</p>
      <div><button class="quiet" id="cancel-match" type="button">Cancel</button></div>
    </section>
  `;
}

function reviewHtml() {
  const visible = visibleGroups();
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  if (state.page >= pages) state.page = pages - 1;
  const start = state.page * PAGE_SIZE;
  const pageItems = visible.slice(start, start + PAGE_SIZE);
  const selected = state.groups.find((group) => group.id === state.selectedId) || null;
  const dismissedCount = state.groups.filter((group) => state.dismissed.has(signature(group))).length;
  const types = [...new Set(state.groups.flatMap((group) => group.matchTypes))];
  return `
    <section>
      <div class="actions" style="justify-content:space-between">
        <h1>Duplicate groups</h1>
        <div class="actions">
          <button class="quiet" id="change-columns" type="button">Change columns</button>
          <button class="quiet" id="download" type="button">Download CSV</button>
          <button class="ghost" id="another" type="button">New file</button>
        </div>
      </div>
      <p class="stats">${state.groups.length.toLocaleString()} groups from ${state.accountCount.toLocaleString()} accounts (${state.rowCount.toLocaleString()} rows). ${dismissedCount.toLocaleString()} dismissed in this browser.</p>
      <p class="hint">Tier 1 means the same website, domain, LinkedIn company ID, or ZoomInfo company ID. Each row shows that shared value, then the account name and ID. A fuzzy name never makes tier 1.</p>
      ${state.warnings.map((warning) => `<p class="note" style="margin-bottom:0.5rem">${escapeHtml(warning)}</p>`).join("")}
      ${state.mapping.accountId && state.mapping.accountId.length ? "" : `<p class="note" style="margin-bottom:0.5rem">No account ID column is selected, so a dismissal is tied to the row number in this file.</p>`}
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search name or ID" value="${escapeHtml(state.query)}">
        <select id="tier" aria-label="Tier">
          ${["all", "1", "2", "3"].map((tier) => `<option value="${tier}" ${state.tier === tier ? "selected" : ""}>${tier === "all" ? "All tiers" : `Tier ${tier}`}</option>`).join("")}
        </select>
        <select id="type-filter" aria-label="Match type">
          <option value="all" ${state.typeFilter === "all" ? "selected" : ""}>All match types</option>
          ${types.map((type) => `<option value="${escapeHtml(type)}" ${state.typeFilter === type ? "selected" : ""}>${escapeHtml(MATCH_LABELS[type] || type)}</option>`).join("")}
        </select>
        <label class="hint"><input id="show-dismissed" type="checkbox" ${state.showDismissed ? "checked" : ""}> Show dismissed</label>
      </div>
      <div class="split ${selected ? "detail-open" : ""}">
        <div class="group-pane">
          <div class="group-list">
            ${pageItems.map((group) => groupButton(group)).join("") || `<p class="hint" style="padding:1rem">${emptyCopy()}</p>`}
            <div class="pager">
              <button class="quiet" type="button" data-page="${state.page - 1}" ${state.page === 0 ? "disabled" : ""}>Previous</button>
              <span class="hint">${visible.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, visible.length)} of ${visible.length}` : "0 groups"}</span>
              <button class="quiet" type="button" data-page="${state.page + 1}" ${state.page + 1 >= pages ? "disabled" : ""}>Next</button>
            </div>
          </div>
        </div>
        <div>${selected ? detailHtml(selected) : `<div class="detail"><p class="hint">Select a group. J and K move through the list. D dismisses the open group in this browser only.</p></div>`}</div>
      </div>
    </section>
  `;
}

function groupButton(group) {
  const dismissed = state.dismissed.has(signature(group));
  const signals = (group.signals || []).slice(0, 3);
  const reasons = signals.length
    ? signals.map((signal) => `
        <span class="reason">
          <span>${escapeHtml(signal.label)}${signal.score && !signal.exact ? ` · ${Math.round(signal.score)}` : ""}</span>
          ${signal.value ? `<span class="reason-value">${escapeHtml(signal.value)}</span>` : ""}
        </span>
      `).join("")
    : `<span class="reason">${escapeHtml((group.explanations || [])[0] || "Match")}</span>`;
  return `
    <button class="group-row ${dismissed ? "is-dismissed" : ""}" type="button" data-group="${group.id}" aria-current="${group.id === state.selectedId}">
      <span class="group-head">
        <span class="badge tier-${group.tier}">Tier ${group.tier}</span>
        ${reasons}
        ${dismissed ? `<span class="badge">Dismissed</span>` : ""}
      </span>
      ${memberLines(group, 6)}
    </button>
  `;
}

function memberLines(group, limit) {
  const keys = group.memberKeys.slice(0, limit);
  const extra = group.memberKeys.length - keys.length;
  const lines = keys.map((key) => memberLine(key, key === group.survivorKey));
  if (extra > 0) lines.push(`<span class="more-members">+${extra} more accounts</span>`);
  return lines.join("");
}

function memberLine(key, survivor) {
  const record = state.records[key] || {};
  return `<span class="member-line${survivor ? " survivor" : ""}"><span class="member-name">${escapeHtml(record.name || "Account")}</span><span class="member-id">${escapeHtml(record.id || "")}</span></span>`;
}

function detailHtml(group) {
  const members = group.memberKeys.map((key) => state.records[key]).filter(Boolean);
  const survivor = state.records[group.survivorKey];
  const dismissed = state.dismissed.has(signature(group));
  const rows = fieldRows(members);
  const matchedLabels = matchedFieldLabels(group);
  return `
    <article class="detail">
      <div class="actions" style="justify-content:space-between">
        <p class="hint">Group ${group.id}</p>
        <button class="ghost" id="close-detail" type="button">Close</button>
      </div>
      <div class="chips" style="margin:0.2rem 0 0.7rem">
        <span class="badge tier-${group.tier}">Tier ${group.tier}</span>
        ${group.matchTypes.map((type) => `<span class="badge">${escapeHtml(MATCH_LABELS[type] || type)}</span>`).join("")}
      </div>
      ${pairingHtml(group)}
      <p class="hint">Suggested survivor</p>
      <h2>${escapeHtml(survivor?.name || "")}</h2>
      <p class="member-id" style="margin-bottom:0.35rem">${escapeHtml(survivor?.id || "")}</p>
      <ul class="reasons">${group.survivorReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
      ${group.hierarchy ? `<p class="note plain">This looks like a parent and related records. The suggestion does not change Salesforce.</p>` : ""}
      <div class="actions" style="margin:0.8rem 0">
        <button class="primary" id="dismiss" type="button">${dismissed ? "Restore" : "Dismiss"}</button>
      </div>
      <p class="hint" style="margin-bottom:0.7rem">${dismissed ? "Dismissed in this browser only." : "Dismiss hides this group on this browser. It does not update Salesforce."}</p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              ${members.map((member) => `<th class="${member.key === group.survivorKey ? "survivor" : ""}"><span class="col-name">${escapeHtml(member.name)}</span><span class="member-id">${escapeHtml(member.id)}</span></th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr class="${matchedLabels.has(row.label) ? "matched" : ""}">
                <th>${escapeHtml(row.label)}${matchedLabels.has(row.label) ? ` <span class="badge">shared</span>` : ""}</th>
                ${row.values.map((value, index) => `<td class="${row.differs ? "diff" : ""} ${members[index].key === group.survivorKey ? "survivor" : ""}">${escapeHtml(value)}</td>`).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </article>
  `;
}

function pairingHtml(group) {
  const signals = group.signals || [];
  const blocks = signals.map((signal) => {
    const keys = signal.memberKeys && signal.memberKeys.length ? signal.memberKeys : group.memberKeys;
    const who = keys.slice(0, 6).map((key) => {
      const record = state.records[key] || {};
      return `${record.name || "Account"} (${record.id || ""})`;
    });
    const extra = keys.length > 6 ? ` +${keys.length - 6}` : "";
    const pairs = (signal.exact ? [] : (signal.namePairs || [])).slice(0, 4).map((pair) => {
      const left = state.records[pair.leftKey] || {};
      const right = state.records[pair.rightKey] || {};
      return `<li>${escapeHtml(left.name || "Account")} (${escapeHtml(left.id || "")}) paired with ${escapeHtml(right.name || "Account")} (${escapeHtml(right.id || "")}), score ${pair.score}.</li>`;
    }).join("");
    const via = signal.sources && signal.sources.length ? `Columns: ${signal.sources.join(", ")}` : "";
    return `
      <li>
        <span class="pair-label">${escapeHtml(signal.label)}${signal.score && !signal.exact ? ` · ${Math.round(signal.score)}` : ""}</span>
        ${signal.value ? `<span class="reason-value">${escapeHtml(signal.value)}</span>` : ""}
        <span class="hint">${escapeHtml(who.join(" · "))}${escapeHtml(extra)}</span>
        ${via ? `<span class="hint">${escapeHtml(via)}</span>` : ""}
        ${pairs ? `<ul class="pair-accounts">${pairs}</ul>` : ""}
      </li>
    `;
  }).join("");
  const fallback = blocks ? "" : (group.explanations || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const tierNote = group.tier === 1
    ? "Tier 1 because these accounts share an exact normalized website, domain, LinkedIn company ID, or ZoomInfo company ID."
    : "This is not tier 1. Tier 1 requires the same normalized website, domain, LinkedIn company ID, or ZoomInfo company ID. A shared or similar name does not qualify.";
  return `
    <div class="pair-box">
      <h3>Why these rows were paired</h3>
      <ul class="pair-list">${blocks || fallback}</ul>
      <p class="hint">${tierNote}</p>
    </div>
  `;
}

function matchedFieldLabels(group) {
  const labels = new Set();
  const byType = {
    name: "Account name",
    website: "Website",
    domain: "Domain",
    linkedin_url: "LinkedIn company URL",
    linkedin_id: "LinkedIn company ID",
    zoominfo: "ZoomInfo company ID",
  };
  for (const signal of group.signals || []) {
    for (const type of signal.types || [signal.type]) {
      if (byType[type]) labels.add(byType[type]);
    }
  }
  return labels;
}

function fieldRows(members) {
  const labels = [];
  const seen = new Set();
  for (const member of members) {
    for (const field of member.fields || []) {
      if (!seen.has(field.label)) {
        seen.add(field.label);
        labels.push(field.label);
      }
    }
  }
  return labels.map((label) => {
    const values = members.map((member) => member.fields.find((field) => field.label === label)?.value || "");
    return { label, values, differs: new Set(values.filter(Boolean)).size > 1 };
  });
}

function visibleGroups() {
  const query = state.query.trim().toLowerCase();
  return state.groups.filter((group) => {
    const dismissed = state.dismissed.has(signature(group));
    if (dismissed && !state.showDismissed) return false;
    if (state.tier !== "all" && String(group.tier) !== state.tier) return false;
    if (state.typeFilter !== "all" && !group.matchTypes.includes(state.typeFilter)) return false;
    if (!query) return true;
    const haystack = [
      ...group.memberKeys.map((key) => {
        const record = state.records[key];
        return `${record?.name || ""} ${record?.id || ""}`;
      }),
      ...(group.signals || []).map((signal) => `${signal.label || ""} ${signal.value || ""}`),
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function emptyCopy() {
  if (!state.groups.length) return "No duplicate groups for the columns you confirmed.";
  if (!state.showDismissed && state.groups.every((group) => state.dismissed.has(signature(group)))) {
    return "Every group is dismissed in this browser. Show dismissed groups to restore one.";
  }
  return "No groups match this filter.";
}

function moveSelection(visible, index) {
  if (!visible.length) return;
  const next = visible[Math.max(0, Math.min(index, visible.length - 1))];
  state.selectedId = next.id;
  state.page = Math.floor(visible.indexOf(next) / PAGE_SIZE);
  render();
}

function toggleDismiss(group) {
  const key = signature(group);
  const store = readStore();
  if (state.dismissed.has(key)) {
    state.dismissed.delete(key);
    delete store[key];
  } else {
    state.dismissed.add(key);
    store[key] = new Date().toISOString();
    if (!state.showDismissed && state.selectedId === group.id) state.selectedId = null;
  }
  writeStore(store);
  render();
}

function signature(group) {
  return [...group.memberKeys].sort().join("|");
}

function downloadCsv() {
  const header = ["group_id", "score", "tier", "match_types", "survivor_id", "survivor_name", "reasons", "member_ids", "member_names", "explanations", "dismissed"];
  const lines = [header.join(",")];
  for (const group of state.groups) {
    const members = group.memberKeys.map((key) => state.records[key]).filter(Boolean);
    const survivor = state.records[group.survivorKey];
    lines.push([
      group.id,
      group.score,
      group.tier,
      group.matchTypes.join("|"),
      survivor?.id || "",
      survivor?.name || "",
      group.survivorReasons.join(" "),
      members.map((member) => member.id).join("|"),
      members.map((member) => member.name).join("|"),
      group.explanations.join(" "),
      state.dismissed.has(signature(group)) ? "yes" : "no",
    ].map(csvCell).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "duplicate-review.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function readStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* Dismissal still applies until the tab closes. */
  }
}

function joinList(items) {
  if (items.length <= 1) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function truncate(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
