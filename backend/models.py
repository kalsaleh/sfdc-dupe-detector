from __future__ import annotations

from pydantic import BaseModel
from typing import Optional, List, Dict


class ExtractStartRequest(BaseModel):
    incremental: bool = False


class ExtractStatusResponse(BaseModel):
    status: str
    message: str = ""
    account_count: int = 0


class MatchRunRequest(BaseModel):
    match_types: Optional[List[str]] = None


class GroupSummary(BaseModel):
    group_id: int
    names: List[str]
    match_types: List[str]
    score: float
    tier: int
    size: int
    status: str
    recommended_action: str
    has_service_owner: bool = False
    explanation: str


class GroupListResponse(BaseModel):
    groups: List[GroupSummary]
    total: int
    page: int
    page_size: int


class AccountDetail(BaseModel):
    id: str
    name: str
    website: Optional[str] = None
    owner_name: Optional[str] = None
    type: Optional[str] = None
    industry: Optional[str] = None
    account_stage: Optional[str] = None
    billing_country: Optional[str] = None
    arr: Optional[float] = None
    current_arr: Optional[float] = None
    customer_health: Optional[str] = None
    created_date: Optional[str] = None
    last_modified_date: Optional[str] = None
    match_key_values: Optional[Dict[str, Optional[str]]] = None


class RelatedCounts(BaseModel):
    account_id: str
    opportunity_count: int = 0
    contact_count: int = 0
    case_count: int = 0


class FieldDiff(BaseModel):
    field: str
    values: Dict[str, Optional[str]]
    differs: bool


class MergePreviewResponse(BaseModel):
    group_id: int
    accounts: List[AccountDetail]
    diffs: List[FieldDiff]
    related_data: List[RelatedCounts]
    recommended_master: str
    recommended_action: str
    explanation: str


class MergeExecuteRequest(BaseModel):
    master_id: str
    victim_ids: Optional[List[str]] = None


class MergeExecuteResponse(BaseModel):
    success: bool
    message: str
    merge_log_id: Optional[int] = None


class BulkMergeRequest(BaseModel):
    group_ids: List[int]
    action: str = "merge"


class BulkMergeResponse(BaseModel):
    total: int
    succeeded: int
    failed: int
    errors: List[dict]


class DashboardResponse(BaseModel):
    total_accounts: int
    total_groups: int
    tier1_count: int
    tier2_count: int
    tier3_count: int
    pending_count: int
    merged_count: int
    dismissed_count: int
    parent_child_count: int
    service_owner_count: int = 0
