#!/usr/bin/env python3
"""Ad-hoc Salesforce account merge script.

Merges two accounts directly via the SF SOAP API.
Requires: SF CLI authenticated with 'prod' org.

Usage:
    python merge_accounts.py
"""

import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict

import requests
from simple_salesforce import Salesforce

# Account IDs to merge (from Dylan's request)
ACCOUNT_ID_1 = "001Pz00000d3A63IAE"
ACCOUNT_ID_2 = "0018d00000dkjJdAAI"

SF_TARGET_ORG = os.getenv("SF_TARGET_ORG", "prod")

SOAP_MERGE_TEMPLATE = """\
<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Header>
    <urn:SessionHeader>
      <urn:sessionId>{session_id}</urn:sessionId>
    </urn:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <urn:merge>
      <urn:request>
        <urn:masterRecord>
          <urn:type>Account</urn:type>
          <urn:Id>{master_id}</urn:Id>
        </urn:masterRecord>
        <urn:recordToMergeIds>{victim_id}</urn:recordToMergeIds>
      </urn:request>
    </urn:merge>
  </soapenv:Body>
</soapenv:Envelope>"""


def get_sf_client() -> Salesforce:
    """Get SF client using CLI auth."""
    _ansi_re = re.compile(r'\x1b\[[0-9;]*m')
    env = {**os.environ, "NO_COLOR": "1", "FORCE_COLOR": "0", "SF_NO_COLOR": "1"}

    try:
        result = subprocess.run(
            ["sf", "org", "display", "--target-org", SF_TARGET_ORG, "--json"],
            capture_output=True, text=True, check=True, env=env,
        )
    except subprocess.CalledProcessError as e:
        print(f"ERROR: SF CLI failed. Re-authenticate with: sf org login web --alias {SF_TARGET_ORG}")
        print(f"stderr: {e.stderr[:500] if e.stderr else 'none'}")
        sys.exit(1)
    except FileNotFoundError:
        print("ERROR: SF CLI not found. Install with: npm install -g @salesforce/cli")
        sys.exit(1)

    stdout = _ansi_re.sub('', result.stdout).strip()
    org_info = json.loads(stdout)["result"]
    return Salesforce(
        instance_url=org_info["instanceUrl"],
        session_id=org_info["accessToken"],
    )


def clean_overlapping_acrs(sf, master_id: str, victim_id: str) -> int:
    """Delete duplicate AccountContactRelations before merge."""
    all_ids = [master_id, victim_id]
    id_list = "','".join(all_ids)
    all_acrs = sf.query_all(
        f"SELECT Id, AccountId, ContactId, IsDirect FROM AccountContactRelation "
        f"WHERE AccountId IN ('{id_list}')"
    ).get("records", [])

    if not all_acrs:
        return 0

    by_contact = defaultdict(list)
    for acr in all_acrs:
        by_contact[acr["ContactId"]].append(acr)

    to_delete = []
    for contact_id, acrs in by_contact.items():
        if len(acrs) <= 1:
            continue

        direct = [a for a in acrs if a.get("IsDirect")]
        indirect = [a for a in acrs if not a.get("IsDirect")]

        if direct:
            to_delete.extend(indirect)
        else:
            master_acr = next((a for a in indirect if a["AccountId"] == master_id), None)
            if master_acr:
                to_delete.extend(a for a in indirect if a["Id"] != master_acr["Id"])
            else:
                to_delete.extend(indirect[1:])

    deleted = 0
    for acr in to_delete:
        try:
            sf.AccountContactRelation.delete(acr["Id"])
            deleted += 1
        except Exception as e:
            print(f"  Warning: Could not delete ACR {acr['Id']}: {e}")

    return deleted


def parse_merge_response(xml_text: str) -> dict:
    """Parse the SOAP merge response."""
    root = ET.fromstring(xml_text)
    ns = {
        "soapenv": "http://schemas.xmlsoap.org/soap/envelope/",
        "sf": "urn:partner.soap.sforce.com",
    }

    fault = root.find(".//soapenv:Body/soapenv:Fault", ns)
    if fault is not None:
        return {"success": False, "error": fault.findtext("faultstring", "Unknown SOAP fault")}

    result = root.find(".//sf:mergeResponse/sf:result", ns)
    if result is None:
        return {"success": False, "error": "No mergeResponse in SOAP reply"}

    success = result.findtext("sf:success", "false", ns).lower() == "true"
    merged_ids = [el.text for el in result.findall("sf:mergedRecordIds", ns)]
    errors = []
    for err in result.findall("sf:errors", ns):
        errors.append({
            "statusCode": err.findtext("sf:statusCode", "", ns),
            "message": err.findtext("sf:message", "", ns),
        })

    return {"success": success, "mergedRecordIds": merged_ids, "errors": errors}


def merge_accounts(sf, master_id: str, victim_id: str) -> dict:
    """Execute the SOAP merge."""
    # Clean overlapping ACRs first
    acr_cleaned = clean_overlapping_acrs(sf, master_id, victim_id)
    if acr_cleaned:
        print(f"  Cleaned {acr_cleaned} overlapping ACRs")

    # Check for parent-child links and break them
    id_list = "','".join([master_id, victim_id])
    live = sf.query(
        f"SELECT Id, ParentId FROM Account WHERE Id IN ('{id_list}') AND IsDeleted = false"
    ).get("records", [])

    merge_set = {master_id, victim_id}
    for rec in live:
        if rec.get("ParentId") and rec["ParentId"] in merge_set:
            print(f"  Breaking parent-child link on {rec['Id']}")
            sf.Account.update(rec["Id"], {"ParentId": None})

    # Execute SOAP merge
    soap_url = f"https://{sf.sf_instance}/services/Soap/u/{sf.sf_version}"
    headers = {"Content-Type": "text/xml; charset=UTF-8", "SOAPAction": "merge"}

    body = SOAP_MERGE_TEMPLATE.format(
        session_id=sf.session_id,
        master_id=master_id,
        victim_id=victim_id,
    )

    resp = requests.post(soap_url, data=body.encode("utf-8"), headers=headers)
    return parse_merge_response(resp.text)


def main():
    print("Salesforce Account Merge")
    print("=" * 50)
    print(f"Account 1: {ACCOUNT_ID_1}")
    print(f"Account 2: {ACCOUNT_ID_2}")
    print()

    print("Connecting to Salesforce...")
    sf = get_sf_client()
    print(f"Connected to {sf.sf_instance}")
    print()

    # Fetch account details to determine master
    print("Fetching account details...")
    id_list = f"'{ACCOUNT_ID_1}','{ACCOUNT_ID_2}'"
    accounts = sf.query(
        f"SELECT Id, Name, OwnerId, Owner.Name, Type, CreatedDate "
        f"FROM Account WHERE Id IN ({id_list})"
    ).get("records", [])

    if len(accounts) != 2:
        missing = set([ACCOUNT_ID_1, ACCOUNT_ID_2]) - set(a["Id"] for a in accounts)
        print(f"ERROR: Could not find account(s): {missing}")
        print("They may have already been merged or deleted.")
        sys.exit(1)

    print()
    for acc in accounts:
        owner = acc.get("Owner", {}).get("Name", "Unknown")
        print(f"  {acc['Id']}")
        print(f"    Name: {acc['Name']}")
        print(f"    Owner: {owner}")
        print(f"    Type: {acc.get('Type', 'N/A')}")
        print(f"    Created: {acc.get('CreatedDate', 'N/A')}")
        print()

    # Determine master: prefer account owned by Nicholas Neubner
    master = None
    victim = None
    for acc in accounts:
        owner_name = acc.get("Owner", {}).get("Name", "")
        if "Nicholas Neubner" in owner_name or "Neubner" in owner_name:
            master = acc
        else:
            victim = acc

    # If neither is owned by Nicholas, pick the first one as master
    if not master:
        master = accounts[0]
        victim = accounts[1]
    elif not victim:
        victim = accounts[0] if accounts[0]["Id"] != master["Id"] else accounts[1]

    print(f"Master (keep): {master['Name']} ({master['Id']})")
    print(f"  Owner: {master.get('Owner', {}).get('Name', 'Unknown')}")
    print()
    print(f"Victim (merge into master): {victim['Name']} ({victim['Id']})")
    print(f"  Owner: {victim.get('Owner', {}).get('Name', 'Unknown')}")
    print()

    # Confirm
    confirm = input("Proceed with merge? [y/N]: ").strip().lower()
    if confirm != 'y':
        print("Aborted.")
        sys.exit(0)

    print()
    print("Executing merge...")
    result = merge_accounts(sf, master["Id"], victim["Id"])

    if result["success"]:
        print()
        print("SUCCESS! Accounts merged.")
        print(f"Master account: {master['Name']} ({master['Id']})")
        print(f"Merged record IDs: {result.get('mergedRecordIds', [])}")
    else:
        print()
        print("FAILED!")
        print(f"Errors: {json.dumps(result.get('errors', result.get('error')), indent=2)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
