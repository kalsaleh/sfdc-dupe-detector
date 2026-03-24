"""Config-driven exact-match matcher for Salesforce identifier fields."""

from __future__ import annotations

from backend.config import MATCH_RULES_BY_NAME, match_type_base_score
from backend.db import get_conn


def find_duplicates_for_match_type(match_type: str) -> list[dict]:
    """Return duplicate groups for a configured exact-match rule."""
    rule = MATCH_RULES_BY_NAME.get(match_type)
    if not rule:
        return []

    conn = get_conn()
    try:
        rows = conn.execute(
            """
            SELECT match_value,
                   GROUP_CONCAT(DISTINCT account_id) AS ids,
                   COUNT(DISTINCT account_id) AS cnt,
                   GROUP_CONCAT(DISTINCT source_field) AS source_fields
            FROM account_match_keys
            WHERE match_type = ?
              AND match_value IS NOT NULL
              AND match_value != ''
            GROUP BY match_value
            HAVING cnt > 1
            ORDER BY cnt DESC
            """,
            (match_type,),
        ).fetchall()

        groups = []
        for row in rows:
            ids = list(set(row["ids"].split(",")))
            if len(ids) < 2:
                continue

            source_suffix = ""
            if row["source_fields"]:
                source_suffix = f" (fields: {row['source_fields']})"

            groups.append(
                {
                    "key": f"{match_type}:{row['match_value']}",
                    "account_ids": ids,
                    "score": match_type_base_score(match_type) / 100,
                    "match_type": match_type,
                    "explanation": (
                        f"Same {rule['label']}: {row['match_value']}"
                        f"{source_suffix} ({len(ids)} accounts)"
                    ),
                }
            )
        return groups
    finally:
        conn.close()
