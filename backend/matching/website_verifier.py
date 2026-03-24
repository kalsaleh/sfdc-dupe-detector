"""Headless-browser website verification.

Uses Playwright (Chromium) to follow all redirects — including JS/meta-refresh —
and determine whether two website URLs actually resolve to the same company site.

Results are cached in the ``website_verify_cache`` table so each URL is only
fetched once.  A background worker runs verification for every duplicate group
that has a website signal (or has member accounts with websites we haven't
checked yet).
"""

from __future__ import annotations

import json
import logging
from urllib.parse import urlparse

from backend.db import get_conn

log = logging.getLogger(__name__)

TIMEOUT_MS = 10_000  # 10 s per page


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _to_https(url: str) -> str:
    """Ensure the URL has a scheme so Playwright can open it."""
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def _bare_domain(url: str) -> str:
    """Return lowercase hostname without www. prefix."""
    try:
        host = urlparse(url).netloc or urlparse("//" + url).netloc
        return host.lower().lstrip("www.").rstrip(".")
    except Exception:
        return url.lower().lstrip("www.").rstrip(".")


def _extract_page_meta(page) -> dict:
    """Extract canonical URL and og:url from the live page DOM."""
    try:
        return page.evaluate("""
            () => {
                const canonical = document.querySelector('link[rel="canonical"]');
                const ogUrl     = document.querySelector('meta[property="og:url"]');
                return {
                    canonical: canonical ? canonical.href : null,
                    og_url:    ogUrl     ? ogUrl.content  : null,
                };
            }
        """)
    except Exception:
        return {"canonical": None, "og_url": None}


# ---------------------------------------------------------------------------
# Core: resolve a single URL
# ---------------------------------------------------------------------------

def resolve_site(raw_url: str) -> dict:
    """Return resolution info for *raw_url*, using the cache when available.

    Returned dict always has:
        input_url   : the URL we were asked to resolve
        final_url   : URL after all redirects  (None on error)
        final_domain: bare domain of final_url (None on error)
        title       : page <title>             (None on error)
        canonical   : <link rel=canonical>     (None if absent)
        og_url      : <meta og:url>            (None if absent)
        error       : error string             (None on success)
    """
    url = _to_https(raw_url)

    # --- cache lookup ---
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT result_json FROM website_verify_cache WHERE input_url = ?", (url,)
        ).fetchone()
        if row:
            return json.loads(row["result_json"])
    finally:
        conn.close()

    # --- headless fetch ---
    result: dict = {
        "input_url": url,
        "final_url": None,
        "final_domain": None,
        "title": None,
        "canonical": None,
        "og_url": None,
        "error": None,
    }

    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout  # noqa: PLC0415

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                ctx = browser.new_context(
                    user_agent=(
                        "Mozilla/5.0 (compatible; DupeDetector/1.0; "
                        "+https://github.com/your-org/sfdc-dupe-detect)"
                    ),
                    ignore_https_errors=True,
                )
                page = ctx.new_page()
                try:
                    page.goto(url, timeout=TIMEOUT_MS, wait_until="domcontentloaded")
                    result["final_url"] = page.url
                    result["final_domain"] = _bare_domain(page.url)
                    result["title"] = page.title()
                    meta = _extract_page_meta(page)
                    result["canonical"] = meta.get("canonical")
                    result["og_url"] = meta.get("og_url")
                except PWTimeout:
                    result["error"] = "timeout"
                except Exception as exc:
                    result["error"] = str(exc)
                finally:
                    page.close()
                    ctx.close()
            finally:
                browser.close()

    except ImportError:
        result["error"] = "playwright_not_installed"
    except Exception as exc:
        result["error"] = str(exc)

    # --- cache write ---
    conn = get_conn()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO website_verify_cache (input_url, result_json) VALUES (?, ?)",
            (url, json.dumps(result)),
        )
        conn.commit()
    finally:
        conn.close()

    return result


# ---------------------------------------------------------------------------
# Core: compare two sites
# ---------------------------------------------------------------------------

def sites_match(url_a: str, url_b: str) -> dict:
    """Resolve *url_a* and *url_b* and decide if they are the same company site.

    Returns::

        {
            "match":      True | False | None,   # None = inconclusive
            "confidence": 0.0–1.0,
            "reason":     str,
            "site_a":     dict,                  # resolve_site result
            "site_b":     dict,
        }
    """
    site_a = resolve_site(url_a)
    site_b = resolve_site(url_b)

    base = {"site_a": site_a, "site_b": site_b}

    # Can't conclude if either failed
    if site_a.get("error") or site_b.get("error"):
        return {**base, "match": None, "confidence": 0.0,
                "reason": f"resolve error — a:{site_a.get('error')} b:{site_b.get('error')}"}

    domain_a = site_a.get("final_domain") or ""
    domain_b = site_b.get("final_domain") or ""

    if not domain_a or not domain_b:
        return {**base, "match": None, "confidence": 0.0, "reason": "could not determine final domain"}

    # 1. Final domains are identical
    if domain_a == domain_b:
        return {**base, "match": True, "confidence": 1.0,
                "reason": f"both resolve to {domain_a}"}

    # 2. Canonical URLs share a domain
    def _canon_domain(site: dict) -> str | None:
        for key in ("canonical", "og_url"):
            val = site.get(key)
            if val:
                d = _bare_domain(val)
                if d:
                    return d
        return None

    can_a = _canon_domain(site_a)
    can_b = _canon_domain(site_b)
    if can_a and can_b and can_a == can_b:
        return {**base, "match": True, "confidence": 0.9,
                "reason": f"canonical URLs share domain {can_a}"}

    # 3. One canonical points to the other's domain
    if can_a and can_a == domain_b:
        return {**base, "match": True, "confidence": 0.85,
                "reason": f"{url_a} canonical points to {domain_b}"}
    if can_b and can_b == domain_a:
        return {**base, "match": True, "confidence": 0.85,
                "reason": f"{url_b} canonical points to {domain_a}"}

    # 4. Confirmed mismatch
    return {**base, "match": False, "confidence": 0.9,
            "reason": f"different final domains: {domain_a} vs {domain_b}"}


# ---------------------------------------------------------------------------
# Batch verification worker
# ---------------------------------------------------------------------------

def verify_all_groups(status_cb=None) -> dict:
    """Verify website consistency for every duplicate group.

    For *website* groups: confirms all members resolve to the same domain.
    For *name-only* groups: checks if members' websites happen to resolve to
    the same destination — if so, marks as ``website_verified``.

    Updates ``duplicate_groups.website_verified`` and
    ``duplicate_groups.website_verify_detail``.

    *status_cb(message: str)* is called with progress updates if provided.
    """
    conn = get_conn()
    try:
        groups = conn.execute(
            "SELECT group_id, match_types FROM duplicate_groups"
        ).fetchall()
    finally:
        conn.close()

    total = len(groups)
    confirmed = denied = inconclusive = 0

    for idx, grp in enumerate(groups):
        group_id = grp["group_id"]
        match_types = set(json.loads(grp["match_types"] or "[]"))

        if status_cb:
            status_cb(f"Verifying group {idx + 1}/{total}…")

        # Get the raw websites of all member accounts
        conn = get_conn()
        try:
            members = conn.execute(
                """SELECT a.website
                   FROM group_members gm
                   JOIN accounts a ON a.id = gm.account_id
                   WHERE gm.group_id = ?
                     AND a.website IS NOT NULL AND a.website != ''""",
                (group_id,),
            ).fetchall()
        finally:
            conn.close()

        websites = [m["website"] for m in members]

        if len(websites) < 2:
            # Nothing to verify
            _write_verification(group_id, None, "insufficient_websites", match_types)
            inconclusive += 1
            continue

        # Compare every pair — all must match for the group to be confirmed
        pair_results = []
        for i in range(len(websites)):
            for j in range(i + 1, len(websites)):
                result = sites_match(websites[i], websites[j])
                pair_results.append({
                    "url_a": websites[i],
                    "url_b": websites[j],
                    "match": result["match"],
                    "confidence": result["confidence"],
                    "reason": result["reason"],
                })

        # Aggregate: any definitive False → not confirmed; any None → inconclusive
        matches = [r["match"] for r in pair_results]
        if False in matches:
            verified = 0
            summary = "one or more pairs resolve to different domains"
            denied += 1
        elif None in matches:
            verified = None
            summary = "could not resolve all websites"
            inconclusive += 1
        else:
            verified = 1
            summary = "all member websites resolve to the same destination"
            confirmed += 1

        detail = json.dumps({"summary": summary, "pairs": pair_results})
        _write_verification(group_id, verified, summary, match_types, detail)

    return {"total": total, "confirmed": confirmed, "denied": denied,
            "inconclusive": inconclusive}


def _write_verification(
    group_id: int,
    verified: int | None,
    summary: str,
    existing_match_types: set,
    detail: str | None = None,
):
    """Persist verification result and adjust score/match_types if needed."""
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT score, tier, match_types FROM duplicate_groups WHERE group_id = ?",
            (group_id,),
        ).fetchone()
        if not row:
            return

        score = row["score"]
        tier = row["tier"]
        match_types = set(json.loads(row["match_types"] or "[]"))

        if verified == 1:
            # Boost: confirmed by browser
            match_types.add("website_verified")
            score = min(100, score + 3)
        elif verified == 0:
            # Penalty: browser says different destinations
            match_types.discard("website")
            match_types.discard("website_verified")
            score = max(0, score - 15)

        from backend.config import TIER1_MIN, TIER2_MIN  # noqa: PLC0415
        if score >= TIER1_MIN:
            tier = 1
        elif score >= TIER2_MIN:
            tier = 2
        else:
            tier = 3

        conn.execute(
            """UPDATE duplicate_groups
               SET website_verified = ?,
                   website_verify_detail = ?,
                   score = ?,
                   tier = ?,
                   match_types = ?
               WHERE group_id = ?""",
            (
                verified,
                detail or summary,
                score,
                tier,
                json.dumps(sorted(match_types)),
                group_id,
            ),
        )
        conn.commit()
    finally:
        conn.close()
