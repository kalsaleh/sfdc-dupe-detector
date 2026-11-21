"""Merge routes. Salesforce writes are refused before any client is built."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from backend.db import get_conn
from backend.merging.diff_builder import build_diff
from backend.merging.related_data import get_related_counts
from backend.models import BulkMergeRequest, BulkMergeResponse, MergeExecuteRequest, MergeExecuteResponse

router = APIRouter()

WRITE_DISABLED = (
    "Read-only mode: Salesforce merges, parent updates, and deletes are disabled."
)


@router.get("/merge/preview/{group_id}")
async def merge_preview(group_id: int):
    diff = build_diff(group_id)
    if not diff["accounts"]:
        return {"error": "Group not found or empty"}

    account_ids = [account["id"] for account in diff["accounts"]]
    related = get_related_counts(account_ids)

    conn = get_conn()
    try:
        group = conn.execute(
            "SELECT explanation FROM duplicate_groups WHERE group_id = ?",
            (group_id,),
        ).fetchone()
        explanation = group["explanation"] if group else ""
    finally:
        conn.close()

    return {
        "group_id": group_id,
        "accounts": diff["accounts"],
        "diffs": diff["diffs"],
        "related_data": related,
        "recommended_master": diff["recommended_master"],
        "recommended_action": diff["recommended_action"],
        "explanation": explanation,
    }


@router.post("/merge/execute/{group_id}", response_model=MergeExecuteResponse)
async def do_merge(group_id: int, req: MergeExecuteRequest):
    del group_id, req
    raise HTTPException(status_code=403, detail=WRITE_DISABLED)


@router.post("/merge/set-parent/{group_id}", response_model=MergeExecuteResponse)
async def set_parent(group_id: int, req: MergeExecuteRequest):
    del group_id, req
    raise HTTPException(status_code=403, detail=WRITE_DISABLED)


@router.post("/merge/bulk", response_model=BulkMergeResponse)
async def bulk_merge(req: BulkMergeRequest):
    """Dismiss is local SQLite only. Merge and set-parent are refused."""
    if req.action != "dismiss":
        return BulkMergeResponse(
            total=len(req.group_ids),
            succeeded=0,
            failed=len(req.group_ids),
            errors=[{"message": WRITE_DISABLED}],
        )

    succeeded = 0
    failed = 0
    errors = []
    for group_id in req.group_ids:
        conn = get_conn()
        try:
            conn.execute(
                "UPDATE duplicate_groups SET status = 'dismissed' WHERE group_id = ?",
                (group_id,),
            )
            conn.commit()
            succeeded += 1
        except Exception as exc:
            errors.append({"group_id": group_id, "message": str(exc)})
            failed += 1
        finally:
            conn.close()

    return BulkMergeResponse(
        total=len(req.group_ids),
        succeeded=succeeded,
        failed=failed,
        errors=errors,
    )


@router.post("/merge/dismiss/{group_id}")
async def dismiss_group(group_id: int):
    """Hide a group in the local database. Salesforce is not contacted."""
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE duplicate_groups SET status = 'dismissed' WHERE group_id = ?",
            (group_id,),
        )
        conn.commit()
        return {"message": "Group dismissed locally"}
    finally:
        conn.close()
