"""Export accounts via sf CLI Bulk API 2.0."""

from __future__ import annotations

import subprocess
import json
import csv
import os
from pathlib import Path
from backend.config import SF_TARGET_ORG, EXPORT_DIR, ACCOUNT_SOQL, USER_SOQL


class ExportStatus:
    def __init__(self):
        self.status = "idle"
        self.message = ""
        self.account_count = 0

    def to_dict(self):
        return {
            "status": self.status,
            "message": self.message,
            "account_count": self.account_count,
        }


_status = ExportStatus()


def get_export_status() -> ExportStatus:
    return _status


def run_export(incremental: bool = False, last_modified_after: str | None = None):
    """Run bulk export of accounts and users."""
    global _status
    _status.status = "exporting"
    _status.message = "Starting bulk export..."

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    accounts_csv = EXPORT_DIR / "accounts.csv"
    users_csv = EXPORT_DIR / "users.csv"

    try:
        # Build SOQL
        soql = ACCOUNT_SOQL
        if incremental and last_modified_after:
            # Convert SQLite datetime format to ISO 8601 for SOQL
            # SQLite: "2017-01-01 12:34:56" → SOQL: "2017-01-01T12:34:56Z"
            iso_date = last_modified_after.replace(" ", "T") + "Z"
            soql += f" WHERE LastModifiedDate > {iso_date}"

        # Export accounts
        _status.message = "Exporting accounts via Bulk API 2.0..."
        _run_sf_export(soql, accounts_csv)

        # Count exported rows
        with open(accounts_csv) as f:
            reader = csv.reader(f)
            next(reader)  # skip header
            count = sum(1 for _ in reader)
        _status.account_count = count
        _status.message = f"Exported {count} accounts. Exporting users..."

        # Export users (small table, still use bulk for consistency)
        _run_sf_export(USER_SOQL, users_csv)

        _status.status = "exported"
        _status.message = f"Export complete: {count} accounts"
        return accounts_csv, users_csv

    except Exception as e:
        _status.status = "error"
        _status.message = str(e)
        raise


def _run_sf_export(soql: str, output_path: Path):
    """Run sf data export bulk and save result CSV."""
    result = subprocess.run(
        [
            "sf", "data", "export", "bulk",
            "--query", soql,
            "--target-org", SF_TARGET_ORG,
            "--result-format", "csv",
            "--output-file", str(output_path),
            "--wait", "10",
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        # Fallback: try sf data query with bulk
        result2 = subprocess.run(
            [
                "sf", "data", "query",
                "--query", soql,
                "--target-org", SF_TARGET_ORG,
                "--result-format", "csv",
                "--bulk",
                "--wait", "10",
            ],
            capture_output=True, text=True,
        )
        if result2.returncode != 0:
            raise RuntimeError(
                f"sf export failed: {result.stderr or result2.stderr}"
            )
        # sf data query --bulk writes to stdout
        with open(output_path, "w") as f:
            f.write(result2.stdout)
