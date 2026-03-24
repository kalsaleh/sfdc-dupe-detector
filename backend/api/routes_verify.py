"""API routes for headless-browser website verification."""

from __future__ import annotations

import threading
from fastapi import APIRouter
from backend.db import get_conn

router = APIRouter()

_verify_status: dict = {"status": "idle", "message": "", "result": None}


@router.post("/verify/websites")
async def start_verification():
    """Trigger background verification for all duplicate groups."""
    global _verify_status
    if _verify_status["status"] == "running":
        return {"message": "Verification already in progress"}

    def _run():
        global _verify_status
        _verify_status = {"status": "running", "message": "Starting…", "result": None}
        try:
            from backend.matching.website_verifier import verify_all_groups  # noqa: PLC0415

            def _cb(msg: str):
                _verify_status["message"] = msg

            result = verify_all_groups(status_cb=_cb)
            _verify_status = {
                "status": "done",
                "message": (
                    f"Done — {result['confirmed']} confirmed, "
                    f"{result['denied']} denied, "
                    f"{result['inconclusive']} inconclusive"
                ),
                "result": result,
            }
        except Exception as exc:
            _verify_status = {"status": "error", "message": str(exc), "result": None}

    threading.Thread(target=_run, daemon=True).start()
    return {"message": "Website verification started"}


@router.get("/verify/status")
async def verify_status():
    return _verify_status


@router.post("/verify/group/{group_id}")
async def verify_single_group(group_id: int):
    """Re-verify a single group immediately (synchronous, returns result)."""
    import json  # noqa: PLC0415
    from backend.matching.website_verifier import sites_match, _write_verification  # noqa: PLC0415

    conn = get_conn()
    try:
        grp = conn.execute(
            "SELECT match_types FROM duplicate_groups WHERE group_id = ?", (group_id,)
        ).fetchone()
        if not grp:
            return {"error": "group not found"}
        match_types = set(json.loads(grp["match_types"] or "[]"))

        members = conn.execute(
            """SELECT a.id, a.name, a.website
               FROM group_members gm
               JOIN accounts a ON a.id = gm.account_id
               WHERE gm.group_id = ?""",
            (group_id,),
        ).fetchall()
    finally:
        conn.close()

    members = [dict(m) for m in members]
    websites = [(m["id"], m["name"], m["website"]) for m in members if m.get("website")]

    if len(websites) < 2:
        return {"group_id": group_id, "verified": None, "reason": "fewer than 2 websites to compare"}

    pair_results = []
    for i in range(len(websites)):
        for j in range(i + 1, len(websites)):
            id_a, name_a, url_a = websites[i]
            id_b, name_b, url_b = websites[j]
            res = sites_match(url_a, url_b)
            pair_results.append({
                "account_a": {"id": id_a, "name": name_a, "website": url_a},
                "account_b": {"id": id_b, "name": name_b, "website": url_b},
                "match": res["match"],
                "confidence": res["confidence"],
                "reason": res["reason"],
                "site_a": res.get("site_a"),
                "site_b": res.get("site_b"),
            })

    matches = [r["match"] for r in pair_results]
    if False in matches:
        verified = 0
        summary = "one or more pairs resolve to different domains"
    elif None in matches:
        verified = None
        summary = "could not resolve all websites"
    else:
        verified = 1
        summary = "all member websites resolve to the same destination"

    import json as _json  # noqa: PLC0415
    _write_verification(group_id, verified, summary, match_types,
                        _json.dumps({"summary": summary, "pairs": pair_results}))

    return {"group_id": group_id, "verified": verified, "summary": summary, "pairs": pair_results}


@router.delete("/verify/cache")
async def clear_verify_cache():
    """Clear the website resolution cache (forces re-fetch on next verification)."""
    conn = get_conn()
    try:
        conn.execute("DELETE FROM website_verify_cache")
        conn.commit()
        count = conn.execute("SELECT changes()").fetchone()[0]
    finally:
        conn.close()
    return {"message": f"Cache cleared ({count} entries removed)"}
