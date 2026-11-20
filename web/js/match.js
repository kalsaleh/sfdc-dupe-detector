import { computeScore } from "./fuzzy.js";
import { formatArr, sfKey } from "./normalize.js";

const MAX_KEY_GROUP = 10;
const MAX_COMPONENT = 15;
const MAX_BLOCK = 500;
const MAX_CLUSTER = 10;
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
const TYPE_ORDER = ["zoominfo", "website", "domain", "linkedin_id", "linkedin_url", "name"];
const TIER1 = new Set(["zoominfo", "website", "domain", "linkedin_id"]);
const TYPE_LABEL = {
  zoominfo: "ZoomInfo company ID",
  website: "website",
  domain: "domain",
  linkedin_id: "LinkedIn company ID",
  linkedin_url: "LinkedIn company URL",
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
  const parent = records.map((_, index) => index);
  const size = records.map(() => 1);
  const evidence = records.map(() => []);
  let skippedLarge = 0;
  let skippedPortal = 0;
  let skippedWide = 0;

  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]];
      cursor = parent[cursor];
    }
    return cursor;
  };

  const attach = (indexes, item) => {
    const roots = [];
    const seen = new Set();
    let total = 0;
    for (const index of indexes) {
      const root = find(index);
      if (seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
      total += size[root];
    }
    if (total < 2) return;
    if (total > MAX_COMPONENT) {
      skippedWide += 1;
      return;
    }
    const root = roots[0];
    for (let i = 1; i < roots.length; i++) {
      parent[roots[i]] = root;
      size[root] += size[roots[i]];
      if (evidence[roots[i]].length) {
        evidence[root].push(...evidence[roots[i]]);
        evidence[roots[i]] = [];
      }
    }
    evidence[root].push(item);
  };

  const buckets = new Map();
  const bucketFor = (id, seed) => {
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = seed;
      buckets.set(id, bucket);
    }
    return bucket;
  };

  const addHost = (host, index, kind, source) => {
    const bucket = bucketFor(`host\u0000${host}`, {
      space: "host",
      value: host,
      indexes: [],
      kinds: new Set(),
      sources: new Set(),
      aliasOnly: true,
    });
    bucket.indexes.push(index);
    bucket.kinds.add(kind);
    bucket.sources.add(source);
    if (kind !== "domain" || !/alias/i.test(source)) bucket.aliasOnly = false;
  };

  const addToken = (space, token, index, kind, source) => {
    const bucket = bucketFor(`${space}\u0000${token}`, {
      space,
      value: token,
      indexes: [],
      kinds: new Set(),
      sources: new Set(),
    });
    bucket.indexes.push(index);
    bucket.kinds.add(kind);
    bucket.sources.add(source);
  };

  records.forEach((record, index) => {
    for (const item of record.websites) addHost(item.host, index, "website", item.source);
    for (const item of record.domains) addHost(item.host, index, "domain", item.source);
    for (const item of record.linkedinUrls) {
      addToken("li", item.token, index, "linkedin_url", item.source);
      if (/^\d+$/.test(item.token)) addToken("li", item.token, index, "linkedin_id", item.source);
    }
    for (const item of record.linkedinIds) addToken("li", item.token, index, "linkedin_id", item.source);
    for (const item of record.zoominfoIds) addToken("zi", item.token, index, "zoominfo", item.source);
  });

  if (onProgress) onProgress({ phase: "Comparing websites, domains, and IDs", pct: 40 });

  for (const bucket of buckets.values()) {
    const indexes = [...new Set(bucket.indexes)];
    if (indexes.length < 2) continue;
    if (indexes.length > MAX_KEY_GROUP) {
      skippedLarge += 1;
      continue;
    }
    if (bucket.space === "host" && indexes.length >= 3 && allNamesDiffer(indexes, records)) {
      skippedPortal += 1;
      continue;
    }
    attach(indexes, {
      types: [...bucket.kinds],
      value: bucket.value,
      sources: [...bucket.sources],
      aliasOnly: Boolean(bucket.aliasOnly),
      count: indexes.length,
      indexes,
    });
  }

  const components = new Map();
  records.forEach((_, index) => {
    const root = find(index);
    if (size[root] < 2 || !evidence[root].length) return;
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(index);
  });

  const covered = new Set();
  const groups = [];
  for (const indexes of components.values()) {
    indexes.forEach((index) => covered.add(index));
    groups.push(buildExactGroup(indexes, evidence[find(indexes[0])], records));
  }

  const uncovered = [];
  records.forEach((_, index) => {
    if (!covered.has(index)) uncovered.push(index);
  });

  const nameResult = fuzzyNameGroups(records, uncovered, (fraction) => {
    if (onProgress) {
      onProgress({
        phase: "Comparing account names",
        pct: 45 + Math.round(fraction * 45),
      });
    }
  });
  groups.push(...nameResult.groups);
  if (nameResult.skippedBlocks) {
    warnings.push(
      `Name matching skipped ${nameResult.skippedBlocks} very common name prefixes because each contained more than ${MAX_BLOCK} accounts.`,
    );
  }
  if (skippedLarge) {
    warnings.push(`${skippedLarge} shared values were ignored because more than ${MAX_KEY_GROUP} accounts used them.`);
  }
  if (skippedPortal) {
    warnings.push(`${skippedPortal} website or domain values were ignored because every account using them has a different name.`);
  }
  if (skippedWide) {
    warnings.push(`${skippedWide} connections were left out because they would have grouped more than ${MAX_COMPONENT} accounts.`);
  }

  groups.sort((a, b) => a.tier - b.tier || b.score - a.score || b.memberKeys.length - a.memberKeys.length || a.memberKeys[0].localeCompare(b.memberKeys[0]));
  groups.forEach((group, index) => {
    group.id = index + 1;
  });

  const recordByKey = new Map(records.map((record) => [record.key, record]));
  return { groups, warnings, recordByKey };
}

function buildExactGroup(indexes, items, records) {
  const members = indexes.map((index) => records[index]);
  const nameMatch = bestNameScore(members);
  const types = new Set();
  for (const item of items) for (const type of item.types) types.add(type);
  if (nameMatch.score >= FUZZY_MIN) types.add("name");
  const score = scoreTypes([...types], items, nameMatch.score, members.length);
  const suggestion = suggestSurvivor(members);
  const signals = items.map((item) => exactSignal(item, records));
  if (nameMatch.score >= FUZZY_MIN) signals.push(nameSignal(members, nameMatch));
  signals.sort((a, b) => signalRank(a) - signalRank(b) || a.label.localeCompare(b.label));
  const matchTypes = TYPE_ORDER.filter((type) => types.has(type));
  return {
    memberKeys: suggestion.ordered.map((record) => record.key),
    matchTypes,
    score,
    tier: tierFor(matchTypes, nameMatch.score),
    signals,
    explanations: signals.map((signal) => signal.text),
    survivorKey: suggestion.survivor.key,
    survivorReasons: suggestion.reasons,
    countriesDiffer: suggestion.countriesDiffer,
    countries: suggestion.countries,
    hierarchy: suggestion.hierarchy,
  };
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

function exactSignal(item, records) {
  const types = TYPE_ORDER.filter((type) => item.types.includes(type) && type !== "name");
  const shown = types.filter((type) => TIER1.has(type));
  const labelTypes = shown.length ? shown : types;
  const label = `Same ${labelTypes.map((type) => TYPE_LABEL[type] || type).join(" and ")}`;
  const sources = item.sources || [];
  const via = sources.length ? ` (${sources.join(", ")})` : "";
  const memberKeys = [...new Set((item.indexes || []).map((index) => records[index] && records[index].key).filter(Boolean))];
  return {
    type: labelTypes[0] || types[0] || "domain",
    types,
    label,
    value: item.value,
    score: null,
    sources,
    memberKeys,
    text: `${label}: ${item.value}${via}.`,
  };
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
  if (types.includes("linkedin_url")) return 1;
  return 2;
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

function allNamesDiffer(indexes, records) {
  const names = [];
  for (const index of indexes) {
    const name = records[index].nameNorm;
    if (!name) return false;
    names.push(name);
  }
  return new Set(names).size === names.length;
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
  const neighbors = new Map();
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
        if (score >= FUZZY_MIN) {
          pairwise.set(pairKey, score);
          addNeighbor(neighbors, a, b);
          addNeighbor(neighbors, b, a);
        }
      }
    }
  });
  if (onFraction) onFraction(1);

  const groups = [];
  const visited = new Set();
  for (const start of neighbors.keys()) {
    if (visited.has(start)) continue;
    const cluster = [];
    const queue = [start];
    while (queue.length && cluster.length < MAX_CLUSTER) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      cluster.push(current);
      for (const next of neighbors.get(current) || []) {
        if (!visited.has(next)) queue.push(next);
      }
    }
    while (queue.length) visited.add(queue.shift());
    if (cluster.length < 2) continue;
    let best = 0;
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const a = cluster[i];
        const b = cluster[j];
        const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (pairwise.has(pairKey)) best = Math.max(best, pairwise.get(pairKey));
      }
    }
    if (best < FUZZY_MIN) continue;
    const members = cluster.map((index) => records[index]);
    const suggestion = suggestSurvivor(members);
    const pairs = [];
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const a = cluster[i];
        const b = cluster[j];
        const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (!pairwise.has(pairKey)) continue;
        pairs.push({
          leftKey: records[a].key,
          rightKey: records[b].key,
          score: Math.round(pairwise.get(pairKey)),
        });
      }
    }
    pairs.sort((a, b) => b.score - a.score || a.leftKey.localeCompare(b.leftKey));
    let left = null;
    let right = null;
    if (pairs.length) {
      left = members.find((record) => record.key === pairs[0].leftKey) || null;
      right = members.find((record) => record.key === pairs[0].rightKey) || null;
    }
    const signal = nameSignal(members, { score: best, left, right, pairs: pairs.slice(0, 8) });
    const score = scoreTypes(["name"], [], best, members.length);
    groups.push({
      memberKeys: suggestion.ordered.map((record) => record.key),
      matchTypes: ["name"],
      score,
      tier: tierFor(["name"], best),
      signals: [signal],
      explanations: [signal.text],
      survivorKey: suggestion.survivor.key,
      survivorReasons: suggestion.reasons,
      countriesDiffer: suggestion.countriesDiffer,
      countries: suggestion.countries,
      hierarchy: suggestion.hierarchy,
    });
  }
  return { groups, skippedBlocks };
}

function addNeighbor(neighbors, from, to) {
  const list = neighbors.get(from);
  if (list) list.add(to);
  else neighbors.set(from, new Set([to]));
}

function tierFor(types, nameScore = 0) {
  if (types.some((type) => TIER1.has(type))) return 1;
  if (types.includes("linkedin_url")) return 2;
  if (types.includes("name") && nameScore >= 95) return 2;
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
  if (flags.ultimate) reasons.push("It is the ultimate parent of another account in this group.");
  else if (flags.direct) reasons.push("It is the parent of another account in this group.");
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
