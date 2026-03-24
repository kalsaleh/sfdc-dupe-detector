"""Field-level diff and master recommendation for a duplicate group."""

from __future__ import annotations

from backend.config import CONFIGURED_MATCH_TYPES, is_service_or_admin_owner, match_type_label
from backend.db import get_conn

BASE_COMPARE_FIELDS = [
    ("name", "Name"),
    ("website", "Website"),
    ("owner_name", "Owner"),
    ("account_stage", "Account Stage"),
    ("billing_country", "Country"),
    ("type", "Type"),
    ("industry", "Industry"),
    ("arr", "ARR"),
    ("current_arr", "Current ARR"),
    ("customer_health", "Customer Health"),
    ("created_date", "Created Date"),
    ("last_modified_date", "Last Modified Date"),
]

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


def build_diff(group_id: int) -> dict:
    """Build field-level diff for all accounts in a group."""
    conn = get_conn()
    try:
        group = conn.execute(
            "SELECT recommended_action FROM duplicate_groups WHERE group_id = ?",
            (group_id,),
        ).fetchone()
        action = group["recommended_action"] if group else "merge"

        members = conn.execute(
            """SELECT a.*, gm.role FROM accounts a
               JOIN group_members gm ON a.id = gm.account_id
               WHERE gm.group_id = ?
               ORDER BY gm.is_master DESC""",
            (group_id,),
        ).fetchall()

        if not members:
            return {
                "accounts": [],
                "diffs": [],
                "recommended_master": None,
                "recommended_action": action,
            }

        accounts = [dict(member) for member in members]
        account_ids = [account["id"] for account in accounts]
        match_key_values = _load_match_key_values(conn, account_ids)

        accounts.sort(
            key=lambda account: (
                1 if is_service_or_admin_owner(account.get("owner_name")) else 0,
                STAGE_PRIORITY.get(account.get("account_stage") or "", 99),
                -(account.get("arr") or 0),
                -(account.get("current_arr") or 0),
            )
        )

        for account in accounts:
            account["match_key_values"] = match_key_values.get(account["id"], {})
            account["is_service_owner"] = is_service_or_admin_owner(account.get("owner_name"))

        diffs = []
        for db_field, label in BASE_COMPARE_FIELDS:
            values = {}
            for account in accounts:
                val = account.get(db_field)
                values[account["id"]] = str(val) if val is not None else None

            non_null = [value for value in values.values() if value is not None]
            differs = len(set(non_null)) > 1 if non_null else False

            diffs.append({"field": label, "values": values, "differs": differs})

        diffs.extend(_build_match_key_diffs(accounts, match_key_values))
        recommended = accounts[0]["id"]

        return {
            "accounts": accounts,
            "diffs": diffs,
            "recommended_master": recommended,
            "recommended_action": action,
        }
    finally:
        conn.close()


def _load_match_key_values(conn, account_ids: list[str]) -> dict[str, dict[str, str]]:
    if not account_ids:
        return {}

    placeholders = ",".join("?" * len(account_ids))
    rows = conn.execute(
        f"""
        SELECT account_id, match_type, GROUP_CONCAT(DISTINCT match_value) AS match_values
        FROM account_match_keys
        WHERE account_id IN ({placeholders})
        GROUP BY account_id, match_type
        """,
        account_ids,
    ).fetchall()

    value_map = {account_id: {} for account_id in account_ids}
    for row in rows:
        value_map.setdefault(row["account_id"], {})[row["match_type"]] = row["match_values"]
    return value_map


def _build_match_key_diffs(
    accounts: list[dict],
    match_key_values: dict[str, dict[str, str]],
) -> list[dict]:
    account_ids = [account["id"] for account in accounts]
    rows = []
    ordered_match_types = list(CONFIGURED_MATCH_TYPES)
    seen_match_types = set(ordered_match_types)
    for values in match_key_values.values():
        for match_type in values:
            if match_type not in seen_match_types:
                ordered_match_types.append(match_type)
                seen_match_types.add(match_type)

    for match_type in ordered_match_types:
        label = match_type_label(match_type)
        values = {}
        for account in accounts:
            account_values = account.get("match_key_values", {})
            values[account["id"]] = account_values.get(match_type)

        non_null = [value for value in values.values() if value is not None]
        if not non_null:
            continue

        rows.append(
            {
                "field": label,
                "values": values,
                "differs": len(set(non_null)) > 1 if non_null else False,
            }
        )

    return rows
