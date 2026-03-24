"""Match Type 1: Accounts with the same normalized website."""

from __future__ import annotations

from backend.db import get_conn

# Domains that are NOT company websites — skip these
DOMAIN_BLOCKLIST = {
    "linkedin.com", "facebook.com", "instagram.com", "twitter.com",
    "youtube.com", "tiktok.com", "reddit.com", "pinterest.com",
    "linktr.ee", "bit.ly", "t.co", "goo.gl", "ow.ly", "buff.ly",
    "crunchbase.com", "opencorporates.com", "indeed.com",
    "github.com", "gitlab.com", "medium.com", "wordpress.com",
    "blogspot.com", "wix.com", "squarespace.com", "weebly.com",
    "google.com", "apple.com", "microsoft.com",
    "bbb.org", "nba.com",
}

MAX_GROUP_SIZE = 10


def find_website_duplicates() -> list[dict]:
    """Return groups of accounts sharing the same normalized website.

    Filters out:
    - Blocklisted social media / portal domains
    - Groups > MAX_GROUP_SIZE
    - Groups where all accounts have completely different names (portal sites)
    """
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT website_normalized,
                   GROUP_CONCAT(id) as ids,
                   COUNT(*) as cnt,
                   COUNT(DISTINCT name_normalized) as distinct_names
            FROM accounts
            WHERE website_normalized IS NOT NULL AND website_normalized != ''
            GROUP BY website_normalized
            HAVING cnt > 1
            ORDER BY cnt DESC
        """).fetchall()

        groups = []
        for row in rows:
            domain = row["website_normalized"]

            if domain in DOMAIN_BLOCKLIST:
                continue

            ids = row["ids"].split(",")

            if len(ids) > MAX_GROUP_SIZE:
                continue

            # Skip portal-like domains: all accounts have different names
            # (real dupes should have at least some name overlap)
            if row["distinct_names"] == len(ids) and len(ids) >= 3:
                continue

            groups.append({
                "key": f"website:{domain}",
                "account_ids": ids,
                "score": 0.95,
                "match_type": "website",
                "explanation": f"Same website: {domain} ({len(ids)} accounts)",
            })
        return groups
    finally:
        conn.close()
