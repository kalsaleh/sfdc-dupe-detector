import { computeScore } from "./fuzzy.js";
import { formatArr, sfKey } from "./normalize.js";

const MAX_KEY_GROUP = 10;
const MAX_BLOCK = 500;
const MAX_CLUSTER = 10;
const MAX_DISTINCT_NAMES = 3;
const FUZZY_MIN = 85;
const MIN_NAME = 3;

const BASE = {
  zoominfo: 96,
  website: 95,
  domain: 95,
  linkedin_id: 92,
  linkedin_url: 90,
};
const BONUS = {
  zoominfo: 8,
  website: 8,
  domain: 7,
  linkedin_id: 7,
  linkedin_url: 7,
  name: 3,
};
const TYPE_ORDER = ["website", "domain", "linkedin_id", "zoominfo", "linkedin_url", "alias", "name"];
const TIER1 = new Set(["website", "domain", "linkedin_id"]);
const TYPE_LABEL = {
  zoominfo: "ZoomInfo company ID",
  website: "primary website",
  domain: "primary domain",
  linkedin_id: "LinkedIn company ID",
  linkedin_url: "LinkedIn company URL",
  alias: "domain alias",
  name: "account name",
};

const STAGE_RANK = {
  customer: 0,
  churned: 1,
  "sales qualified": 2,
  "sales accepted": 3,
  "marketing qualified": 4,
  recover: 5,
  "ae target account": 6,
  prospect: 7,
  "icp account": 8,
  new: 9,
};

const PARENT_SUFFIXES = new Set([
  "uk", "us", "usa", "india", "japan", "china", "korea", "brazil",
  "canada", "australia", "germany", "france", "spain", "italy",
  "mexico", "singapore", "ireland", "israel", "netherlands",
  "emea", "apac", "latam", "anz", "mena", "americas", "europe",
  "asia", "africa", "na", "global", "international", "intl", "holdings",
]);

export function findDuplicateGroups(records, onProgress) {
  const warnings = [];
  let skippedLarge = 0;
  let skippedMixed = 0;
  const buckets = new Map();

  const addKeyed = (id, index, type, value, source) => {
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { type, value, indexes: [], sources: new Set(), kinds: new Set() };
      buckets.set(id, bucket);
    }
    bucket.indexes.push(index);
    bucket.sources.add(source);
    bucket.kinds.add(type);
  };

  records.forEach((record, index) => {
    for (const item of record.websites) {
      if (!item.primary) continue;
      addKeyed(`web\u0000${item.host}`, index, "website", item.host, item.source);
    }
    for (const item of record.domains) {
      const type = item.primary ? "domain" : "alias";
      addKeyed(`${type}\u0000${item.host}`, index, type, item.host, item.source);
    }
    for (const item of record.linkedinIds) {
      addKeyed(`li\u0000${item.token}`, index, "linkedin_id", item.token, item.source);
    }
    for (const item of record.linkedinUrls) {
      if (/^\d+$/.test(item.token)) {
        addKeyed(`li\u0000${item.token}`, index, "linkedin_id", item.token, item.source);
        buckets.get(`li\u0000${item.token}`).kinds.add("linkedin_url");
      } else {
        addKeyed(`url\u0000${item.token}`, index, "linkedin_url", item.token, item.source);
      }
    }
    for (const item of record.zoominfoIds) {
      addKeyed(`zi\u0000${item.token}`, index, "zoominfo", item.token, item.source);
    }
  });

  if (onProgress) onProgress({ phase: "Comparing websites, domains, and IDs", pct: 40 });

  const pending = [];
  for (const bucket of buckets.values()) {
    const indexes = [...new Set(bucket.indexes)];
    if (indexes.length < 2) continue;
    const strong = bucket.type === "website" || bucket.type === "domain" || bucket.type === "linkedin_id";
    if (indexes.length > MAX_KEY_GROUP) {
      skippedLarge += 1;
      emitSameNameChunks(indexes, bucket, records, pending);
      skippedMixed += 1;
      continue;
    }
    const facts = nameFacts(indexes.map((index) => records[index]));
    const fullClique = (strong && facts.distinct <= MAX_DISTINCT_NAMES)
      || (bucket.type === "zoominfo" && facts.same)
      || (bucket.type === "linkedin_url" && facts.distinct <= MAX_DISTINCT_NAMES)
      || (bucket.type === "alias" && facts.same);
    if (fullClique) {
      pending.push(buildKeyGroup(indexes, bucket, records));
      continue;
    }
    if (strong || bucket.type === "zoominfo" || bucket.type === "linkedin_url") {
      emitSameNameChunks(indexes, bucket, records, pending);
      if (bucket.type === "zoominfo" && indexes.length === 2) pending.push(buildKeyGroup(indexes, bucket, records));
      else if (indexes.length > 2) skippedMixed += 1;
      continue;
    }
    if (bucket.type === "alias" && indexes.length === 2) {
      pending.push(buildKeyGroup(indexes, bucket, records));
      continue;
    }
    if (indexes.length > 2) skippedMixed += 1;
  }

  const exactGroups = mergeGroups(pending);
  const tier1Keys = new Set();
  for (const group of exactGroups) {
    if (group.tier !== 1) continue;
    for (const key of group.memberKeys) tier1Keys.add(key);
  }
  const uncovered = [];
  records.forEach((record, index) => {
    if (!tier1Keys.has(record.key)) uncovered.push(index);
  });

  const nameResult = fuzzyNameGroups(records, uncovered, (fraction) => {
    if (onProgress) {
      onProgress({
        phase: "Comparing account names",
        pct: 45 + Math.round(fraction * 45),
      });
    }
  });
  const groups = mergeGroups([...exactGroups, ...nameResult.groups]);
  if (nameResult.skippedBlocks) {
    warnings.push(
      `Name matching skipped ${nameResult.skippedBlocks} very common name prefixes because each contained more than ${MAX_BLOCK} accounts.`,
    );
  }
  if (skippedLarge) {
    warnings.push(`${skippedLarge} shared values were split because more than ${MAX_KEY_GROUP} accounts used them.`);
  }
  if (skippedMixed) {
    warnings.push(`${skippedMixed} shared ZoomInfo IDs, websites, domains, or aliases were not kept as one tier 1 group because the account names differ.`);
  }

  groups.sort((a, b) => a.tier - b.tier || b.score - a.score || b.memberKeys.length - a.memberKeys.length || a.memberKeys[0].localeCompare(b.memberKeys[0]));
  groups.forEach((group, index) => {
    group.id = index + 1;
  });

  const recordByKey = new Map(records.map((record) => [record.key, record]));
  return { groups, warnings, recordByKey };
}

function emitSameNameChunks(indexes, bucket, records, pending) {
  const byName = new Map();
  for (const index of indexes) {
    const name = records[index].nameNorm;
    if (!name) continue;
    const list = byName.get(name);
    if (list) list.push(index);
    else byName.set(name, [index]);
  }
  for (const slice of byName.values()) {
    if (slice.length < 2) continue;
    for (let start = 0; start < slice.length; start += MAX_CLUSTER) {
      const chunk = slice.slice(start, start + MAX_CLUSTER);
      if (chunk.length >= 2) pending.push(buildKeyGroup(chunk, bucket, records));
    }
  }
}

function buildKeyGroup(indexes, bucket, records) {
  const members = indexes.map((index) => records[index]);
  const kinds = [...bucket.kinds];
  const label = labelFor(bucket.type, kinds);
  const sources = [...bucket.sources];
  const via = sources.length ? ` (${sources.join(", ")})` : "";
  const types = kinds.includes("linkedin_id") && kinds.includes("linkedin_url")
    ? ["linkedin_id", "linkedin_url"]
    : [bucket.type];
  const signals = [{
    type: types[0],
    types,
    label,
    value: bucket.value,
    score: null,
    sources,
    memberKeys: members.map((record) => record.key),
    text: `${label}: ${bucket.value}${via}.`,
  }];
  const facts = nameFacts(members);
  const nameMatch = bestNameScore(members);
  if (facts.same || (members.length === 2 && nameMatch.score >= FUZZY_MIN)) {
    signals.push(nameSignal(members, nameMatch));
  }
  return finalize(members, signals);
}

function labelFor(type, kinds) {
  if (type === "website") return "Same primary website";
  if (type === "domain") return "Same primary domain";
  if (type === "alias") return "Same domain alias";
  if (type === "linkedin_id" || kinds.includes("linkedin_id")) return "Same LinkedIn company ID";
  if (type === "linkedin_url") return "Same LinkedIn company URL";
  if (type === "zoominfo") return "Same ZoomInfo company ID";
  return `Same ${TYPE_LABEL[type] || type}`;
}

function finalize(members, signals) {
  const facts = nameFacts(members);
  const suggestion = suggestSurvivor(members);
  const group = {
    memberKeys: suggestion.ordered.map((record) => record.key),
    signals,
    nameDistinct: facts.distinct,
    nameSame: facts.same,
    score: 0,
    survivorKey: suggestion.survivor.key,
    survivorReasons: suggestion.reasons,
    countriesDiffer: suggestion.countriesDiffer,
    countries: suggestion.countries,
    hierarchy: suggestion.hierarchy,
  };
  refresh(group);
  const nameScore = group.signals.find((signal) => signal.type === "name")?.score || 0;
  group.score = scoreTypes(group.matchTypes, [], nameScore, members.length);
  return group;
}

function refresh(group) {
  const types = [];
  for (const signal of group.signals) {
    for (const type of signal.types || [signal.type]) {
      if (!types.includes(type)) types.push(type);
    }
  }
  group.matchTypes = TYPE_ORDER.filter((type) => types.includes(type));
  const nameScore = group.signals.find((signal) => signal.type === "name")?.score || 0;
  group.tier = tierFor(group.matchTypes, nameScore, { distinct: group.nameDistinct, same: group.nameSame });
  group.signals.sort((a, b) => signalRank(a) - signalRank(b) || a.label.localeCompare(b.label));
  group.explanations = group.signals.map((signal) => signal.text);
}

function mergeGroups(list) {
  const bySignature = new Map();
  for (const group of list) {
    const signature = [...group.memberKeys].sort().join("\0");
    const existing = bySignature.get(signature);
    if (!existing) {
      bySignature.set(signature, group);
      continue;
    }
    for (const signal of group.signals) {
      const duplicate = existing.signals.some((item) => item.type === signal.type && item.value === signal.value && item.label === signal.label);
      if (!duplicate) existing.signals.push(signal);
    }
    existing.score = Math.max(existing.score, group.score);
    refresh(existing);
  }
  return [...bySignature.values()];
}

function nameFacts(members) {
  const norms = members.map((record) => record.nameNorm).filter(Boolean);
  const distinct = new Set(norms).size;
  return { distinct, same: norms.length === members.length && distinct === 1 };
}

function scoreTypes(types, items, nameScore, groupSize) {
  const baseFor = (type) => {
    if (type === "name") return nameScore;
    if (type === "domain") {
      const domainItems = items.filter((item) => item.types.includes("domain"));
      const hasWebsite = types.includes("website");
      if (!hasWebsite && domainItems.length && domainItems.every((item) => item.aliasOnly && !item.types.includes("website"))) {
        return 90;
      }
    }
    return BASE[type] ?? 70;
  };
  let primary = types[0];
  let best = -1;
  for (const type of TYPE_ORDER) {
    if (!types.includes(type)) continue;
    const base = baseFor(type);
    if (base > best) {
      best = base;
      primary = type;
    }
  }
  let bonus = 0;
  for (const type of types) {
    if (type !== primary) bonus += BONUS[type] ?? 0;
  }
  let score = Math.min(100, best + bonus);
  if (types.length === 1 && types[0] === "name" && groupSize > 5) {
    score = Math.max(70, score - (groupSize - 5) * 3);
  }
  return Math.round(score);
}

function nameSignal(members, nameMatch) {
  const norms = members.map((record) => record.nameNorm).filter(Boolean);
  const exact = norms.length === members.length && new Set(norms).size === 1;
  const score = Math.round(nameMatch.score);
  const left = nameMatch.left;
  const right = nameMatch.right;
  const value = exact ? norms[0] : `${left ? left.nameNorm : ""} ≈ ${right ? right.nameNorm : ""}`.trim();
  const label = exact ? "Same normalized account name" : "Similar account name";
  const namePairs = nameMatch.pairs || [];
  const text = exact
    ? `${label}: ${value}.`
    : `${label} (${score}): ${value}.`;
  return {
    type: "name",
    types: ["name"],
    label,
    value,
    score,
    exact,
    sources: [],
    memberKeys: members.map((record) => record.key),
    namePairs,
    text,
  };
}

function signalRank(signal) {
  const types = signal.types || [signal.type];
  if (types.some((type) => TIER1.has(type))) return 0;
  if (types.includes("zoominfo")) return 1;
  if (types.includes("linkedin_url")) return 2;
  if (types.includes("alias")) return 3;
  return 4;
}

function bestNameScore(members) {
  let best = 0;
  let left = null;
  let right = null;
  const pairs = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i].nameNorm;
      const b = members[j].nameNorm;
      if (!a || !b) continue;
      const score = computeScore(a, b);
      if (score >= FUZZY_MIN) {
        pairs.push({ leftKey: members[i].key, rightKey: members[j].key, score: Math.round(score) });
      }
      if (score > best) {
        best = score;
        left = members[i];
        right = members[j];
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.leftKey.localeCompare(b.leftKey));
  return { score: best, left, right, pairs: pairs.slice(0, 8) };
}

function fuzzyNameGroups(records, uncovered, onFraction) {
  const blocks = new Map();
  const addBlock = (key, index) => {
    const list = blocks.get(key);
    if (list) list.push(index);
    else blocks.set(key, [index]);
  };
  for (const index of uncovered) {
    const norm = records[index].nameNorm;
    if (!norm || norm.length < MIN_NAME) continue;
    addBlock(norm.slice(0, 3), index);
    const first = norm.split(" ")[0];
    if (first && first.length >= MIN_NAME && first !== norm.slice(0, 3)) addBlock(`w:${first}`, index);
  }

  const pairwise = new Map();
  let skippedBlocks = 0;
  const entries = [...blocks.entries()];
  entries.forEach(([, members], blockIndex) => {
    if (onFraction && blockIndex % 20 === 0) onFraction(entries.length ? blockIndex / entries.length : 1);
    if (members.length > MAX_BLOCK) {
      skippedBlocks += 1;
      return;
    }
    if (members.length < 2) return;
    const unique = [...new Set(members)];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const a = unique[i];
        const b = unique[j];
        const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (pairwise.has(pairKey)) continue;
        const score = computeScore(records[a].nameNorm, records[b].nameNorm);
        if (score >= FUZZY_MIN) pairwise.set(pairKey, score);
      }
    }
  });
  if (onFraction) onFraction(1);

  const groups = [];
  const exact = new Map();
  for (const index of uncovered) {
    const norm = records[index].nameNorm;
    if (!norm || norm.length < MIN_NAME) continue;
    const list = exact.get(norm);
    if (list) list.push(index);
    else exact.set(norm, [index]);
  }
  const inExact = new Set();
  for (const indexes of exact.values()) {
    const unique = [...new Set(indexes)];
    if (unique.length < 2) continue;
    for (let start = 0; start < unique.length; start += MAX_CLUSTER) {
      const slice = unique.slice(start, start + MAX_CLUSTER);
      if (slice.length < 2) continue;
      slice.forEach((index) => inExact.add(index));
      const members = slice.map((index) => records[index]);
      groups.push(finalize(members, [nameSignal(members, bestNameScore(members))]));
    }
  }
  for (const [pairKey, score] of pairwise) {
    const [a, b] = pairKey.split("|").map(Number);
    if (inExact.has(a) && inExact.has(b) && records[a].nameNorm === records[b].nameNorm) continue;
    const members = [records[a], records[b]];
    const signal = nameSignal(members, {
      score,
      left: records[a],
      right: records[b],
      pairs: [{ leftKey: records[a].key, rightKey: records[b].key, score: Math.round(score) }],
    });
    groups.push(finalize(members, [signal]));
  }
  return { groups, skippedBlocks };
}

function tierFor(types, nameScore = 0, facts = { distinct: 0, same: false }) {
  const distinct = facts.distinct ?? 0;
  const strong = types.some((type) => TIER1.has(type));
  if (distinct > MAX_DISTINCT_NAMES) return strong || types.includes("zoominfo") ? 2 : 3;
  if (strong) return 1;
  if (types.includes("zoominfo") && facts.same) return 1;
  if (types.includes("zoominfo") || types.includes("linkedin_url")) return 2;
  if (types.includes("name") && nameScore >= 95) return 2;
  if (types.includes("alias") && facts.same) return 2;
  return 3;
}

function suggestSurvivor(members) {
  const byId = new Map();
  for (const record of members) {
    const key = sfKey(record.id);
    if (key && !byId.has(key)) byId.set(key, record);
  }
  for (const record of members) {
    record.flags = {
      ultimate: false,
      direct: false,
      child: false,
      nameParent: looksLikeNameParent(record, members),
    };
  }
  for (const record of members) {
    const parentRecord = byId.get(sfKey(record.parentId));
    const ultimateRecord = byId.get(sfKey(record.ultimateParentId));
    if (parentRecord && parentRecord !== record) {
      parentRecord.flags.direct = true;
      record.flags.child = true;
    }
    if (ultimateRecord && ultimateRecord !== record) {
      ultimateRecord.flags.ultimate = true;
      record.flags.child = true;
    }
  }

  const ordered = [...members].sort((a, b) => compareTuple(rankTuple(a, members), rankTuple(b, members)) || a.index - b.index);
  const survivor = ordered[0];
  const flags = survivor.flags;
  const reasons = [];
  if (flags.ultimate) reasons.push("It is the ultimate parent of another account in this group. The parent link is not a match.");
  else if (flags.direct) reasons.push("It is the parent of another account in this group. The parent link is not a match.");
  else if (flags.nameParent) reasons.push("Its name looks like the parent of a regional or holding account in this group.");

  const stage = stageRank(survivor);
  const stageIsBest = ordered.every((record) => stage <= stageRank(record));
  const stageIsBetter = ordered.some((record) => stage < stageRank(record));
  if (survivor.stage && stageIsBest && stageIsBetter && stage < 50) {
    reasons.push(`Account stage ${survivor.stage} ranks above the other records.`);
  }
  const arr = survivor.arr || 0;
  const arrIsBest = ordered.every((record) => arr >= (record.arr || 0));
  const arrIsBetter = ordered.some((record) => arr > (record.arr || 0));
  if (arr > 0 && arrIsBest && arrIsBetter) reasons.push(`ARR ${formatArr(arr)} is the highest in the group.`);

  const countries = [];
  const seenCountries = new Set();
  for (const record of ordered) {
    const country = (record.country || "").trim();
    const key = country.toLowerCase();
    if (!country || seenCountries.has(key)) continue;
    seenCountries.add(key);
    countries.push(country);
  }
  if (countries.length > 1) {
    reasons.push(`Countries differ (${countries.join(", ")}). Country is not a match. It only breaks ties.`);
  } else if ((survivor.country || "").trim() && ordered.some((record) => !(record.country || "").trim())) {
    reasons.push("It is the record that has a country filled in.");
  }
  if (!reasons.length) reasons.push("Parent, stage, ARR, and country did not separate the records, so this one is listed first.");

  return {
    ordered,
    survivor,
    reasons,
    countries,
    countriesDiffer: countries.length > 1,
    hierarchy: ordered.some((record) => record.flags.ultimate || record.flags.direct || record.flags.nameParent),
  };
}

function rankTuple(record, members) {
  const flags = record.flags;
  let parentRank = 2;
  if (flags.ultimate) parentRank = 0;
  else if (flags.direct || flags.nameParent) parentRank = 1;
  else if (flags.child) parentRank = 3;
  return [parentRank, stageRank(record), -(record.arr || 0), countryRank(record, members)];
}

function compareTuple(left, right) {
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function stageRank(record) {
  const stage = (record.stage || "").trim().toLowerCase();
  if (!stage) return 50;
  return STAGE_RANK[stage] ?? 40;
}

function countryRank(record, members) {
  const mine = (record.country || "").trim().toLowerCase();
  if (!mine) return 2;
  const counts = new Map();
  for (const member of members) {
    const country = (member.country || "").trim().toLowerCase();
    if (!country) continue;
    counts.set(country, (counts.get(country) || 0) + 1);
  }
  let modal = "";
  let best = 0;
  for (const [country, count] of counts) {
    if (count > best) {
      best = count;
      modal = country;
    }
  }
  return mine === modal ? 0 : 1;
}

function looksLikeNameParent(record, members) {
  const mine = record.nameNorm;
  if (!mine) return false;
  for (const other of members) {
    if (other === record) continue;
    const name = other.nameNorm;
    if (!name || name === mine || !name.startsWith(mine) || name.length <= mine.length + 2) continue;
    const extra = name.slice(mine.length).trim();
    if (!extra || /^\d+$/.test(extra)) continue;
    const tokens = extra.split(" ");
    if (tokens.some((token) => PARENT_SUFFIXES.has(token))) return true;
  }
  return false;
}
