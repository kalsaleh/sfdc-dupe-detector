const EMPTY = new Set([
  "",
  "na",
  "n/a",
  "none",
  "null",
  "undefined",
  "-",
  "--",
  "—",
  "#n/a",
  "n\\a",
  "not available",
  "unknown",
  "not found",
]);

const SUFFIX =
  /,?\s*\b(inc\.?|incorporated|llc|ltd\.?|limited|corp\.?|corporation|gmbh|co\.?|company|plc|ag|sa|sas|s\.?a\.?|s\.?r\.?l\.?|pty\.?|pvt\.?|n\.?v\.?|b\.?v\.?|oy|ab|as|a\/s)\s*\.?\s*$/i;

const BLOCKLIST = new Set([
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "tiktok.com",
  "reddit.com",
  "pinterest.com",
  "linktr.ee",
  "bit.ly",
  "t.co",
  "goo.gl",
  "ow.ly",
  "buff.ly",
  "crunchbase.com",
  "opencorporates.com",
  "indeed.com",
  "github.com",
  "gitlab.com",
  "medium.com",
  "wordpress.com",
  "blogspot.com",
  "wix.com",
  "squarespace.com",
  "weebly.com",
  "google.com",
  "apple.com",
  "microsoft.com",
  "bbb.org",
  "nba.com",
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "aol.com",
  "example.com",
  "example.org",
  "test.com",
  "localhost",
]);

const ID_JUNK = new Set([
  "0",
  "00",
  "000",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "-",
  "--",
  "unknown",
  "not found",
  "#n/a",
]);

export function cleanText(value) {
  if (value == null) return "";
  const text = String(value).trim();
  if (EMPTY.has(text.toLowerCase())) return "";
  return text;
}

export function headerForms(raw) {
  const lower = String(raw || "").toLowerCase().replace(/\u00a0/g, " ");
  const stripped = lower.replace(/\([^)]*\)/g, " ");
  const norm = (value) => value.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return { full: norm(lower), stripped: norm(stripped) };
}

export function hasWord(form, word) {
  return form.split(" ").includes(word);
}

export function splitList(value) {
  const text = cleanText(value);
  if (!text) return [];
  const parts = text.split(/[,;|\n]+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 1 && /\s/.test(parts[0]) && parts[0].includes(".")) {
    const tokens = parts[0].split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && tokens.every((token) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(token))) {
      return tokens;
    }
  }
  return parts;
}

export function isBlockedHost(host) {
  if (!host || !host.includes(".")) return true;
  if (BLOCKLIST.has(host)) return true;
  for (const blocked of BLOCKLIST) {
    if (host.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

export function normalizeHost(value) {
  let raw = cleanText(value).toLowerCase();
  if (!raw) return null;
  const email = raw.match(/@([a-z0-9.-]+\.[a-z]{2,})/);
  if (email) raw = email[1];
  raw = raw.replace(/^mailto:/, "");
  if (/\s/.test(raw)) return null;
  if (!/^https?:\/\//.test(raw)) raw = `https://${raw}`;
  let host = "";
  try {
    host = new URL(raw).hostname || "";
  } catch {
    host = "";
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (isBlockedHost(host)) return null;
  return host;
}

export function normalizeName(name) {
  const text = cleanText(name);
  if (!text) return null;
  let normalized = text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  normalized = normalized.replace(/\s*\([^)]*\)\s*$/g, "");
  let previous;
  do {
    previous = normalized;
    normalized = normalized.replace(SUFFIX, "").trim();
  } while (normalized !== previous);
  normalized = normalized.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return normalized || null;
}

export function linkedinToken(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const match = lower.match(/linkedin\.com\/(?:company|school)\/([^/?#]+)/);
  let token = match ? decodeURIComponent(match[1]).replace(/\/+$/, "") : lower.trim();
  if (/^\d+\.0$/.test(token)) token = token.slice(0, -2);
  if (!match && !/^\d+$/.test(token) && /\s/.test(token)) return null;
  token = token.replace(/^"+|"+$/g, "").replace(/\/+$/, "").trim();
  const junk = new Set([
    "",
    "company",
    "school",
    "unavailable",
    "null",
    "none",
    "n/a",
    "na",
    "0",
    "profile",
    "admin",
    "feed",
    "login",
    "404",
  ]);
  if (junk.has(token) || token.length < 2) return null;
  return token;
}

export function normalizeId(value) {
  let raw = cleanText(value);
  if (!raw) return null;
  if (/^\d+\.0$/.test(raw)) raw = raw.slice(0, -2);
  if (ID_JUNK.has(raw.toLowerCase()) || raw.length < 2) return null;
  return raw;
}

export function sfKey(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (/^[a-zA-Z0-9]{15}$/.test(text) || /^[a-zA-Z0-9]{18}$/.test(text)) return text.slice(0, 15);
  return text;
}

export function parseArr(value) {
  const text = cleanText(value);
  if (!text) return 0;
  let numeric = text.replace(/[$,\s]/g, "");
  if (/^\(.*\)$/.test(numeric)) numeric = `-${numeric.slice(1, -1)}`;
  numeric = numeric.replace(/[^0-9.-]/g, "");
  const number = Number(numeric);
  return Number.isFinite(number) ? number : 0;
}

export function formatArr(number) {
  if (!number) return "";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number);
}
