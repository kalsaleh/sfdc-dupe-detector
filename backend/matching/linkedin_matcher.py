"""Compatibility wrapper for the configurable LinkedIn matcher."""

from __future__ import annotations

from backend.matching.key_matcher import find_duplicates_for_match_type


def find_linkedin_duplicates() -> list[dict]:
    return find_duplicates_for_match_type("linkedin")


def find_linkedin_conflicts() -> list[dict]:
    return []
