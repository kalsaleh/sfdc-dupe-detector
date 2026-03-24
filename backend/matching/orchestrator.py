"""Run all matchers, annotate with cross-signals, score & tier."""

from __future__ import annotations

import json
from collections import defaultdict
from functools import partial

from backend.config import (
    CONFIGURED_MATCH_TYPES,
    DETERMINISTIC_MATCH_TYPES,
    PARENT_CHILD_SUFFIXES,
    TIER1_MIN,
    TIER2_MIN,
    is_service_or_admin_owner,
    match_type_base_score,
    match_type_bonus,
)
from backend.db import get_conn
from backend.matching.key_matcher import find_duplicates_for_match_type
from backend.matching.name_matcher import find_name_duplicates
from backend.matching.normalizers import normalize_name
from backend.matching.website_matcher import find_website_duplicates

STAGE_PRIORITY = {
    "Customer": 0,
    "Churned": 1,
    "Sales Qualified": 2,
    "Sales Accepted": 3,
    "Marketing Qualified": 4,
    "Recover": 5,
    "AE Target Account": 6,
    "Prospect": 7,
    "ICP Account": 8,
    "New": 9,
}

MAX_GROUP_SIZE = 15


def run_all_matchers(match_types: list[str] | None = None):
    """Run specified matchers (or all), annotate cross-signals, score & persist."""
    matchers = _build_matchers()
    types_to_run = match_types or list(matchers.keys())
    raw_groups = []

    for match_type in types_to_run:
        matcher = matchers.get(match_type)
        if matcher:
            raw_groups.extend(matcher())

    pair_signals = defaultdict(set)
    for group in raw_groups:
        ids = group["account_ids"]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                pair = frozenset([ids[i], ids[j]])
                pair_signals[pair].add(group["match_type"])

    deterministic = [
        group for group in raw_groups if group["match_type"] in DETERMINISTIC_MATCH_TYPES
    ]
    name_only = [group for group in raw_groups if group["match_type"] == "name"]

    covered_accounts = set()
    seen_keys = set()
    final_groups = []

    for group in deterministic:
        ids_key = frozenset(group["account_ids"])
        if ids_key in seen_keys:
            for final_group in final_groups:
                if frozenset(final_group["account_ids"]) == ids_key:
                    final_group["match_types"].add(group["match_type"])
                    final_group["explanations"].append(group["explanation"])
                    break
            continue

        seen_keys.add(ids_key)
        group_match_types = _pair_signals_for_ids(group["account_ids"], pair_signals)
        final_groups.append(
            {
                "account_ids": group["account_ids"],
                "match_types": group_match_types if group_match_types else {group["match_type"]},
                "explanations": [group["explanation"]],
                "pairwise": group.get("pairwise", []),
                "primary_match_type": group["match_type"],
                "primary_score": group["score"],
            }
        )
        covered_accounts.update(group["account_ids"])

    for group in name_only:
        uncovered = [aid for aid in group["account_ids"] if aid not in covered_accounts]
        if len(uncovered) < 2:
            continue

        ids_key = frozenset(uncovered)
        if ids_key in seen_keys:
            continue

        seen_keys.add(ids_key)
        group_match_types = _pair_signals_for_ids(uncovered, pair_signals)
        uncovered_ids = set(uncovered)
        final_groups.append(
            {
                "account_ids": uncovered,
                "match_types": group_match_types if group_match_types else {"name"},
                "explanations": [group["explanation"]],
                "pairwise": [
                    pair
                    for pair in group.get("pairwise", [])
                    if pair["account_id_a"] in uncovered_ids
                    and pair["account_id_b"] in uncovered_ids
                ],
                "primary_match_type": "name",
                "primary_score": group["score"],
            }
        )

    capped = [group for group in final_groups if len(group["account_ids"]) <= MAX_GROUP_SIZE]
    _enrich_and_persist(capped)
    return len(capped)


def _build_matchers() -> dict:
    matchers = {
        "website": find_website_duplicates,
        "name": find_name_duplicates,
    }
    for match_type in CONFIGURED_MATCH_TYPES:
        matchers[match_type] = partial(find_duplicates_for_match_type, match_type)
    return matchers


def _pair_signals_for_ids(account_ids: list[str], pair_signals: dict) -> set[str]:
    match_types = set()
    for i in range(len(account_ids)):
        for j in range(i + 1, len(account_ids)):
            pair = frozenset([account_ids[i], account_ids[j]])
            match_types.update(pair_signals.get(pair, set()))
    return match_types


def _enrich_and_persist(groups: list[dict]):
    """Load account data, detect parent-child vs merge, score, persist."""
    conn = get_conn()
    try:
        conn.execute("DELETE FROM pairwise_scores")
        conn.execute("DELETE FROM group_members")
        conn.execute("DELETE FROM merge_log")
        conn.execute("DELETE FROM duplicate_groups")

        for group in groups:
            placeholders = ",".join("?" * len(group["account_ids"]))
            accounts = conn.execute(
                f"SELECT * FROM accounts WHERE id IN ({placeholders})",
                group["account_ids"],
            ).fetchall()
            accounts = [dict(account) for account in accounts]

            if len(accounts) < 2:
                continue

            action, action_reason = _detect_action(accounts)
            score, tier = _compute_composite_score(group)

            explanation_parts = list(group["explanations"])
            if action == "set_parent":
                explanation_parts.append(f"Parent-child: {action_reason}")
            explanation = " | ".join(explanation_parts)

            stage_lower = {key.lower(): value for key, value in STAGE_PRIORITY.items()}
            accounts_sorted = sorted(
                accounts,
                key=lambda account: (
                    1 if is_service_or_admin_owner(account.get("owner_name")) else 0,
                    stage_lower.get((account.get("account_stage") or "").lower(), 99),
                    -(account.get("arr") or 0),
                    -(account.get("current_arr") or 0),
                ),
            )

            recommended_id = accounts_sorted[0]["id"]
            has_svc = any(is_service_or_admin_owner(a.get("owner_name")) for a in accounts)

            cursor = conn.execute(
                """INSERT INTO duplicate_groups
                   (match_types, score, tier, recommended_action, has_service_owner, explanation)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    json.dumps(sorted(group["match_types"])),
                    score,
                    tier,
                    action,
                    1 if has_svc else 0,
                    explanation,
                ),
            )
            group_id = cursor.lastrowid

            for account in accounts_sorted:
                role = "parent" if account["id"] == recommended_id else "child"
                if action == "merge":
                    role = "master" if account["id"] == recommended_id else "victim"
                conn.execute(
                    "INSERT INTO group_members (group_id, account_id, is_master, role) VALUES (?, ?, ?, ?)",
                    (
                        group_id,
                        account["id"],
                        1 if account["id"] == recommended_id else 0,
                        role,
                    ),
                )

            for pairwise in group.get("pairwise", []):
                conn.execute(
                    """INSERT INTO pairwise_scores
                       (group_id, account_id_a, account_id_b, match_type, score)
                       VALUES (?, ?, ?, ?, ?)""",
                    (
                        group_id,
                        pairwise["account_id_a"],
                        pairwise["account_id_b"],
                        "name",
                        pairwise["score"],
                    ),
                )

        conn.commit()
    finally:
        conn.close()


def _detect_action(accounts: list[dict]) -> tuple[str, str]:
    """Detect whether a group should be merged or set up as parent-child."""
    if len(accounts) < 2:
        return "merge", ""

    names = [(a["id"], a.get("name", ""), normalize_name(a.get("name", ""))) for a in accounts]
    countries = set(a.get("billing_country") or "" for a in accounts)
    countries.discard("")

    for i in range(len(names)):
        for j in range(len(names)):
            if i == j:
                continue
            n_i = names[i][2] or ""
            n_j = names[j][2] or ""
            if not n_i or not n_j:
                continue

            if n_i != n_j and n_j.startswith(n_i) and len(n_j) > len(n_i) + 2:
                extra = n_j[len(n_i):].strip()
                if extra and not extra.isdigit():
                    suffix_tokens = set(extra.lower().split())
                    if suffix_tokens & PARENT_CHILD_SUFFIXES:
                        return "set_parent", f'"{names[i][1]}" appears to be parent of "{names[j][1]}"'

    if len(countries) > 1:
        return "set_parent", f"Different countries: {', '.join(sorted(countries))}"

    return "merge", ""


def _compute_composite_score(group: dict) -> tuple[float, int]:
    """Compute composite score (0-100) and tier."""
    match_types = group["match_types"]
    primary_match_type = group["primary_match_type"]
    base = match_type_base_score(primary_match_type)

    if primary_match_type == "name":
        base = group["primary_score"] * 100

    if len(match_types) > 1:
        secondary = sorted(
            [match_type for match_type in match_types if match_type != primary_match_type],
            key=match_type_bonus,
            reverse=True,
        )
        bonus = sum(match_type_bonus(match_type) for match_type in secondary)
    else:
        bonus = 0

    score = min(100, base + bonus)

    if primary_match_type == "name" and len(match_types) == 1:
        group_size = len(group["account_ids"])
        if group_size > 5:
            score = max(70, score - (group_size - 5) * 3)

    if score >= TIER1_MIN:
        tier = 1
    elif score >= TIER2_MIN:
        tier = 2
    else:
        tier = 3

    return score, tier
