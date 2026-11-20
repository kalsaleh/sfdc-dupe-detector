import { hasWord, headerForms } from "./normalize.js";

/** Roles the reviewer can map. Display roles are suggested, then shown as extra columns. */
export const ROLES = [
  { id: "accountId", section: "identity", multi: false, label: "Salesforce account ID", help: "Identifies the row. Not a match key." },
  { id: "name", section: "match", multi: false, label: "Account name", help: "Fuzzy match on the company name." },
  { id: "website", section: "match", multi: true, label: "Website", help: "Exact match on the website host." },
  { id: "domain", section: "match", multi: true, label: "Domain", help: "Exact match. Several domain columns can be used together. Lists in one cell are split." },
  { id: "linkedinUrl", section: "match", multi: true, label: "LinkedIn company URL", help: "Exact match on the company slug or ID in the URL." },
  { id: "linkedinId", section: "match", multi: true, label: "LinkedIn company ID", help: "Exact match. A URL that contains the same ID also matches." },
  { id: "zoominfoId", section: "match", multi: true, label: "ZoomInfo company ID", help: "Exact match on the ZoomInfo company ID." },
  { id: "parentId", section: "survivor", multi: false, label: "Parent account ID", help: "Used only to suggest which record should survive." },
  { id: "parentName", section: "survivor", multi: false, label: "Parent account name", help: "Shown in the review. Not a match key." },
  { id: "ultimateParentId", section: "survivor", multi: false, label: "Ultimate parent ID", help: "Used only to suggest which record should survive." },
  { id: "ultimateParentName", section: "survivor", multi: false, label: "Ultimate parent name", help: "Shown in the review. Not a match key." },
  { id: "country", section: "survivor", multi: false, label: "Country", help: "Used only to break ties. It never decides that two rows match." },
  { id: "stage", section: "survivor", multi: false, label: "Account stage", help: "Used only to suggest which record should survive." },
  { id: "arr", section: "survivor", multi: false, label: "ARR", help: "Used only to suggest which record should survive." },
  { id: "ownerName", section: "display", multi: false, label: "Owner name", help: "Shown in the review. Not a match key." },
  { id: "accountType", section: "display", multi: false, label: "Account type", help: "Shown in the review. Not a match key." },
  { id: "accountSubtype", section: "display", multi: false, label: "Account sub-type", help: "Shown in the review. Not a match key." },
  { id: "industry", section: "display", multi: false, label: "Industry", help: "Shown in the review. Not a match key." },
  { id: "duplicateStatus", section: "display", multi: false, label: "Duplicate status", help: "Shown in the review. Not a match key." },
  { id: "billingCity", section: "display", multi: false, label: "Billing city", help: "Shown in the review. Not a match key." },
  { id: "billingState", section: "display", multi: false, label: "Billing state", help: "Shown in the review. Not a match key." },
  { id: "employees", section: "display", multi: false, label: "Employee count", help: "Shown in the review. Not a match key." },
  { id: "employeesLinkedIn", section: "display", multi: false, label: "Employee count (LinkedIn)", help: "Shown in the review. Not a match key." },
  { id: "created", section: "display", multi: false, label: "Created date", help: "Shown in the review. Not a match key." },
  { id: "modified", section: "display", multi: false, label: "Last modified date", help: "Shown in the review. Not a match key." },
];

export const MATCH_ROLE_IDS = ["name", "website", "domain", "linkedinUrl", "linkedinId", "zoominfoId"];

const THRESHOLD = 78;
const HIGH = 90;

const ALIASES = {
  accountId: [["salesforce account id", 100], ["sfdc account id", 100], ["crm account id", 96], ["account id", 96], ["accountid", 92]],
  name: [["account name", 100], ["company name", 100], ["account", 86], ["company", 86], ["name", 84]],
  website: [["company website", 100], ["website url", 98], ["website", 100], ["web site", 96], ["url", 82]],
  domain: [["domain aliases harmonic", 98], ["domain aliases", 98], ["harmonic domains", 94], ["domain text field", 96], ["website domain", 96], ["email domain", 94], ["company domain", 96], ["domain", 94]],
  linkedinUrl: [["linkedin company url", 100], ["company linkedin url", 100], ["linkedin url", 98], ["linkedin company page", 96], ["linkedin page", 92]],
  linkedinId: [["linkedin company id parsed from url", 100], ["linkedin company id", 100], ["linkedin id", 96], ["li company id", 94]],
  zoominfoId: [["zoominfo company id", 100], ["zoom info company id", 100], ["zoominfo id", 96], ["zi company id", 94], ["zi id", 90]],
  parentId: [["parent account salesforce id", 100], ["parent account id", 98], ["parent salesforce id", 96], ["parent id", 92]],
  ultimateParentId: [["ultimate parent salesforce id", 100], ["ultimate parent account id", 100], ["ultimate parent id", 98]],
  parentName: [["parent account name", 100], ["parent name", 94]],
  ultimateParentName: [["ultimate parent account name", 100], ["ultimate parent name", 98]],
  country: [["billing country", 100], ["account country", 96], ["country fy27", 86], ["country clearbit", 86], ["shipping country", 84], ["billing country code", 80], ["country code", 78], ["country", 88]],
  stage: [["account stage", 100], ["stage", 90]],
  arr: [["annual recurring revenue", 100], ["current arr", 96], ["arr", 100]],
  ownerName: [["owner name", 100], ["account owner", 96], ["owner", 84]],
  accountType: [["account type", 100], ["type", 80]],
  accountSubtype: [["account sub type", 100], ["account subtype", 100], ["sub type", 88]],
  industry: [["industry", 100]],
  duplicateStatus: [["duplicate status", 100], ["dupe status", 96]],
  billingCity: [["billing city", 100], ["account city", 92], ["city", 82]],
  billingState: [["billing state", 100], ["account state", 90], ["state", 80]],
  employees: [["employee count", 100], ["number of employees", 96], ["employees", 96]],
  employeesLinkedIn: [["employee count linkedin", 100], ["linkedin employee count", 100], ["employees linkedin", 96]],
  created: [["created date", 100], ["created", 86]],
  modified: [["last modified date", 100], ["last modified", 98], ["modified date", 94]],
};

export function suggestMapping(headers) {
  const pairs = [];
  headers.forEach((header, headerIndex) => {
    for (const role of ROLES) {
      const score = scoreHeader(header, role.id);
      if (score >= THRESHOLD) pairs.push({ header, headerIndex, role, score });
    }
  });
  pairs.sort((a, b) => b.score - a.score || a.headerIndex - b.headerIndex || a.role.id.localeCompare(b.role.id));

  const mapping = {};
  const confidence = {};
  for (const role of ROLES) {
    mapping[role.id] = [];
    confidence[role.id] = "none";
  }

  const taken = new Set();
  for (const pair of pairs) {
    if (taken.has(pair.header)) continue;
    const bucket = mapping[pair.role.id];
    if (!pair.role.multi && bucket.length) continue;
    bucket.push(pair.header);
    taken.add(pair.header);
    const level = pair.score >= HIGH ? "high" : "check";
    if (confidence[pair.role.id] !== "high") confidence[pair.role.id] = level;
  }

  mapping.show = [];
  for (const role of ROLES) {
    if (role.section !== "display") continue;
    for (const column of mapping[role.id]) {
      if (!mapping.show.includes(column)) mapping.show.push(column);
    }
  }

  return { mapping, confidence, familiarity: familiarity(confidence) };
}

export function familiarity(confidence) {
  const high = MATCH_ROLE_IDS.filter((id) => confidence[id] === "high");
  const any = MATCH_ROLE_IDS.filter((id) => confidence[id] && confidence[id] !== "none");
  if (high.length >= 4) return "familiar";
  if (!any.length) return "unknown";
  return "partial";
}

export function scoreHeader(header, roleId) {
  const forms = headerForms(header);
  if (rejected(roleId, forms.stripped, forms.full)) return 0;
  let best = 0;
  for (const [alias, weight] of ALIASES[roleId] || []) {
    best = Math.max(best, aliasScore(forms.stripped, alias, weight), aliasScore(forms.full, alias, weight));
  }
  return best;
}

function rejected(roleId, stripped, full) {
  const word = (form, token) => hasWord(form, token);
  if (roleId === "accountId" && ["parent", "ultimate", "owner", "user", "contact"].some((token) => word(stripped, token))) return true;
  if (roleId === "name" && ["parent", "ultimate", "owner", "user", "type", "stage", "id", "sub"].some((token) => word(stripped, token))) return true;
  if ((roleId === "linkedinUrl" || roleId === "linkedinId") && (word(stripped, "employee") || word(full, "employee") || word(stripped, "headcount"))) return true;
  if (roleId === "linkedinUrl" && !word(stripped, "url") && !word(stripped, "page")) return true;
  if (roleId === "linkedinId" && !word(stripped, "id")) return true;
  if ((roleId === "linkedinUrl" || roleId === "linkedinId") && !word(stripped, "linkedin") && !word(stripped, "li") && !word(full, "linkedin")) return true;
  if (roleId === "website" && ["linkedin", "domain", "facebook", "twitter"].some((token) => word(stripped, token))) return true;
  if (roleId === "domain" && ["country", "linkedin"].some((token) => word(stripped, token))) return true;
  if (roleId === "zoominfoId" && !word(stripped, "zoominfo") && !word(stripped, "zoom") && !word(stripped, "zi") && !word(full, "zoominfo") && !word(full, "zi")) return true;
  if (roleId === "parentId" && (word(stripped, "ultimate") || !word(stripped, "parent") || !word(stripped, "id"))) return true;
  if (roleId === "ultimateParentId" && (!word(stripped, "ultimate") || !word(stripped, "id"))) return true;
  if (roleId === "parentName" && (word(stripped, "ultimate") || !word(stripped, "parent") || word(stripped, "id"))) return true;
  if (roleId === "ultimateParentName" && (!word(stripped, "ultimate") || word(stripped, "id"))) return true;
  if (roleId === "ownerName" && word(stripped, "id")) return true;
  if (roleId === "employees" && (word(full, "linkedin") || word(stripped, "linkedin"))) return true;
  if (roleId === "employeesLinkedIn" && !word(full, "linkedin") && !word(stripped, "linkedin")) return true;
  if (roleId === "created" && (word(stripped, "modified") || word(stripped, "last"))) return true;
  if (roleId === "stage" && word(stripped, "opportunity")) return true;
  if (roleId === "country" && ["city", "state", "postal", "owner"].some((token) => word(stripped, token))) return true;
  if (roleId === "billingState" && word(stripped, "country")) return true;
  return false;
}

function aliasScore(form, alias, weight) {
  if (!form || !alias) return 0;
  if (form === alias) return weight;
  if (alias.length <= 4) {
    return form.split(" ").includes(alias) ? Math.max(0, weight - 8) : 0;
  }
  let from = 0;
  while (from <= form.length - alias.length) {
    const index = form.indexOf(alias, from);
    if (index === -1) break;
    const before = index === 0 || form[index - 1] === " ";
    const afterAt = index + alias.length;
    const after = afterAt === form.length || form[afterAt] === " ";
    if (before && after) {
      const extra = `${form.slice(0, index)} ${form.slice(afterAt)}`.trim().split(/\s+/).filter(Boolean);
      const penalty = Math.min(24, extra.length * 8);
      return Math.max(0, weight - penalty);
    }
    from = index + 1;
  }
  return 0;
}
