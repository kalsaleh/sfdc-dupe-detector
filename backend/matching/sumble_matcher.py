"""Compatibility wrapper for the configurable Sumble matcher."""

from __future__ import annotations

from backend.matching.key_matcher import find_duplicates_for_match_type


def find_sumble_duplicates() -> list[dict]:
    return find_duplicates_for_match_type("sumble")
