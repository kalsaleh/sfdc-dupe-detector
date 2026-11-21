"""Related-record counts stay local.

Opportunity, Contact, and Case counts are not queried from Salesforce.
The review screen can still render; the counts are left at zero.
"""

from __future__ import annotations


def get_related_counts(account_ids: list[str]) -> list[dict]:
    return [
        {
            "account_id": account_id,
            "opportunity_count": 0,
            "contact_count": 0,
            "case_count": 0,
        }
        for account_id in account_ids
    ]
