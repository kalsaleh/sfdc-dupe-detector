"""API routes for dashboard stats."""

from fastapi import APIRouter
from backend.models import DashboardResponse
from backend.db import get_conn

router = APIRouter()


@router.get("/dashboard", response_model=DashboardResponse)
async def dashboard():
    conn = get_conn()
    try:
        total_accounts = conn.execute("SELECT COUNT(*) as cnt FROM accounts").fetchone()["cnt"]

        stats = conn.execute("""
            SELECT
                COUNT(*) as total_groups,
                SUM(CASE WHEN tier = 1 THEN 1 ELSE 0 END) as tier1,
                SUM(CASE WHEN tier = 2 THEN 1 ELSE 0 END) as tier2,
                SUM(CASE WHEN tier = 3 THEN 1 ELSE 0 END) as tier3,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'merged' THEN 1 ELSE 0 END) as merged,
                SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) as dismissed,
                SUM(CASE WHEN recommended_action = 'set_parent' THEN 1 ELSE 0 END) as parent_child,
                SUM(CASE WHEN has_service_owner = 1 AND status = 'pending' THEN 1 ELSE 0 END) as service_owner
            FROM duplicate_groups
        """).fetchone()

        return DashboardResponse(
            total_accounts=total_accounts,
            total_groups=stats["total_groups"] or 0,
            tier1_count=stats["tier1"] or 0,
            tier2_count=stats["tier2"] or 0,
            tier3_count=stats["tier3"] or 0,
            pending_count=stats["pending"] or 0,
            merged_count=stats["merged"] or 0,
            dismissed_count=stats["dismissed"] or 0,
            parent_child_count=stats["parent_child"] or 0,
            service_owner_count=stats["service_owner"] or 0,
        )
    finally:
        conn.close()
