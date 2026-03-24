"""Match Type 4: Fuzzy name matching with blocking and pairwise grouping.

Does NOT use union-find to avoid transitive chaining (A~B, B~C => A~C
even when A and C are unrelated). Instead, groups are built from direct
pairwise matches only.
"""

from __future__ import annotations

from collections import defaultdict
from rapidfuzz import fuzz
from backend.db import get_conn
from backend.config import FUZZY_MIN_SCORE, MAX_BLOCK_SIZE

MAX_CLUSTER_SIZE = 10
MIN_NAME_LENGTH = 3  # Skip very short names that match everything


def find_name_duplicates() -> list[dict]:
    """Find duplicate accounts via fuzzy name matching.

    Uses blocking to avoid O(n^2), then builds groups from direct pairwise
    matches without transitive chaining.

    Returns list of dicts: {key, account_ids, score, match_type, explanation, pairwise}
    """
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, name, name_normalized FROM accounts WHERE name_normalized IS NOT NULL"
        ).fetchall()
    finally:
        conn.close()

    # Build blocks
    blocks = defaultdict(list)
    for row in rows:
        norm = row["name_normalized"]
        if not norm or len(norm) < MIN_NAME_LENGTH:
            continue
        acct = {"id": row["id"], "name": row["name"], "norm": norm}
        # Block key 1: first 3 chars
        if len(norm) >= 3:
            blocks[norm[:3]].append(acct)
        # Block key 2: first word (if different from first 3 chars)
        first_word = norm.split()[0] if norm.split() else ""
        if first_word and len(first_word) >= 3 and first_word != norm[:3]:
            blocks[first_word].append(acct)

    # Find all pairwise matches
    pairwise = {}  # (id_a, id_b) -> score
    neighbors = defaultdict(set)  # id -> set of matching ids

    for block_key, members in blocks.items():
        if len(members) > MAX_BLOCK_SIZE:
            continue
        if len(members) < 2:
            continue

        seen_ids = set()
        unique_members = []
        for m in members:
            if m["id"] not in seen_ids:
                seen_ids.add(m["id"])
                unique_members.append(m)

        for i in range(len(unique_members)):
            for j in range(i + 1, len(unique_members)):
                a, b = unique_members[i], unique_members[j]
                pair_key = tuple(sorted([a["id"], b["id"]]))
                if pair_key in pairwise:
                    continue

                score = _compute_score(a["norm"], b["norm"])
                if score >= FUZZY_MIN_SCORE:
                    pairwise[pair_key] = score
                    neighbors[a["id"]].add(b["id"])
                    neighbors[b["id"]].add(a["id"])

    # Build groups from connected components, but cap size to prevent
    # transitive mega-chains. Use BFS with size limit.
    id_to_name = {row["id"]: row["name"] for row in rows}
    visited = set()
    groups = []

    for start_id in neighbors:
        if start_id in visited:
            continue

        # BFS with size cap
        cluster = []
        queue = [start_id]
        while queue and len(cluster) < MAX_CLUSTER_SIZE:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)
            cluster.append(current)
            for nb in neighbors[current]:
                if nb not in visited:
                    queue.append(nb)

        # Mark remaining as visited so they don't form another group
        # (better to skip than create inaccurate groups)
        while queue:
            leftover = queue.pop(0)
            visited.add(leftover)

        if len(cluster) < 2:
            continue

        # Collect pairwise scores for this cluster
        best_score = 0
        pair_details = []
        for i in range(len(cluster)):
            for j in range(i + 1, len(cluster)):
                pk = tuple(sorted([cluster[i], cluster[j]]))
                if pk in pairwise:
                    best_score = max(best_score, pairwise[pk])
                    pair_details.append({
                        "account_id_a": pk[0],
                        "account_id_b": pk[1],
                        "score": pairwise[pk],
                    })

        # Require at least one strong pair in the cluster
        if best_score < FUZZY_MIN_SCORE:
            continue

        names = [id_to_name.get(mid, "?") for mid in cluster]
        groups.append({
            "key": f"name:{cluster[0]}",
            "account_ids": cluster,
            "score": best_score / 100.0,
            "match_type": "name",
            "explanation": f"Fuzzy name match (score {best_score:.0f}): {', '.join(names[:3])}{'...' if len(names) > 3 else ''}",
            "pairwise": pair_details,
        })

    return groups


def _compute_score(a: str, b: str) -> float:
    """Compute fuzzy match score between two normalized names.

    Improvements:
    - Short names (< 6 chars) require near-exact match to avoid false positives
    - Length disparity penalty: "apple" vs "apple international logistics" penalized
    - Token overlap bonus: shared tokens boost confidence
    """
    ratio = fuzz.ratio(a, b)
    sort_ratio = fuzz.token_sort_ratio(a, b) * 0.95
    # Weight token_set_ratio lower — it's too generous on short names
    # e.g., "api" is a "set subset" of "api pumps" -> 100
    set_ratio = fuzz.token_set_ratio(a, b) * 0.85

    score = max(ratio, sort_ratio, set_ratio)

    # Penalize short name matches — too many false positives
    min_len = min(len(a), len(b))
    max_len = max(len(a), len(b))
    if min_len < 6:
        # Short names need much higher scores to qualify
        score = min(score, ratio)  # fall back to strict ratio only
        if score < 95:
            return 0  # reject unless near-exact

    # Length disparity penalty: if one name is much longer than the other,
    # reduce confidence (catches "Acme" vs "Acme International Logistics Group")
    if max_len > 0:
        len_ratio = min_len / max_len
        if len_ratio < 0.5 and score < 95:
            score *= (0.7 + 0.3 * len_ratio)  # scale down proportionally

    # Token overlap check: boost score if shared tokens are high proportion
    tokens_a = set(a.split())
    tokens_b = set(b.split())
    if tokens_a and tokens_b:
        overlap = len(tokens_a & tokens_b)
        total = len(tokens_a | tokens_b)
        if total > 0:
            jaccard = overlap / total
            if jaccard >= 0.8:
                score = min(100, score + 2)  # small boost for high token overlap

    return score
