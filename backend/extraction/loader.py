"""Parse exported CSVs, normalize, and load into SQLite."""

from __future__ import annotations

import csv
from pathlib import Path

from backend.config import MATCH_RULES
from backend.db import get_conn
from backend.extraction.bulk_export import get_export_status
from backend.matching.normalizers import (
    extract_linkedin_id,
    normalize_name,
    normalize_website,
)


def load_exports(accounts_csv: Path, users_csv: Path, incremental: bool = False):
    """Load account and user CSVs into SQLite."""
    status = get_export_status()
    status.status = "loading"
    status.message = "Loading into database..."

    conn = get_conn()

    try:
        users = {}
        with open(users_csv, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                users[row["Id"]] = row["Name"]

        if not incremental:
            conn.execute("DELETE FROM pairwise_scores")
            conn.execute("DELETE FROM merge_log")
            conn.execute("DELETE FROM group_members")
            conn.execute("DELETE FROM duplicate_groups")
            conn.execute("DELETE FROM related_data_cache")
            conn.execute("DELETE FROM account_match_keys")
            conn.execute("DELETE FROM accounts")

        count = 0
        touched_account_ids: list[str] = []
        with open(accounts_csv, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                acct_id = row.get("Id", "").strip()
                if not acct_id:
                    continue

                touched_account_ids.append(acct_id)

                name = row.get("Name", "")
                website = row.get("Website", "")
                owner_id = row.get("OwnerId", "")
                arr = _parse_float(row.get("ARR__c"))
                current_arr = _parse_float(row.get("Current_ARR__c"))
                website_norm = normalize_website(website)
                name_norm = normalize_name(name)

                conn.execute(
                    """INSERT INTO accounts
                    (id, name, name_normalized, website, website_normalized,
                     owner_id, owner_name, type, industry, account_stage,
                     billing_country, arr, current_arr, customer_health,
                     created_date, last_modified_date)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET
                        name=excluded.name,
                        name_normalized=excluded.name_normalized,
                        website=excluded.website,
                        website_normalized=excluded.website_normalized,
                        owner_id=excluded.owner_id,
                        owner_name=excluded.owner_name,
                        type=excluded.type,
                        industry=excluded.industry,
                        account_stage=excluded.account_stage,
                        billing_country=excluded.billing_country,
                        arr=excluded.arr,
                        current_arr=excluded.current_arr,
                        customer_health=excluded.customer_health,
                        created_date=excluded.created_date,
                        last_modified_date=excluded.last_modified_date""",
                    (
                        acct_id,
                        name,
                        name_norm,
                        website,
                        website_norm,
                        owner_id,
                        users.get(owner_id, ""),
                        row.get("Type", ""),
                        row.get("Industry", ""),
                        row.get("Account_Stage__c", ""),
                        row.get("BillingCountry", ""),
                        arr,
                        current_arr,
                        row.get("Customer_Health__c", ""),
                        row.get("CreatedDate", ""),
                        row.get("LastModifiedDate", ""),
                    ),
                )

                count += 1
                if count % 10000 == 0:
                    status.message = f"Loaded {count} accounts..."
                    conn.commit()

        if incremental:
            _delete_match_keys_for_accounts(conn, touched_account_ids)
        else:
            conn.execute("DELETE FROM account_match_keys")

        match_key_count = 0
        with open(accounts_csv, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                acct_id = row.get("Id", "").strip()
                if not acct_id:
                    continue

                for rule in MATCH_RULES:
                    seen_values = set()
                    for field in rule["fields"]:
                        match_value = _normalize_match_value(
                            row.get(field), rule["normalizer"]
                        )
                        if not match_value or match_value in seen_values:
                            continue
                        seen_values.add(match_value)
                        conn.execute(
                            """INSERT INTO account_match_keys
                               (account_id, match_type, label, match_value, source_field)
                               VALUES (?, ?, ?, ?, ?)""",
                            (
                                acct_id,
                                rule["name"],
                                rule["label"],
                                match_value,
                                field,
                            ),
                        )
                        match_key_count += 1

        conn.commit()

        conn.execute(
            "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('last_sync', datetime('now'))"
        )
        conn.commit()

        total = conn.execute("SELECT COUNT(*) as cnt FROM accounts").fetchone()["cnt"]

        status.status = "done"
        status.account_count = total
        label = "Updated" if incremental else "Loaded"
        status.message = (
            f"{label} {count} accounts ({total} total in database, "
            f"{match_key_count} match keys rebuilt)"
        )

    except Exception as e:
        status.status = "error"
        status.message = str(e)
        raise
    finally:
        conn.close()


def _delete_match_keys_for_accounts(conn, account_ids: list[str], batch_size: int = 500):
    unique_ids = list(dict.fromkeys(account_ids))
    for idx in range(0, len(unique_ids), batch_size):
        batch = unique_ids[idx:idx + batch_size]
        placeholders = ",".join("?" * len(batch))
        conn.execute(
            f"DELETE FROM account_match_keys WHERE account_id IN ({placeholders})",
            batch,
        )


def _normalize_match_value(value: str | None, normalizer: str) -> str | None:
    if normalizer == "linkedin_company":
        return extract_linkedin_id(value)

    cleaned = _clean(value)
    if cleaned and normalizer == "lower":
        return cleaned.lower()
    return cleaned


def _clean(val: str | None) -> str | None:
    if not val:
        return None
    val = str(val).strip()
    if val.lower() in ("", "none", "null", "nan"):
        return None
    if val.endswith(".0") and val[:-2].isdigit():
        return val[:-2]
    return val


def _parse_float(val: str | None) -> float | None:
    if not val:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None
