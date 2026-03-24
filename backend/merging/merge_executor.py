"""Execute Salesforce account merges via the SOAP API.

The SF merge operation is SOAP-only — there is no REST API endpoint.
We reuse the session token from simple_salesforce and call the
Partner SOAP API directly with requests.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET

import requests as http_requests

from backend.db import get_conn
from backend.extraction.simple_sf import get_sf_client


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
        {victim_elements}
      </urn:request>
    </urn:merge>
  </soapenv:Body>
</soapenv:Envelope>"""


def _build_victim_xml(victim_ids: list) -> str:
    return "\n        ".join(
        f"<urn:recordToMergeIds>{vid}</urn:recordToMergeIds>"
        for vid in victim_ids
    )


def _parse_merge_response(xml_text: str) -> dict:
    """Parse the SOAP merge response XML into a simple dict."""
    root = ET.fromstring(xml_text)
    ns = {
        "soapenv": "http://schemas.xmlsoap.org/soap/envelope/",
        "sf": "urn:partner.soap.sforce.com",
    }

    # Check for SOAP fault first
    fault = root.find(".//soapenv:Body/soapenv:Fault", ns)
    if fault is not None:
        faultstring = fault.findtext("faultstring", "Unknown SOAP fault")
        return {"success": False, "error": faultstring}

    # Parse merge result
    result = root.find(".//sf:mergeResponse/sf:result", ns)
    if result is None:
        return {"success": False, "error": "No mergeResponse in SOAP reply"}

    success = result.findtext("sf:success", "false", ns).lower() == "true"
    merged_ids = [el.text for el in result.findall("sf:mergedRecordIds", ns)]

    errors = []
    for err in result.findall("sf:errors", ns):
        msg = err.findtext("sf:message", "", ns)
        code = err.findtext("sf:statusCode", "", ns)
        errors.append({"statusCode": code, "message": msg})

    return {
        "success": success,
        "mergedRecordIds": merged_ids,
        "errors": errors,
    }


def _clean_overlapping_acrs(sf, master_id: str, victim_ids: list) -> int:
    """Delete duplicate AccountContactRelations across all accounts in the merge.

    The SF SOAP merge fails with MERGE_FAILED when any two accounts in the
    merge (master or victim) share a contact via AccountContactRelation.

    Key complexity: Direct ACRs (IsDirect=true, created from Contact.AccountId)
    CANNOT be deleted. Only indirect ACRs can be deleted. So when a contact
    overlaps between a direct ACR and an indirect ACR, we must delete the
    indirect one — even if it's on the master account.

    Returns the number of deleted ACR records.
    """
    import logging
    from collections import defaultdict
    log = logging.getLogger(__name__)

    # 1. Get all ACRs across master + all victims, including IsDirect flag
    all_account_ids = [master_id] + victim_ids
    id_list = "','".join(all_account_ids)
    all_acrs = sf.query_all(
        f"SELECT Id, AccountId, ContactId, IsDirect FROM AccountContactRelation "
        f"WHERE AccountId IN ('{id_list}')"
    ).get("records", [])

    if not all_acrs:
        return 0

    # 2. Group ACRs by ContactId to find duplicates
    by_contact = defaultdict(list)
    for acr in all_acrs:
        by_contact[acr["ContactId"]].append(acr)

    # 3. For each contact on 2+ accounts, figure out which ACRs to delete.
    #    Rules:
    #    - Direct ACRs (IsDirect=true) can NEVER be deleted — always keep them
    #    - Among indirect ACRs, prefer keeping master's
    #    - Delete all other indirect ACRs
    to_delete = []
    for contact_id, acrs in by_contact.items():
        if len(acrs) <= 1:
            continue

        direct = [a for a in acrs if a.get("IsDirect")]
        indirect = [a for a in acrs if not a.get("IsDirect")]

        # We must keep all direct ACRs (can't delete them).
        # Delete indirect ACRs that conflict with a direct or with each other.
        if direct:
            # There's at least one direct ACR — delete ALL indirect ones for this contact
            to_delete.extend(indirect)
        else:
            # All are indirect — keep master's if present, otherwise keep first
            master_acr = next((a for a in indirect if a["AccountId"] == master_id), None)
            if master_acr:
                to_delete.extend(a for a in indirect if a["Id"] != master_acr["Id"])
            else:
                to_delete.extend(indirect[1:])

    if not to_delete:
        return 0

    # 4. Delete indirect ACRs one by one
    deleted = 0
    failed = 0
    for acr in to_delete:
        try:
            sf.AccountContactRelation.delete(acr["Id"])
            deleted += 1
        except Exception as exc:
            failed += 1
            log.warning("Failed to delete ACR %s (Contact %s on Account %s): %s",
                        acr["Id"], acr["ContactId"], acr["AccountId"], exc)

    log.info("Cleaned %d/%d overlapping ACRs before merge into %s (failed: %d)",
             deleted, len(to_delete), master_id, failed)
    return deleted


def execute_merge(group_id: int, master_id: str, victim_ids: list | None = None) -> dict:
    """Merge accounts in a duplicate group via SF SOAP API.

    SF merge supports max 2 victims per call (3 records total).
    For groups > 3 accounts, we batch into sequential merge calls.
    If victim_ids is provided, only those accounts are merged (selective merge).

    Returns {success, message, merge_log_id}
    """
    conn = get_conn()
    _victim_ids = []
    try:
        members = conn.execute(
            "SELECT account_id FROM group_members WHERE group_id = ?",
            (group_id,),
        ).fetchall()
        all_ids = [r["account_id"] for r in members]

        if master_id not in all_ids:
            return {"success": False, "message": f"Master {master_id} not in group"}

        if victim_ids:
            # Selective merge — validate all provided IDs are in the group
            invalid = [v for v in victim_ids if v not in all_ids]
            if invalid:
                return {"success": False, "message": f"IDs not in group: {invalid}"}
            _victim_ids = [v for v in victim_ids if v != master_id]
        else:
            _victim_ids = [aid for aid in all_ids if aid != master_id]

        victim_ids = _victim_ids
        if not victim_ids:
            return {"success": False, "message": "No victims to merge"}

        sf = get_sf_client()
        acr_cleaned = 0

        # Pre-check: verify accounts still exist and detect internal
        # parent-child links that would cause CIRCULAR_DEPENDENCY errors
        check_ids = [master_id] + victim_ids
        id_list = "','".join(check_ids)
        live = sf.query(
            f"SELECT Id, ParentId FROM Account WHERE Id IN ('{id_list}') AND IsDeleted = false"
        ).get("records", [])
        live_ids = {r["Id"] for r in live}

        if master_id not in live_ids:
            # Master was already merged/deleted — mark group as merged and move on
            conn.execute(
                "UPDATE duplicate_groups SET status = 'merged' WHERE group_id = ?",
                (group_id,),
            )
            conn.commit()
            return {
                "success": True,
                "message": f"Master {master_id} already merged/deleted — group auto-resolved",
            }

        victim_ids = [v for v in victim_ids if v in live_ids]
        if not victim_ids:
            conn.execute(
                "UPDATE duplicate_groups SET status = 'merged' WHERE group_id = ?",
                (group_id,),
            )
            conn.commit()
            return {
                "success": True,
                "message": "All victim accounts already merged/deleted — group auto-resolved",
            }

        # Break internal parent-child links to avoid CIRCULAR_DEPENDENCY.
        # If any account in the merge set has ParentId pointing to another
        # account in the merge set, null it out before merging.
        merge_set = set(check_ids)
        for rec in live:
            if rec.get("ParentId") and rec["ParentId"] in merge_set:
                try:
                    sf.Account.update(rec["Id"], {"ParentId": None})
                except Exception:
                    pass  # best-effort; merge may still succeed

        soap_url = f"https://{sf.sf_instance}/services/Soap/u/{sf.sf_version}"
        headers = {
            "Content-Type": "text/xml; charset=UTF-8",
            "SOAPAction": "merge",
        }

        # Batch victims in groups of 2 (SF merge limit: 3 records = 1 master + 2 victims)
        batches = [victim_ids[i:i + 2] for i in range(0, len(victim_ids), 2)]
        all_responses = []

        for batch_idx, batch in enumerate(batches):
            # Clean overlapping ACRs before each batch.
            # After batch N, the master inherits contacts from merged victims,
            # so remaining victims may now overlap with the master.
            remaining_victims = [v for b in batches[batch_idx:] for v in b]
            acr_cleaned += _clean_overlapping_acrs(sf, master_id, remaining_victims)

            body = SOAP_MERGE_TEMPLATE.format(
                session_id=sf.session_id,
                master_id=master_id,
                victim_elements=_build_victim_xml(batch),
            )

            resp = http_requests.post(soap_url, data=body.encode("utf-8"), headers=headers)
            parsed = _parse_merge_response(resp.text)
            all_responses.append(parsed)

            if not parsed["success"]:
                error_msg = json.dumps(parsed.get("errors", parsed.get("error", "Unknown")))
                _log_merge(conn, group_id, master_id, victim_ids, "failed", error_msg)
                return {"success": False, "message": f"Merge failed: {error_msg}"}

        # Success — update group status and log
        merge_log_id = _log_merge(
            conn, group_id, master_id, victim_ids, "merged",
            json.dumps(all_responses, default=str),
        )

        conn.execute(
            "UPDATE duplicate_groups SET status = 'merged' WHERE group_id = ?",
            (group_id,),
        )
        conn.execute(
            "UPDATE group_members SET is_master = 1 WHERE group_id = ? AND account_id = ?",
            (group_id, master_id),
        )
        conn.commit()

        acr_note = f" ({acr_cleaned} overlapping ACRs cleaned)" if acr_cleaned else ""
        return {
            "success": True,
            "message": f"Merged {len(victim_ids)} accounts into {master_id}{acr_note}",
            "merge_log_id": merge_log_id,
        }

    except Exception as e:
        _log_merge(conn, group_id, master_id, victim_ids, "error", str(e))
        return {"success": False, "message": str(e)}
    finally:
        conn.close()


def _log_merge(conn, group_id, master_id, victim_ids, status, response) -> int:
    cursor = conn.execute(
        """INSERT INTO merge_log (group_id, master_id, victim_ids, status, sf_response)
           VALUES (?, ?, ?, ?, ?)""",
        (group_id, master_id, json.dumps(victim_ids), status, response),
    )
    conn.commit()
    return cursor.lastrowid
