import { cleanText, formatArr, linkedinToken, normalizeHost, normalizeId, normalizeName, parseArr, splitList } from "./normalize.js";

const STRUCTURED = [
  "accountId",
  "name",
  "website",
  "domain",
  "linkedinUrl",
  "linkedinId",
  "zoominfoId",
  "parentId",
  "parentName",
  "ultimateParentId",
  "ultimateParentName",
  "country",
  "stage",
  "arr",
  "ownerName",
  "created",
];

export function buildRecords(headers, rows, mapping) {
  const indexOf = new Map(headers.map((header, index) => [header, index]));
  const columns = (role) =>
    (mapping[role] || []).map((header) => indexOf.get(header)).filter((index) => Number.isInteger(index));
  const labels = (role) => (mapping[role] || []).filter((header) => indexOf.has(header));

  const idCols = columns("accountId");
  const nameCols = columns("name");
  const websiteCols = columns("website");
  const domainCols = columns("domain");
  const linkedinUrlCols = columns("linkedinUrl");
  const linkedinIdCols = columns("linkedinId");
  const zoomCols = columns("zoominfoId");
  const parentIdCols = columns("parentId");
  const parentNameCols = columns("parentName");
  const ultimateIdCols = columns("ultimateParentId");
  const ultimateNameCols = columns("ultimateParentName");
  const countryCols = columns("country");
  const stageCols = columns("stage");
  const arrCols = columns("arr");
  const ownerCols = columns("ownerName");
  const createdCols = columns("created");

  const used = new Set();
  for (const role of STRUCTURED) {
    for (const header of mapping[role] || []) used.add(header);
  }
  const show = (mapping.show || [])
    .filter((header) => !used.has(header) && indexOf.has(header))
    .map((header) => ({ header, index: indexOf.get(header) }));

  const websiteLabels = labels("website");
  const domainLabels = labels("domain");
  const linkedinUrlLabels = labels("linkedinUrl");
  const linkedinIdLabels = labels("linkedinId");
  const zoomLabels = labels("zoominfoId");

  const records = [];
  rows.forEach((row, index) => {
    if (row.every((cell) => !cleanText(cell))) return;
    const record = {
      index,
      rowNumber: index + 2,
      id: firstValue(row, idCols),
      name: firstValue(row, nameCols),
      websites: collectHosts(row, websiteCols, websiteLabels, "website"),
      domains: collectHosts(row, domainCols, domainLabels, "domain"),
      linkedinUrls: collectLinkedin(row, linkedinUrlCols, linkedinUrlLabels),
      linkedinIds: collectLinkedin(row, linkedinIdCols, linkedinIdLabels),
      zoominfoIds: collectIds(row, zoomCols, zoomLabels),
      parentId: firstValue(row, parentIdCols),
      parentName: firstValue(row, parentNameCols),
      ultimateParentId: firstValue(row, ultimateIdCols),
      ultimateParentName: firstValue(row, ultimateNameCols),
      country: firstValue(row, countryCols),
      stage: firstValue(row, stageCols),
      arrRaw: firstValue(row, arrCols),
      owner: firstValue(row, ownerCols),
      created: firstValue(row, createdCols),
      extra: [],
    };
    record.synthetic = !record.id;
    record.nameNorm = normalizeName(record.name);
    record.arr = parseArr(record.arrRaw);
    for (const column of show) {
      const value = cleanText(row[column.index]);
      if (value) record.extra.push({ label: column.header, value });
    }
    records.push(record);
  });

  const seen = new Map();
  for (const record of records) {
    const base = record.id || `row-${record.rowNumber}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    record.key = count === 0 ? base : `${base}#${record.rowNumber}`;
  }
  return records;
}

export function toPublic(record) {
  const fields = [];
  const push = (label, value) => {
    const text = cleanText(value);
    if (text) fields.push({ label, value: text });
  };
  if (record.synthetic) push("Row", String(record.rowNumber));
  else push("Salesforce account ID", record.id);
  push("Account name", record.name);
  push("Website", orderedHosts(record.websites));
  push("Domain", orderedHosts(record.domains));
  push("LinkedIn company URL", record.linkedinUrls.map((item) => item.raw).join(", "));
  push("LinkedIn company ID", record.linkedinIds.map((item) => item.raw).join(", "));
  push("ZoomInfo company ID", record.zoominfoIds.map((item) => item.raw).join(", "));
  push("Parent account ID", record.parentId);
  push("Parent account name", record.parentName);
  push("Ultimate parent ID", record.ultimateParentId);
  push("Ultimate parent name", record.ultimateParentName);
  push("Country", record.country);
  push("Owner", record.owner);
  push("Account stage", record.stage);
  if (record.arr) push("ARR", formatArr(record.arr));
  else push("ARR", record.arrRaw);
  push("Created date", record.created);
  for (const extra of record.extra) push(extra.label, extra.value);

  return {
    key: record.key,
    rowNumber: record.rowNumber,
    id: record.id || `Row ${record.rowNumber}`,
    name: record.name || "(no name)",
    fields,
    summary: {
      name: record.name || "(no name)",
      website: primaryHost(record.websites),
      domain: primaryHost(record.domains),
      linkedin: record.linkedinIds.map((item) => item.token).filter(Boolean)[0]
        || record.linkedinUrls.map((item) => item.raw).filter(Boolean)[0]
        || "",
      zoominfo: record.zoominfoIds.map((item) => item.raw).filter(Boolean)[0] || "",
      country: record.country || "",
      owner: record.owner || "",
      stage: record.stage || "",
      arr: record.arr ? formatArr(record.arr) : (record.arrRaw || ""),
      created: record.created || "",
    },
  };
}

function primaryHost(items) {
  const primary = (items || []).find((item) => item.primary);
  return primary ? primary.host : "";
}

function orderedHosts(items) {
  return [...items].sort((a, b) => Number(b.primary) - Number(a.primary)).map((item) => item.raw).join(", ");
}

function firstValue(row, columns) {
  for (const index of columns) {
    const value = cleanText(row[index]);
    if (value) return value;
  }
  return "";
}

function isAliasColumn(label) {
  const text = String(label || "").toLowerCase();
  return /alias|harmonic|\blist\b|text field/.test(text);
}

function collectHosts(row, columns, labels, kind) {
  const found = [];
  const seen = new Set();
  let primaryAssigned = false;
  columns.forEach((index, position) => {
    const source = labels[position] || (kind === "website" ? "Website" : "Domain");
    const aliasColumn = kind === "domain" && isAliasColumn(source);
    let firstValid = true;
    for (const part of splitList(row[index])) {
      const host = normalizeHost(part);
      if (!host || seen.has(host)) continue;
      const primary = !aliasColumn && !primaryAssigned && firstValid;
      if (primary) primaryAssigned = true;
      firstValid = false;
      seen.add(host);
      found.push({ raw: part, host, source, primary });
    }
  });
  return found;
}

function collectLinkedin(row, columns, labels) {
  const found = [];
  const seen = new Set();
  columns.forEach((index, position) => {
    for (const part of splitList(row[index])) {
      const token = linkedinToken(part);
      if (!token || seen.has(token)) continue;
      seen.add(token);
      found.push({ raw: part, token, source: labels[position] || "LinkedIn" });
    }
  });
  return found;
}

function collectIds(row, columns, labels) {
  const found = [];
  const seen = new Set();
  columns.forEach((index, position) => {
    for (const part of splitList(row[index])) {
      const token = normalizeId(part);
      if (!token || seen.has(token)) continue;
      seen.add(token);
      found.push({ raw: part, token, source: labels[position] || "ZoomInfo company ID" });
    }
  });
  return found;
}
