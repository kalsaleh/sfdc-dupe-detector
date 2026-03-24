"""Fetch related data counts (Opportunities, Contacts, Cases) from Salesforce."""

from __future__ import annotations

from backend.db import get_conn
from backend.extraction.simple_sf import get_sf_client


def get_related_counts(account_ids: list[str]) -> list[dict]:
    """Fetch Opp/Contact/Case counts for accounts. Uses cache, falls back to live SOQL."""
    conn = get_conn()
    results = {}

    try:
        # Check cache first
        cached = conn.execute(
            f"SELECT * FROM related_data_cache WHERE account_id IN ({','.join('?' * len(account_ids))})",
            account_ids,
        ).fetchall()

        for row in cached:
            results[row["account_id"]] = {
                "account_id": row["account_id"],
                "opportunity_count": row["opportunity_count"],
                "contact_count": row["contact_count"],
                "case_count": row["case_count"],
            }

        # Fetch missing from Salesforce
        missing = [aid for aid in account_ids if aid not in results]
        if missing:
            sf = get_sf_client()
            for aid in missing:
                counts = _fetch_counts(sf, aid)
                results[aid] = counts
                # Cache
                conn.execute(
                    """INSERT OR REPLACE INTO related_data_cache
                       (account_id, opportunity_count, contact_count, case_count)
                       VALUES (?, ?, ?, ?)""",
                    (aid, counts["opportunity_count"], counts["contact_count"], counts["case_count"]),
                )
            conn.commit()

    finally:
        conn.close()

    return [results.get(aid, {"account_id": aid, "opportunity_count": 0, "contact_count": 0, "case_count": 0})
            for aid in account_ids]


def _fetch_counts(sf, account_id: str) -> dict:
    """Fetch related record counts for a single account via SOQL."""
    counts = {"account_id": account_id, "opportunity_count": 0, "contact_count": 0, "case_count": 0}

    try:
        r = sf.query(f"SELECT COUNT() FROM Opportunity WHERE AccountId = '{account_id}'")
        counts["opportunity_count"] = r.get("totalSize", 0)
    except Exception:
        pass

    try:
        r = sf.query(f"SELECT COUNT() FROM Contact WHERE AccountId = '{account_id}'")
        counts["contact_count"] = r.get("totalSize", 0)
    except Exception:
        pass

    try:
        r = sf.query(f"SELECT COUNT() FROM Case WHERE AccountId = '{account_id}'")
        counts["case_count"] = r.get("totalSize", 0)
    except Exception:
        pass

    return counts
