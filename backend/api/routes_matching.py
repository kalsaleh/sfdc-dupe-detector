"""API routes for matching operations."""

from __future__ import annotations

import csv
import io
import json
import threading
from typing import List, Optional

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from backend.config import MATCH_RULES, match_type_base_score, match_type_label
from backend.db import get_conn
from backend.matching.orchestrator import run_all_matchers
from backend.models import GroupListResponse, GroupSummary, MatchRunRequest

router = APIRouter()

_match_status = {"status": "idle", "message": ""}


@router.post("/match/run")
async def run_matching(req: MatchRunRequest = MatchRunRequest()):
    global _match_status
    if _match_status["status"] == "running":
        return {"message": "Matching already in progress"}

    match_types = req.match_types

    def _run():
        global _match_status
        _match_status = {"status": "running", "message": "Running matchers..."}
        try:
            count = run_all_matchers(match_types)
            _match_status = {"status": "done", "message": f"Found {count} duplicate groups"}
        except Exception as e:
            _match_status = {"status": "error", "message": str(e)}

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"message": "Matching started"}


@router.get("/match/status")
async def match_status():
    return _match_status


@router.get("/match/options")
async def list_match_options():
    options = [
        {"type": "website", "label": match_type_label("website"), "base_score": 95},
        *[
            {
                "type": rule["name"],
                "label": rule["label"],
                "base_score": match_type_base_score(rule["name"]),
                "fields": rule["fields"],
                "normalizer": rule["normalizer"],
            }
            for rule in MATCH_RULES
        ],
        {"type": "name", "label": match_type_label("name"), "base_score": 70},
    ]
    return {"match_types": options}


@router.get("/match/owners")
async def list_owners():
    """Return distinct owner names from accounts that appear in duplicate groups."""
    conn = get_conn()
    try:
        rows = conn.execute(
            """SELECT DISTINCT a.owner_name
               FROM accounts a
               JOIN group_members gm ON a.id = gm.account_id
               WHERE a.owner_name IS NOT NULL AND a.owner_name != ''
               ORDER BY a.owner_name"""
        ).fetchall()
        return {"owners": [r["owner_name"] for r in rows]}
    finally:
        conn.close()


def _build_group_filter(
    tier,
    match_types,
    status,
    search,
    owner,
    owner_match,
    owner1,
    owner2,
    has_service_owner=None,
):
    """Build WHERE clause and base query for group filtering. Returns (base_query, params)."""
    where = []
    params = []

    if tier is not None:
        where.append("dg.tier = ?")
        params.append(tier)
    if has_service_owner is not None:
        where.append("dg.has_service_owner = ?")
        params.append(1 if has_service_owner else 0)
    if status:
        where.append("dg.status = ?")
        params.append(status)

    if match_types:
        type_conditions = []
        for match_type in match_types:
            type_conditions.append("dg.match_types LIKE ?")
            params.append(f'%"{match_type}"%')
        if type_conditions:
            where.append(f"({' OR '.join(type_conditions)})")

    if owner:
        if owner_match == "all":
            where.append(
                """dg.group_id IN (
                SELECT gm2.group_id FROM group_members gm2
                JOIN accounts a2 ON gm2.account_id = a2.id
                WHERE a2.owner_name = ?)"""
            )
            params.append(owner)
            where.append(
                """dg.group_id NOT IN (
                SELECT gm3.group_id FROM group_members gm3
                JOIN accounts a3 ON gm3.account_id = a3.id
                WHERE a3.owner_name != ? OR a3.owner_name IS NULL)"""
            )
            params.append(owner)
        else:
            where.append(
                """dg.group_id IN (
                SELECT gm2.group_id FROM group_members gm2
                JOIN accounts a2 ON gm2.account_id = a2.id
                WHERE a2.owner_name = ?)"""
            )
            params.append(owner)

    if owner1:
        where.append(
            """dg.group_id IN (
            SELECT gm2.group_id FROM group_members gm2
            JOIN accounts a2 ON gm2.account_id = a2.id
            WHERE a2.owner_name = ?)"""
        )
        params.append(owner1)
    if owner2:
        where.append(
            """dg.group_id IN (
            SELECT gm2.group_id FROM group_members gm2
            JOIN accounts a2 ON gm2.account_id = a2.id
            WHERE a2.owner_name = ?)"""
        )
        params.append(owner2)

    where_clause = " AND ".join(where) if where else "1=1"

    if search:
        base_query = f"""
            SELECT DISTINCT dg.group_id, dg.match_types, dg.score, dg.tier,
                   dg.status, dg.recommended_action, dg.has_service_owner, dg.explanation
            FROM duplicate_groups dg
            JOIN group_members gm ON dg.group_id = gm.group_id
            JOIN accounts a ON gm.account_id = a.id
            WHERE {where_clause} AND a.name LIKE ?
        """
        params.append(f"%{search}%")
    else:
        base_query = f"""
            SELECT dg.group_id, dg.match_types, dg.score, dg.tier,
                   dg.status, dg.recommended_action, dg.has_service_owner, dg.explanation
            FROM duplicate_groups dg
            WHERE {where_clause}
        """

    return base_query, params


@router.get("/match/group-ids")
async def list_group_ids(
    tier: Optional[int] = Query(None),
    match_types: Optional[List[str]] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    owner: Optional[str] = Query(None),
    owner_match: Optional[str] = Query("all"),
    owner1: Optional[str] = Query(None),
    owner2: Optional[str] = Query(None),
    has_service_owner: Optional[bool] = Query(None),
):
    """Return all group IDs matching the current filters (no pagination)."""
    conn = get_conn()
    try:
        base_query, params = _build_group_filter(
            tier,
            match_types,
            status,
            search,
            owner,
            owner_match,
            owner1,
            owner2,
            has_service_owner,
        )
        id_query = f"SELECT group_id FROM ({base_query}) ORDER BY score DESC, tier ASC"
        rows = conn.execute(id_query, params).fetchall()
        return {"group_ids": [r["group_id"] for r in rows]}
    finally:
        conn.close()


@router.get("/match/groups", response_model=GroupListResponse)
async def list_groups(
    tier: Optional[int] = Query(None),
    match_types: Optional[List[str]] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    owner: Optional[str] = Query(None),
    owner_match: Optional[str] = Query("all"),
    owner1: Optional[str] = Query(None),
    owner2: Optional[str] = Query(None),
    has_service_owner: Optional[bool] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    conn = get_conn()
    try:
        base_query, params = _build_group_filter(
            tier,
            match_types,
            status,
            search,
            owner,
            owner_match,
            owner1,
            owner2,
            has_service_owner,
        )

        count_query = f"SELECT COUNT(*) as cnt FROM ({base_query})"
        total = conn.execute(count_query, params).fetchone()["cnt"]

        offset = (page - 1) * page_size
        data_query = f"{base_query} ORDER BY dg.score DESC, dg.tier ASC LIMIT ? OFFSET ?"
        rows = conn.execute(data_query, params + [page_size, offset]).fetchall()

        groups = []
        for row in rows:
            names_rows = conn.execute(
                """SELECT a.name FROM accounts a
                   JOIN group_members gm ON a.id = gm.account_id
                   WHERE gm.group_id = ?""",
                (row["group_id"],),
            ).fetchall()
            names = [r["name"] for r in names_rows]

            groups.append(
                GroupSummary(
                    group_id=row["group_id"],
                    names=names,
                    match_types=json.loads(row["match_types"]),
                    score=row["score"],
                    tier=row["tier"],
                    size=len(names),
                    status=row["status"],
                    recommended_action=row["recommended_action"],
                    has_service_owner=bool(row["has_service_owner"]),
                    explanation=row["explanation"],
                )
            )

        return GroupListResponse(groups=groups, total=total, page=page, page_size=page_size)
    finally:
        conn.close()


@router.get("/match/groups/{group_id}/neighbors")
async def get_group_neighbors(
    group_id: int,
    tier: Optional[int] = Query(None),
    match_types: Optional[List[str]] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    owner: Optional[str] = Query(None),
    owner_match: Optional[str] = Query("all"),
    owner1: Optional[str] = Query(None),
    owner2: Optional[str] = Query(None),
    has_service_owner: Optional[bool] = Query(None),
):
    """Return prev/next group IDs (ordered by score DESC, tier ASC) respecting filters."""
    conn = get_conn()
    try:
        base_query, params = _build_group_filter(
            tier,
            match_types,
            status,
            search,
            owner,
            owner_match,
            owner1,
            owner2,
            has_service_owner,
        )
        id_query = f"SELECT group_id FROM ({base_query}) ORDER BY score DESC, tier ASC"
        rows = conn.execute(id_query, params).fetchall()
        ids = [r["group_id"] for r in rows]

        if group_id not in ids:
            return {
                "prev_group_id": None,
                "next_group_id": ids[0] if ids else None,
                "remaining": len(ids),
            }

        idx = ids.index(group_id)
        prev_id = ids[idx - 1] if idx > 0 else None
        next_id = ids[idx + 1] if idx < len(ids) - 1 else None
        return {"prev_group_id": prev_id, "next_group_id": next_id, "remaining": len(ids)}
    finally:
        conn.close()


@router.get("/match/groups/{group_id}")
async def get_group_detail(group_id: int):
    conn = get_conn()
    try:
        group = conn.execute(
            "SELECT * FROM duplicate_groups WHERE group_id = ?",
            (group_id,),
        ).fetchone()

        if not group:
            return {"error": "Group not found"}

        accounts = conn.execute(
            """SELECT a.*, gm.is_master FROM accounts a
               JOIN group_members gm ON a.id = gm.account_id
               WHERE gm.group_id = ?""",
            (group_id,),
        ).fetchall()

        pairwise = conn.execute(
            """SELECT account_id_a, account_id_b, match_type, score
               FROM pairwise_scores WHERE group_id = ?""",
            (group_id,),
        ).fetchall()

        return {
            "group_id": group["group_id"],
            "match_types": json.loads(group["match_types"]),
            "score": group["score"],
            "tier": group["tier"],
            "status": group["status"],
            "explanation": group["explanation"],
            "accounts": [dict(account) for account in accounts],
            "pairwise_scores": [dict(pair) for pair in pairwise],
        }
    finally:
        conn.close()


def _export_columns() -> list[str]:
    return [
        "Group ID",
        "Tier",
        "Score",
        "Match Types",
        "Recommended Action",
        "Explanation",
        "Status",
        "Account ID",
        "Account Name",
        "Website",
        "Owner",
        "Account Stage",
        "Country",
        "Type",
        "Industry",
        *[rule["label"] for rule in MATCH_RULES],
        "ARR",
        "Current ARR",
        "Role",
    ]


def _match_value_map(conn, account_ids: list[str]) -> dict[str, dict[str, str]]:
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


@router.post("/match/export")
async def export_groups(
    group_ids: Optional[List[int]] = None,
    tier: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
):
    """Export selected (or filtered) groups as CSV. One row per account."""
    conn = get_conn()
    try:
        if group_ids:
            placeholders = ",".join("?" * len(group_ids))
            groups = conn.execute(
                f"SELECT * FROM duplicate_groups WHERE group_id IN ({placeholders})",
                group_ids,
            ).fetchall()
        else:
            where, params = [], []
            if tier is not None:
                where.append("tier = ?")
                params.append(tier)
            if status:
                where.append("status = ?")
                params.append(status)
            clause = " AND ".join(where) if where else "1=1"
            groups = conn.execute(
                f"SELECT * FROM duplicate_groups WHERE {clause} ORDER BY score DESC",
                params,
            ).fetchall()

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(_export_columns())

        for group in groups:
            members = conn.execute(
                """SELECT a.*, gm.role FROM accounts a
                   JOIN group_members gm ON a.id = gm.account_id
                   WHERE gm.group_id = ?
                   ORDER BY gm.is_master DESC""",
                (group["group_id"],),
            ).fetchall()
            member_ids = [member["id"] for member in members]
            match_values = _match_value_map(conn, member_ids)
            match_type_labels = ", ".join(
                match_type_label(match_type)
                for match_type in json.loads(group["match_types"] or "[]")
            )

            for member in members:
                writer.writerow(
                    [
                        group["group_id"],
                        group["tier"],
                        f'{group["score"]:.0f}',
                        match_type_labels,
                        group["recommended_action"],
                        group["explanation"],
                        group["status"],
                        member["id"],
                        member["name"],
                        member["website"],
                        member["owner_name"],
                        member["account_stage"],
                        member["billing_country"],
                        member["type"],
                        member["industry"],
                        *[
                            match_values.get(member["id"], {}).get(rule["name"], "")
                            for rule in MATCH_RULES
                        ],
                        member["arr"] or "",
                        member["current_arr"] or "",
                        member["role"],
                    ]
                )

        output.seek(0)
        return StreamingResponse(
            output,
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=duplicate_groups.csv"},
        )
    finally:
        conn.close()
