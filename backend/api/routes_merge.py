"""API routes for merge preview and execution."""

from __future__ import annotations

import json
from fastapi import APIRouter
from backend.models import MergeExecuteRequest, MergeExecuteResponse, BulkMergeRequest, BulkMergeResponse, AdhocMergeRequest
from backend.merging.diff_builder import build_diff
from backend.merging.related_data import get_related_counts
from backend.merging.merge_executor import execute_merge, execute_adhoc_merge
from backend.extraction.simple_sf import get_sf_client
from backend.db import get_conn

router = APIRouter()


@router.get("/merge/preview/{group_id}")
async def merge_preview(group_id: int):
    diff = build_diff(group_id)
    if not diff["accounts"]:
        return {"error": "Group not found or empty"}

    account_ids = [a["id"] for a in diff["accounts"]]
    try:
        related = get_related_counts(account_ids)
    except Exception:
        # Gracefully degrade if SF connection unavailable
        related = [{"account_id": aid, "opportunity_count": 0, "contact_count": 0, "case_count": 0} for aid in account_ids]

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
    result = execute_merge(group_id, req.master_id, req.victim_ids)
    return MergeExecuteResponse(**result)


@router.post("/merge/set-parent/{group_id}", response_model=MergeExecuteResponse)
async def set_parent(group_id: int, req: MergeExecuteRequest):
    """Set ParentId on child accounts in Salesforce."""
    parent_id = req.master_id
    conn = get_conn()
    try:
        members = conn.execute(
            "SELECT account_id FROM group_members WHERE group_id = ?",
            (group_id,),
        ).fetchall()
        all_ids = [r["account_id"] for r in members]

        if parent_id not in all_ids:
            return MergeExecuteResponse(success=False, message=f"Parent {parent_id} not in group")

        if req.victim_ids:
            child_ids = [v for v in req.victim_ids if v != parent_id]
        else:
            child_ids = [aid for aid in all_ids if aid != parent_id]
        if not child_ids:
            return MergeExecuteResponse(success=False, message="No children to link")

        sf = get_sf_client()
        errors = []
        for child_id in child_ids:
            try:
                sf.Account.update(child_id, {"ParentId": parent_id})
            except Exception as e:
                errors.append(f"{child_id}: {e}")

        if errors:
            msg = f"Partial failure: {'; '.join(errors)}"
            _log_action(conn, group_id, parent_id, child_ids, "set_parent", "partial", msg)
            return MergeExecuteResponse(success=False, message=msg)

        # Success
        log_id = _log_action(conn, group_id, parent_id, child_ids, "set_parent", "completed", "OK")
        conn.execute(
            "UPDATE duplicate_groups SET status = 'merged' WHERE group_id = ?",
            (group_id,),
        )
        conn.execute(
            "UPDATE group_members SET is_master = 1, role = 'parent' WHERE group_id = ? AND account_id = ?",
            (group_id, parent_id),
        )
        conn.commit()

        return MergeExecuteResponse(
            success=True,
            message=f"Set {parent_id} as parent of {len(child_ids)} account(s)",
            merge_log_id=log_id,
        )

    except Exception as e:
        return MergeExecuteResponse(success=False, message=str(e))
    finally:
        conn.close()


@router.post("/merge/bulk", response_model=BulkMergeResponse)
async def bulk_merge(req: BulkMergeRequest):
    """Execute merge, set-parent, or dismiss for multiple groups at once."""
    succeeded = 0
    failed = 0
    errors = []

    for gid in req.group_ids:
        try:
            if req.action == "dismiss":
                conn = get_conn()
                try:
                    conn.execute(
                        "UPDATE duplicate_groups SET status = 'dismissed' WHERE group_id = ?",
                        (gid,),
                    )
                    conn.commit()
                finally:
                    conn.close()
                succeeded += 1
            else:
                # merge or set_parent — use recommended master from build_diff
                diff = build_diff(gid)
                if not diff["accounts"]:
                    errors.append({"group_id": gid, "message": "Group not found or empty"})
                    failed += 1
                    continue

                master_id = diff["recommended_master"]
                action = req.action if req.action == "set_parent" else diff.get("recommended_action", "merge")

                if action == "set_parent":
                    # Reuse set-parent logic
                    conn = get_conn()
                    try:
                        members = conn.execute(
                            "SELECT account_id FROM group_members WHERE group_id = ?",
                            (gid,),
                        ).fetchall()
                        all_ids = [r["account_id"] for r in members]
                        child_ids = [aid for aid in all_ids if aid != master_id]

                        if not child_ids:
                            errors.append({"group_id": gid, "message": "No children to link"})
                            failed += 1
                            continue

                        sf = get_sf_client()
                        errs = []
                        for child_id in child_ids:
                            try:
                                sf.Account.update(child_id, {"ParentId": master_id})
                            except Exception as e:
                                errs.append(f"{child_id}: {e}")

                        if errs:
                            errors.append({"group_id": gid, "message": f"Partial: {'; '.join(errs)}"})
                            failed += 1
                            continue

                        _log_action(conn, gid, master_id, child_ids, "set_parent", "completed", "OK")
                        conn.execute(
                            "UPDATE duplicate_groups SET status = 'merged' WHERE group_id = ?",
                            (gid,),
                        )
                        conn.execute(
                            "UPDATE group_members SET is_master = 1, role = 'parent' WHERE group_id = ? AND account_id = ?",
                            (gid, master_id),
                        )
                        conn.commit()
                    finally:
                        conn.close()
                    succeeded += 1
                else:
                    # Standard merge
                    result = execute_merge(gid, master_id)
                    if result["success"]:
                        succeeded += 1
                    else:
                        errors.append({"group_id": gid, "message": result["message"]})
                        failed += 1
        except Exception as e:
            errors.append({"group_id": gid, "message": str(e)})
            failed += 1

    return BulkMergeResponse(
        total=len(req.group_ids),
        succeeded=succeeded,
        failed=failed,
        errors=errors,
    )


@router.post("/merge/dismiss/{group_id}")
async def dismiss_group(group_id: int):
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE duplicate_groups SET status = 'dismissed' WHERE group_id = ?",
            (group_id,),
        )
        conn.commit()
        return {"message": "Group dismissed"}
    finally:
        conn.close()


@router.post("/merge/adhoc", response_model=MergeExecuteResponse)
async def adhoc_merge(req: AdhocMergeRequest):
    """Merge accounts directly by ID without requiring a duplicate group.

    Useful for ad-hoc merges requested outside of the normal duplicate detection flow.
    """
    result = execute_adhoc_merge(req.master_id, req.victim_ids, req.reason)
    return MergeExecuteResponse(**result)


def _log_action(conn, group_id, master_id, victim_ids, action, status, response) -> int:
    cursor = conn.execute(
        """INSERT INTO merge_log (group_id, master_id, victim_ids, action, status, sf_response)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (group_id, master_id, json.dumps(victim_ids), action, status, response),
    )
    conn.commit()
    return cursor.lastrowid
