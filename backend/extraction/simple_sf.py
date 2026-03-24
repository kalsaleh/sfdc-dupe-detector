"""Get a simple_salesforce client using the sf CLI token."""

import json
import re
import subprocess
from simple_salesforce import Salesforce
from backend.config import SF_TARGET_ORG

_ANSI_RE = re.compile(r'\x1b\[[0-9;]*m')


def _strip_ansi(text: str) -> str:
    """Remove ANSI color/escape codes from text."""
    return _ANSI_RE.sub('', text)


def get_sf_client() -> Salesforce:
    env = {"NO_COLOR": "1", "FORCE_COLOR": "0", "SF_NO_COLOR": "1"}
    # Inherit PATH and other env vars
    import os
    full_env = {**os.environ, **env}

    try:
        result = subprocess.run(
            ["sf", "org", "display", "--target-org", SF_TARGET_ORG, "--json"],
            capture_output=True, text=True, check=True, env=full_env,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"SF CLI failed (exit {e.returncode}). "
            f"Re-authenticate with: sf org login web --alias {SF_TARGET_ORG}\n"
            f"stderr: {e.stderr[:500] if e.stderr else 'none'}"
        ) from e

    # Strip ANSI color codes that SF CLI sometimes injects even with --json
    stdout = _strip_ansi(result.stdout).strip()
    if not stdout:
        raise RuntimeError(
            f"SF CLI returned empty output. "
            f"Re-authenticate with: sf org login web --alias {SF_TARGET_ORG}"
        )

    try:
        org_info = json.loads(stdout)["result"]
    except (json.JSONDecodeError, KeyError) as e:
        raise RuntimeError(
            f"SF CLI returned unexpected output: {stdout[:300]}. "
            f"Re-authenticate with: sf org login web --alias {SF_TARGET_ORG}"
        ) from e

    return Salesforce(
        instance_url=org_info["instanceUrl"],
        session_id=org_info["accessToken"],
    )
