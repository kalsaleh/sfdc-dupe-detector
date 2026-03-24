from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / os.getenv("DB_PATH", "data/dupes.db")
EXPORT_DIR = BASE_DIR / os.getenv("EXPORT_DIR", "data/exports")
SF_TARGET_ORG = os.getenv("SF_TARGET_ORG", "prod")
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))

_raw_match_config_path = Path(os.getenv("MATCH_CONFIG_PATH", "config/matching_rules.json"))
MATCH_CONFIG_PATH = (
    _raw_match_config_path
    if _raw_match_config_path.is_absolute()
    else BASE_DIR / _raw_match_config_path
)

# Matching thresholds
FUZZY_MIN_SCORE = 85
TIER1_MIN = 95
TIER2_MIN = 80
MAX_BLOCK_SIZE = 500

BASE_ACCOUNT_FIELDS = ["Id", "Name", "Website", "OwnerId"]
DEFAULT_ACCOUNT_FIELDS = [
    "Type",
    "Industry",
    "Account_Stage__c",
    "BillingCountry",
    "ARR__c",
    "Current_ARR__c",
    "Customer_Health__c",
    "CreatedDate",
    "LastModifiedDate",
]

DEFAULT_MATCH_RULES = [
    {
        "name": "sumble",
        "label": "Sumble Org ID",
        "fields": ["Sumble_Org_Id__c"],
        "normalizer": "clean",
        "base_score": 99,
        "cross_signal_bonus": 10,
    },
    {
        "name": "linkedin",
        "label": "LinkedIn Company",
        "fields": [
            "LID__LinkedIn_Company_Id__c",
            "LinkedIn_Company_Page__c",
            "Sumble_Linkedin_Url__c",
            "Sumble_Linkedin_Company_Id__c",
        ],
        "normalizer": "linkedin_company",
        "base_score": 90,
        "cross_signal_bonus": 7,
    },
]

DEFAULT_MATCH_CONFIG = {
    "account_fields": DEFAULT_ACCOUNT_FIELDS,
    "match_rules": DEFAULT_MATCH_RULES,
    "service_owner_prefixes": ["SVC"],
    "admin_owner_names": [],
}


def _dedupe_preserve_order(values: list[str]) -> list[str]:
    seen = set()
    ordered: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def _as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        cleaned = value.strip()
        return [cleaned] if cleaned else []
    return [str(value).strip()]


def _normalize_rule(rule: dict) -> dict:
    name = str(rule.get("name", "")).strip().lower().replace(" ", "_")
    if not name:
        raise ValueError("Each match rule needs a non-empty name")

    fields = _as_list(rule.get("fields")) or _as_list(rule.get("field"))
    fields = _dedupe_preserve_order(fields)
    if not fields:
        raise ValueError(f"Match rule '{name}' must define at least one Salesforce field")

    label = str(rule.get("label") or name.replace("_", " ").title()).strip()
    normalizer = str(rule.get("normalizer", "clean")).strip().lower()
    if normalizer not in {"clean", "lower", "linkedin_company"}:
        raise ValueError(
            f"Match rule '{name}' uses unsupported normalizer '{normalizer}'"
        )

    base_score = int(rule.get("base_score", 90))
    cross_signal_bonus = int(rule.get("cross_signal_bonus", 5))

    return {
        "name": name,
        "label": label,
        "fields": fields,
        "normalizer": normalizer,
        "base_score": base_score,
        "cross_signal_bonus": cross_signal_bonus,
    }


def _load_match_config() -> dict:
    config = {
        "account_fields": list(DEFAULT_MATCH_CONFIG["account_fields"]),
        "match_rules": [dict(rule) for rule in DEFAULT_MATCH_CONFIG["match_rules"]],
        "service_owner_prefixes": list(DEFAULT_MATCH_CONFIG["service_owner_prefixes"]),
        "admin_owner_names": list(DEFAULT_MATCH_CONFIG["admin_owner_names"]),
    }

    if MATCH_CONFIG_PATH.exists():
        user_config = json.loads(MATCH_CONFIG_PATH.read_text(encoding="utf-8"))
        if user_config.get("account_fields") is not None:
            config["account_fields"] = _as_list(user_config.get("account_fields"))
        if user_config.get("match_rules") is not None:
            config["match_rules"] = list(user_config.get("match_rules") or [])
        if user_config.get("service_owner_prefixes") is not None:
            config["service_owner_prefixes"] = _as_list(
                user_config.get("service_owner_prefixes")
            )
        if user_config.get("admin_owner_names") is not None:
            config["admin_owner_names"] = _as_list(user_config.get("admin_owner_names"))

    normalized_rules = [_normalize_rule(rule) for rule in config["match_rules"]]
    rule_names = [rule["name"] for rule in normalized_rules]
    if len(rule_names) != len(set(rule_names)):
        raise ValueError("Match rule names must be unique")

    config["account_fields"] = _dedupe_preserve_order(
        _as_list(config["account_fields"])
    )
    config["match_rules"] = normalized_rules
    config["service_owner_prefixes"] = _dedupe_preserve_order(
        [item.upper() for item in _as_list(config["service_owner_prefixes"])]
    )
    config["admin_owner_names"] = _dedupe_preserve_order(
        _as_list(config["admin_owner_names"])
    )
    return config


MATCH_CONFIG = _load_match_config()
MATCH_RULES = MATCH_CONFIG["match_rules"]
MATCH_RULES_BY_NAME = {rule["name"]: rule for rule in MATCH_RULES}
CONFIGURED_MATCH_TYPES = [rule["name"] for rule in MATCH_RULES]
MATCH_TYPE_LABELS = {
    "website": "Website",
    "name": "Name Similarity",
    "website_verified": "Website Verified",
    **{rule["name"]: rule["label"] for rule in MATCH_RULES},
}
MATCH_TYPE_BASE_SCORES = {
    "website": 95,
    "name": 70,
    **{rule["name"]: rule["base_score"] for rule in MATCH_RULES},
}
MATCH_TYPE_BONUSES = {
    "website": 8,
    "name": 3,
    **{rule["name"]: rule["cross_signal_bonus"] for rule in MATCH_RULES},
}
DEFAULT_MATCH_TYPES = ["website", *CONFIGURED_MATCH_TYPES, "name"]
DETERMINISTIC_MATCH_TYPES = {"website", *CONFIGURED_MATCH_TYPES}

ACCOUNT_FIELDS = _dedupe_preserve_order(
    BASE_ACCOUNT_FIELDS
    + MATCH_CONFIG["account_fields"]
    + [field for rule in MATCH_RULES for field in rule["fields"]]
)
ACCOUNT_SOQL = "SELECT {} FROM Account".format(", ".join(ACCOUNT_FIELDS))
USER_SOQL = "SELECT Id, Name FROM User"

# Parent-child detection: only trigger name-based parent-child for these suffixes
PARENT_CHILD_SUFFIXES = {
    "uk", "us", "usa", "india", "japan", "china", "korea", "brazil",
    "canada", "australia", "germany", "france", "spain", "italy",
    "mexico", "singapore", "ireland", "israel", "netherlands",
    "emea", "apac", "latam", "anz", "mena", "americas", "europe",
    "asia", "africa", "na",
    "global", "international", "intl", "holdings",
}

SERVICE_OWNER_PREFIXES = MATCH_CONFIG["service_owner_prefixes"]
ADMIN_OWNER_NAMES = MATCH_CONFIG["admin_owner_names"]


def match_type_label(match_type: str) -> str:
    return MATCH_TYPE_LABELS.get(match_type, match_type.replace("_", " ").title())


def match_type_base_score(match_type: str) -> int:
    return MATCH_TYPE_BASE_SCORES.get(match_type, 70)


def match_type_bonus(match_type: str) -> int:
    return MATCH_TYPE_BONUSES.get(match_type, 2)


def is_service_or_admin_owner(owner_name: str | None) -> bool:
    """Return True if the owner is a service account or admin."""
    if not owner_name:
        return False
    name = owner_name.strip()
    for prefix in SERVICE_OWNER_PREFIXES:
        if name.upper().startswith(prefix.upper()):
            return True
    for admin in ADMIN_OWNER_NAMES:
        if name.lower() == admin.lower():
            return True
    return False
