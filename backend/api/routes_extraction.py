"""API routes for data extraction."""

import threading
from fastapi import APIRouter
from backend.models import ExtractStartRequest, ExtractStatusResponse
from backend.extraction.bulk_export import run_export, get_export_status
from backend.extraction.loader import load_exports
from backend.db import get_conn

router = APIRouter()


@router.post("/extract/start")
async def start_extraction(req: ExtractStartRequest):
    status = get_export_status()
    if status.status in ("exporting", "loading"):
        return {"message": "Export already in progress"}

    def _run():
        last_mod = None
        if req.incremental:
            conn = get_conn()
            row = conn.execute("SELECT value FROM sync_metadata WHERE key = 'last_sync'").fetchone()
            conn.close()
            if row:
                last_mod = row["value"]

        accounts_csv, users_csv = run_export(req.incremental, last_mod)
        load_exports(accounts_csv, users_csv, incremental=req.incremental)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return {"message": "Export started"}


@router.get("/extract/status", response_model=ExtractStatusResponse)
async def extraction_status():
    s = get_export_status()
    return ExtractStatusResponse(**s.to_dict())
