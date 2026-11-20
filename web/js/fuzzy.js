/** Indel similarity, close to the ratio used by the original name matcher. */

let left = new Uint16Array(128);
let right = new Uint16Array(128);

function indelDistance(a, b) {
  const lengthB = b.length;
  if (lengthB + 1 > left.length) {
    const size = lengthB + 1;
    left = new Uint16Array(size);
    right = new Uint16Array(size);
  }
  let previous = left;
  let current = right;
  for (let j = 0; j <= lengthB; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    const code = a.charCodeAt(i - 1);
    for (let j = 1; j <= lengthB; j++) {
      const cost = code === b.charCodeAt(j - 1) ? 0 : 2;
      const deleted = previous[j] + 1;
      const inserted = current[j - 1] + 1;
      const swapped = previous[j - 1] + cost;
      let best = deleted < inserted ? deleted : inserted;
      if (swapped < best) best = swapped;
      current[j] = best;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[lengthB];
}

export function indelSimilarity(a, b) {
  if (a === b) return 100;
  const lengthA = a.length;
  const lengthB = b.length;
  if (!lengthA || !lengthB) return 0;
  const cappedA = lengthA > 200 ? a.slice(0, 200) : a;
  const cappedB = lengthB > 200 ? b.slice(0, 200) : b;
  const sum = cappedA.length + cappedB.length;
  const distance = indelDistance(cappedA, cappedB);
  return 100 * (1 - distance / sum);
}

function tokenSortRatio(a, b) {
  const sort = (value) => value.split(" ").filter(Boolean).sort().join(" ");
  return indelSimilarity(sort(a), sort(b));
}

function tokenSetRatio(a, b) {
  const leftTokens = new Set(a.split(" ").filter(Boolean));
  const rightTokens = new Set(b.split(" ").filter(Boolean));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).sort();
  const onlyLeft = [...leftTokens].filter((token) => !rightTokens.has(token)).sort();
  const onlyRight = [...rightTokens].filter((token) => !leftTokens.has(token)).sort();
  const intersection = shared.join(" ");
  const leftForm = [intersection, onlyLeft.join(" ")].filter(Boolean).join(" ");
  const rightForm = [intersection, onlyRight.join(" ")].filter(Boolean).join(" ");
  return Math.max(
    indelSimilarity(intersection, leftForm),
    indelSimilarity(intersection, rightForm),
    indelSimilarity(leftForm, rightForm),
  );
}

export function computeScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const minLength = Math.min(a.length, b.length);
  const maxLength = Math.max(a.length, b.length);
  const upper = 100 * (1 - Math.abs(a.length - b.length) / (a.length + b.length));
  if (minLength < 6 && upper < 95) return 0;

  const raw = indelSimilarity(a, b);
  const sorted = tokenSortRatio(a, b) * 0.95;
  const setRatio = tokenSetRatio(a, b) * 0.85;
  let score = Math.max(raw, sorted, setRatio);

  if (minLength < 6) {
    score = Math.min(score, raw);
    if (score < 95) return 0;
  }

  if (maxLength > 0) {
    const lengthRatio = minLength / maxLength;
    if (lengthRatio < 0.5 && score < 95) score *= 0.7 + 0.3 * lengthRatio;
  }

  const tokensA = new Set(a.split(" ").filter(Boolean));
  const tokensB = new Set(b.split(" ").filter(Boolean));
  if (tokensA.size && tokensB.size) {
    let overlap = 0;
    for (const token of tokensA) if (tokensB.has(token)) overlap += 1;
    const union = new Set([...tokensA, ...tokensB]).size;
    if (union > 0 && overlap / union >= 0.8) score = Math.min(100, score + 2);
  }
  return score;
}
