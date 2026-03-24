"""URL and name normalization utilities."""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlparse

# Company suffixes to strip for name normalization
SUFFIXES = re.compile(
    r",?\s*\b(inc\.?|incorporated|llc|ltd\.?|limited|corp\.?|corporation|"
    r"gmbh|co\.?|company|plc|ag|sa|sas|s\.?a\.?|s\.?r\.?l\.?|"
    r"pty\.?|pvt\.?|n\.?v\.?|b\.?v\.?|oy|ab|as|a/s)\s*\.?\s*$",
    re.IGNORECASE,
)

PAREN_SUFFIX = re.compile(r"\s*\(.*?\)\s*$")
PUNCT = re.compile(r"[^\w\s]")
MULTI_SPACE = re.compile(r"\s+")


def normalize_website(url: str | None) -> str | None:
    if not url:
        return None
    url = url.strip().lower()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    try:
        parsed = urlparse(url)
        host = parsed.hostname or ""
    except Exception:
        host = url
    host = host.removeprefix("www.")
    host = host.rstrip("/")
    return host if host else None


def extract_root_domain(hostname: str | None) -> str | None:
    """Extract root domain from a hostname, collapsing subdomains.

    e.g. 'shop.example.com' -> 'example.com'
         'api.us.example.co.uk' -> 'example.co.uk'
    """
    if not hostname:
        return None
    parts = hostname.split(".")
    # Handle two-part TLDs like co.uk, com.au, co.jp
    TWO_PART_TLDS = {"co.uk", "com.au", "co.jp", "co.nz", "com.br", "co.za", "com.sg", "co.in"}
    if len(parts) >= 3 and ".".join(parts[-2:]) in TWO_PART_TLDS:
        return ".".join(parts[-3:])
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return hostname


def normalize_name(name: str | None) -> str | None:
    if not name:
        return None
    n = name.strip().lower()
    # Decompose unicode and strip combining marks (accents/diacritics)
    n = unicodedata.normalize("NFKD", n)
    n = "".join(c for c in n if unicodedata.category(c) != "Mn")
    n = PAREN_SUFFIX.sub("", n)
    n = SUFFIXES.sub("", n)
    n = PUNCT.sub(" ", n)
    n = MULTI_SPACE.sub(" ", n).strip()
    return n if n else None


def extract_linkedin_id(value: str | None) -> str | None:
    """Extract a numeric LinkedIn company ID or slug from various field formats."""
    if not value:
        return None
    value = str(value).strip()
    # Pure numeric
    if value.isdigit():
        return value
    # URL format: linkedin.com/company/12345 or linkedin.com/company/slug
    m = re.search(r"linkedin\.com/company/([^/?#]+)", value, re.IGNORECASE)
    if m:
        return m.group(1).strip("/")
    # Fallback: return cleaned value if non-empty
    cleaned = value.strip("/").strip()
    return cleaned if cleaned else None
