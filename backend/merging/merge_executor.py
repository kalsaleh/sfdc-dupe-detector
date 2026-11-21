"""Salesforce account merges are hard-disabled.

Account merge, parent updates, and relation deletes cannot run from this
process. There is no flag that turns them back on.
"""

from __future__ import annotations


class SalesforceWritesDisabled(RuntimeError):
    """Raised if a removed Salesforce write is invoked."""


def _refuse(action: str) -> dict:
    return {
        "success": False,
        "message": (
            f"Read-only mode: {action} is disabled. "
            "This app does not merge, update, or delete Salesforce records."
        ),
    }


def execute_merge(group_id: int, master_id: str, victim_ids: list | None = None) -> dict:
    """Refuse an account merge. No Salesforce client is created."""
    del group_id, master_id, victim_ids
    return _refuse("Account merge")


def _clean_overlapping_acrs(*_args, **_kwargs) -> int:
    """Refuse AccountContactRelation deletes."""
    raise SalesforceWritesDisabled(
        "Read-only mode: AccountContactRelation.delete is disabled."
    )
