# Salesforce Duplicate Detector

A local web app for finding, reviewing, and merging duplicate Salesforce accounts.

It exports Account and User data through the Salesforce CLI you already use, runs a configurable matching pipeline, and gives you a review UI before anything is merged back into Salesforce.

## What is in this open-source copy

- App code only: backend, frontend, and configuration.
- No local databases, CSV exports, or private workspace settings.
- No bundled custom fonts.
- No embedded API keys, tokens, or Salesforce credentials.

This version authenticates through your local `sf` CLI session, so credentials stay with Salesforce CLI on your machine instead of being stored in the repo.

## Requirements

- Python 3.9+
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) installed and authenticated
- Chromium if you want headless website verification

## Quick start

### Option 1: run the setup script

```bash
bash setup.sh
```

The script will:

- create `.venv`
- install Python dependencies
- create `.env` from `.env.example` if needed
- install the Playwright Chromium browser

### Option 2: manual setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m playwright install chromium
python -m backend.main
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Environment configuration

`.env.example` contains the runtime settings:

```env
SF_TARGET_ORG=prod
DB_PATH=data/dupes.db
EXPORT_DIR=data/exports
MATCH_CONFIG_PATH=config/matching_rules.json
HOST=127.0.0.1
PORT=8000
```

`SF_TARGET_ORG` should be your Salesforce CLI alias, for example `prod`, `sandbox`, or `my-team-prod`.

## How matching works

Built-in matchers:

- `website`: same normalized website domain
- `name`: fuzzy company-name matching

Configured exact-match rules:

- anything in `config/matching_rules.json`
- defaults include `sumble` and `linkedin`

Each configured rule can point at one Salesforce field or several fields. If multiple accounts share the same normalized value, they are grouped together and scored as an exact match.

## Customizing which Salesforce fields to match

Edit `config/matching_rules.json`.

The file has two important sections:

- `account_fields`: extra fields to include in the export for display and review
- `match_rules`: exact-match rules the app should use

Each `match_rules` entry supports:

- `name`: internal match type key used in filters and stored results
- `label`: human-friendly label shown in the UI
- `fields`: one or more Salesforce fields to inspect
- `normalizer`: how to clean the value before matching
- `base_score`: starting confidence score for that matcher
- `cross_signal_bonus`: bonus added when other signals also match

Available normalizers:

- `clean`: trim whitespace, drop null-ish values, normalize `123.0` to `123`
- `lower`: same as `clean`, then lowercase the final value
- `linkedin_company`: extract a LinkedIn company slug or numeric ID from either a raw value or a LinkedIn URL

### Example: keep the defaults

```json
{
  "match_rules": [
    {
      "name": "sumble",
      "label": "Sumble Org ID",
      "fields": ["Sumble_Org_Id__c"],
      "normalizer": "clean",
      "base_score": 99,
      "cross_signal_bonus": 10
    },
    {
      "name": "linkedin",
      "label": "LinkedIn Company",
      "fields": [
        "LID__LinkedIn_Company_Id__c",
        "LinkedIn_Company_Page__c",
        "Sumble_Linkedin_Url__c",
        "Sumble_Linkedin_Company_Id__c"
      ],
      "normalizer": "linkedin_company",
      "base_score": 90,
      "cross_signal_bonus": 7
    }
  ]
}
```

### Example: use ZoomInfo instead of Sumble

```json
{
  "match_rules": [
    {
      "name": "zoominfo",
      "label": "ZoomInfo Company ID",
      "fields": ["ZoomInfo_Company_ID__c"],
      "normalizer": "clean",
      "base_score": 96,
      "cross_signal_bonus": 8
    },
    {
      "name": "linkedin",
      "label": "LinkedIn Company",
      "fields": [
        "LinkedIn_Company_Page__c",
        "LinkedIn_Company_Id__c"
      ],
      "normalizer": "linkedin_company",
      "base_score": 90,
      "cross_signal_bonus": 7
    }
  ]
}
```

### Example: use multiple CRM identifiers at once

```json
{
  "match_rules": [
    {
      "name": "sumble",
      "label": "Sumble Org ID",
      "fields": ["Sumble_Org_Id__c"],
      "normalizer": "clean",
      "base_score": 99,
      "cross_signal_bonus": 10
    },
    {
      "name": "zoominfo",
      "label": "ZoomInfo Company ID",
      "fields": ["ZoomInfo_Company_ID__c"],
      "normalizer": "clean",
      "base_score": 96,
      "cross_signal_bonus": 8
    }
  ]
}
```

After changing `config/matching_rules.json`, run a fresh extract and then run matching again so the local SQLite cache is rebuilt with the new keys.

## Security and publish checklist

Before pushing this folder to GitHub:

- Keep `.env` untracked.
- Keep `data/` untracked. It can contain exported account data and PII.
- Do not commit Salesforce export CSVs.
- Do not commit a populated SQLite database.
- Do not paste access tokens or `sf org display --json` output into docs or issues.
- Review `config/matching_rules.json` for internal field names you may not want to publish.

Commands you can run before publishing:

```bash
git status --short
rg -n --hidden --glob '!**/.git/**' --glob '!**/.venv/**' --glob '!**/venv/**' '(api[_-]?key|secret|token|password|accessToken|session_id)'
```

## How Salesforce auth works

This app does not ask for a username, password, client secret, or security token in the repo.

Instead it:

1. Uses `sf data export bulk` for exports.
2. Uses `sf org display --json` to obtain the current CLI session for merge calls.
3. Reuses that active session locally through `simple-salesforce`.

If your CLI session expires, re-authenticate with:

```bash
sf org login web --alias <your-org-alias>
```

## Notes

- Website verification is optional and uses Playwright locally.
- The default scoring is tuned for deterministic CRM IDs plus name/website support, but you can change scores in `config/matching_rules.json`.
- This open-source copy is licensed under the MIT License. See `LICENSE`.
