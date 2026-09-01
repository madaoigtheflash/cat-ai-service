from __future__ import annotations

import copy
import json
import math

from fastapi.testclient import TestClient

from cloud_admin.cloudbase_cli import (
    FIELD_PROJECTIONS,
    READ_COLLECTIONS,
    SourceResult,
    TcbCliSource,
)
from cloud_admin.config import AdminSettings
from cloud_admin.codex_workflow import CodexWorkflowError
from cloud_admin.main import create_app
from cloud_admin.projection import build_snapshot


def fixture_result() -> SourceResult:
    collections = {
        "ci_communities": [
            {
                "_id": "com_a",
                "name": "花园小屋",
                "scope": "invite",
                "status": "active",
                "inviteHash": "must-not-leak",
                "creatorOwnerKey": "owner-secret-a",
                "createdAt": "2026-08-01T00:00:00Z",
                "updatedAt": "2026-08-28T00:00:00Z",
            },
            {"_id": "com_b", "name": "屋顶小屋", "scope": "private", "status": "active"},
        ],
        "ci_members": [
            {"_id": "mem_a", "communityId": "com_a", "ownerKey": "owner-secret-a", "role": "owner", "status": "active"},
            {"_id": "mem_b", "communityId": "com_a", "ownerKey": "owner-secret-b", "role": "member", "status": "active"},
        ],
        "ci_user_pet_links": [
            {
                "_id": "pet_remote_a",
                "communityId": "com_a",
                "catId": "cat_a",
                "localPetId": "local-phone-secret",
                "ownerKey": "owner-secret-a",
                "displayName": "橘子",
                "breed": "中华田园猫",
                "gender": "母",
                "coatColor": "橘白",
                "state": "active",
                "updatedAt": "2026-08-27T10:00:00Z",
            },
            {
                "_id": "pet_remote_b",
                "communityId": "com_a",
                "catId": "cat_b_alias",
                "ownerKey": "owner-secret-b",
                "displayName": "奶糖",
                "state": "active",
            },
        ],
        "ci_cat_identities": [
            {"_id": "cat_a", "communityId": "com_a", "displayName": "橘子", "state": "active", "canonicalCatId": "cat_a", "source": "synced_user_pet"},
            {"_id": "cat_b_alias", "communityId": "com_a", "displayName": "奶糖旧名", "state": "merged", "canonicalCatId": "cat_b"},
            {"_id": "cat_b", "communityId": "com_a", "displayName": "奶糖", "state": "active", "canonicalCatId": "cat_b", "source": "manual_new_cat"},
        ],
        "ci_relationship_edges": [
            {
                "_id": "drel_ab",
                "communityId": "com_a",
                "relationshipContractId": "cat-ai.relationship.directed",
                "relationshipContractVersion": 2,
                "directionVersion": 2,
                "directionState": "directed",
                "directionKey": "cat_a::cat_b_alias",
                "fromCatId": "cat_a",
                "toCatId": "cat_b_alias",
                "catAId": "cat_a",
                "catBId": "cat_b_alias",
                "voteCounts": {"bonded": 2, "playmate": 1, "housemate": 0, "needs_space": 0, "unsure": 0},
                "totalVotes": 3,
                "state": "active",
            },
            {
                "_id": "legacy_ab",
                "communityId": "com_a",
                "catAId": "cat_a",
                "catBId": "cat_b",
                "voteCounts": {"bonded": 1},
                "totalVotes": 1,
                "state": "active",
            },
        ],
        "ci_sightings_public": [
            {
                "_id": "sig_a",
                "communityId": "com_a",
                "catId": "cat_a",
                "ownerKey": "owner-secret-a",
                "assetId": "asset-secret",
                "caption": "花园里晒太阳",
                "state": "APPROVED",
                "coarseLocation": {
                    "cellId": "cell_safe",
                    "areaText": "花园附近",
                    "precisionKm": 2,
                    "coordinateSystem": "gcj02",
                    "longitude": 121.51,
                    "latitude": 31.23,
                },
                "observedTimeBucket": "2026-08-28T12:00+08:00",
                "reviewedAt": "2026-08-28T13:00:00Z",
            }
        ],
        "ci_identity_jobs": [{"_id": "job_a", "communityId": "com_a", "linkedCatId": "cat_a", "state": "COMPLETED"}],
        "ci_identity_assignments": [{"_id": "assignment_a", "communityId": "com_a", "catId": "cat_a", "state": "active"}],
        "ci_identity_templates": [
            {
                "_id": "template_a",
                "communityId": "com_a",
                "catId": "cat_a",
                "state": "active",
                "embedding": "must-not-leak",
            }
        ],
        "ci_feedback": [
            {
                "_id": "fb_demo",
                "ownerKey": "owner-secret-a",
                "publicUserId": "user_demo_public",
                "category": "usability",
                "title": "知识页按钮不好找",
                "content": "请联系 13812345678 或 demo@example.com，密钥 sk-abcdefghijklmnop 不应出现。",
                "steps": "打开知识页后输入内容",
                "client": {"version": "1.0.0", "platform": "ios", "sourcePage": "pages/knowledge/index"},
                "status": "OPEN",
                "version": 1,
                "createdAt": "2026-08-29T08:00:00Z",
            }
        ],
        "ci_change_proposals": [
            {
                "_id": "proposal_demo",
                "title": "优化知识页布局",
                "summary": "让提交按钮在常见手机尺寸内可见。",
                "recommendation": "recommend",
                "feasibility": {"level": "high", "score": 90, "reason": "局部布局修改。"},
                "affectedAreas": ["miniapp/pages/knowledge"],
                "risks": [{"level": "low", "description": "大字体换行", "mitigation": "验证大字体"}],
                "draftChanges": [{"area": "知识页", "currentProblem": "输入区过高", "proposedChange": "改为紧凑布局", "acceptanceCriteria": ["无需下拉即可提交"]}],
                "testPlan": ["运行小程序契约测试"],
                "feedbackCount": 1,
                "status": "READY_FOR_LOCAL_REVIEW",
                "version": 1,
                "generatedAt": "2026-08-29T09:00:00Z",
            }
        ],
        "ci_admin_audit_logs": [],
    }
    return SourceResult(collections=collections, truncated_collections=tuple(), source_name="fixture")


class FakeSource:
    def __init__(self):
        self.calls = 0

    def load(self) -> SourceResult:
        self.calls += 1
        return fixture_result()


class WritableFakeSource:
    def __init__(self):
        self.result = fixture_result()
        self.calls = 0

    def load(self) -> SourceResult:
        self.calls += 1
        return copy.deepcopy(self.result)

    def insert_change_proposal(self, proposal):
        self.result.collections["ci_change_proposals"].append(copy.deepcopy(proposal))

    def link_feedback_to_proposal(self, feedback_ids, proposal_id, now):
        for item in self.result.collections["ci_feedback"]:
            if item["_id"] in feedback_ids and item.get("status") in {"OPEN", "TRIAGED"}:
                item.update(status="INCLUDED_IN_PROPOSAL", proposalId=proposal_id, updatedAt=now)
                item["version"] = int(item.get("version") or 1) + 1

    def claim_change_proposal(self, proposal_id, expected_version, lease_id, now):
        proposal = next(item for item in self.result.collections["ci_change_proposals"] if item.get("_id") == proposal_id)
        assert proposal["status"] in {
            "READY_FOR_LOCAL_REVIEW", "AWAITING_ADMIN_APPROVAL", "APPROVED_FOR_LOCAL_EXECUTION"
        }
        assert proposal["version"] == expected_version
        proposal.update(status="EXECUTING", executionLeaseId=lease_id, updatedAt=now)
        proposal["version"] += 1

    def complete_change_proposal(self, proposal_id, lease_id, status, summary, now):
        proposal = next(item for item in self.result.collections["ci_change_proposals"] if item.get("_id") == proposal_id)
        assert proposal["status"] == "EXECUTING"
        assert proposal["executionLeaseId"] == lease_id
        proposal.update(status=status, executionSummary=summary, updatedAt=now)
        proposal.pop("executionLeaseId", None)
        proposal["version"] += 1

    def sync_feedback_for_proposal(self, proposal_id, status, now):
        if status != "COMPLETED":
            return
        for item in self.result.collections["ci_feedback"]:
            if item.get("proposalId") == proposal_id and item.get("status") == "INCLUDED_IN_PROPOSAL":
                item.update(status="CLOSED", updatedAt=now)
                item["version"] = int(item.get("version") or 1) + 1


class CommunityWritableFakeSource(FakeSource):
    def __init__(self):
        super().__init__()
        self.result = fixture_result()
        self.mutations = []

    def load(self):
        self.calls += 1
        return copy.deepcopy(self.result)

    def mutate_community(self, payload):
        self.mutations.append(copy.deepcopy(payload))
        communities = self.result.collections["ci_communities"]
        operation = payload["operation"]
        now = "2026-09-01T01:00:00Z"
        if operation == "create":
            row = {
                "_id": "com_created", "name": payload["patch"]["name"],
                "scope": payload["patch"]["scope"], "status": "active",
                "version": 1, "ownerPending": True, "managedByLocalAdmin": True,
                "createdAt": now, "updatedAt": now,
            }
            communities.append(row)
            return {"community": {**row, "id": row["_id"]}, "auditId": "audit_create", "inviteCode": "ABCDE-FGHJK"}
        row = next(item for item in communities if item["_id"] == payload["communityId"])
        assert int(row.get("version") or 0) == payload["expectedVersion"]
        row["version"] = int(row.get("version") or 0) + 1
        row["updatedAt"] = now
        if operation == "update":
            row.update(payload["patch"])
        else:
            row["status"] = {"disable": "disabled", "restore": "active", "delete": "deleted"}[operation]
        self.result.collections["ci_admin_audit_logs"].append({
            "_id": f"audit_{operation}", "entityType": "community", "entityId": row["_id"],
            "operation": operation, "operator": "local-cloudbase-cli", "reason": payload["reason"],
            "before": {}, "after": {}, "result": "SUCCESS", "createdAt": now,
        })
        return {"community": {**row, "id": row["_id"]}, "auditId": f"audit_{operation}"}

class FakeCodexWorkflow:
    def __init__(self):
        self.audited = []
        self.executed = []

    def audit(self, feedback):
        self.audited.append(copy.deepcopy(feedback))
        return {
            "title": "优化知识问答手机布局",
            "summary": "收紧输入区域并保留大字体可读性。",
            "recommendation": "recommend",
            "feasibility": {"level": "high", "score": 91, "reason": "局部 UI 修改"},
            "affectedAreas": ["miniapp/pages/knowledge"],
            "risks": [{"level": "low", "description": "大字体换行", "mitigation": "视觉验证"}],
            "draftChanges": [{"area": "知识页", "currentProblem": "输入区过高", "proposedChange": "使用紧凑自适应输入区", "acceptanceCriteria": ["按钮首屏可见"]}],
            "testPlan": ["运行小程序测试"],
            "excludedFeedback": [],
        }

    def execute(self, proposal):
        self.executed.append(copy.deepcopy(proposal))
        return "已修改知识页并通过本地测试"


class FailingCodexWorkflow(FakeCodexWorkflow):
    def execute(self, proposal):
        self.executed.append(copy.deepcopy(proposal))
        raise CodexWorkflowError("本地测试未通过")


def test_projection_links_all_entities_and_keeps_directions():
    snapshot = build_snapshot(fixture_result(), "cloud-test")
    assert snapshot["stats"]["communityCount"] == 2
    assert snapshot["stats"]["catCount"] == 2
    assert snapshot["stats"]["directedRelationshipCount"] == 1
    assert snapshot["stats"]["legacyRelationshipCount"] == 1
    assert snapshot["stats"]["openFeedbackCount"] == 1
    assert snapshot["stats"]["awaitingProposalCount"] == 1
    assert snapshot["feedback"][0]["content"].count("REDACTED") == 3

    cats = {item["id"]: item for item in snapshot["cats"]}
    assert cats["cat_a"]["linkedProfileCount"] == 1
    assert cats["cat_a"]["activeTemplateCount"] == 1
    assert cats["cat_a"]["sightingCount"] == 1
    assert cats["cat_b"]["aliasIds"] == ["cat_b_alias"]
    assert cats["cat_b"]["remotePetIds"] == ["pet_remote_b"]

    directed = next(item for item in snapshot["relationships"] if not item["legacy"])
    assert directed["fromCatId"] == "cat_a"
    assert directed["toCatId"] == "cat_b"
    assert directed["fromRole"] == "主动亲近方"
    assert directed["toRole"] == "亲近对象"
    assert directed["arrow"] == "→"
    assert directed["relationshipContractId"] == "cat-ai.relationship.directed"
    assert directed["relationshipContractVersion"] == 2
    assert directed["sourceDirectionState"] == "directed"
    assert directed["directionKey"] == "cat_a::cat_b_alias"
    assert directed["expectedDirectionKey"] == "cat_a::cat_b_alias"
    assert directed["contractValid"] is True
    assert directed["compatibilityValid"] is True

    legacy = next(item for item in snapshot["relationships"] if item["legacy"])
    assert legacy["arrow"] == "↔?"
    assert legacy["voteCounts"] == {}


def test_projection_never_exposes_private_fields():
    snapshot = build_snapshot(fixture_result(), "cloud-test")
    serialized = json.dumps(snapshot, ensure_ascii=False)
    for forbidden in (
        "must-not-leak",
        "owner-secret-a",
        "owner-secret-b",
        "local-phone-secret",
        "asset-secret",
        "inviteHash",
        "ownerKey",
        "localPetId",
        "assetId",
        "embedding",
        "exactLocation",
        "locationGeo",
        "sourceFileID",
        "approvedFileID",
        "areaText",
        "13812345678",
        "demo@example.com",
        "sk-abcdefghijklmnop",
    ):
        assert forbidden not in serialized
    assert "[PHONE_REDACTED]" in serialized
    assert "[EMAIL_REDACTED]" in serialized
    assert "[API_KEY_REDACTED]" in serialized


def test_projection_reports_dangling_canonical_self_loops_and_vote_ties():
    source = fixture_result()
    identities = source.collections["ci_cat_identities"]
    alias = next(item for item in identities if item["_id"] == "cat_b_alias")
    alias["canonicalCatId"] = "missing_cat"
    dangling = build_snapshot(source, "cloud-test")
    assert "missing_cat" not in {item["id"] for item in dangling["cats"]}
    assert any(item["kind"] == "missing_canonical_target" for item in dangling["issues"])

    source = fixture_result()
    identities = source.collections["ci_cat_identities"]
    next(item for item in identities if item["_id"] == "cat_b_alias")["canonicalCatId"] = "cat_a"
    edge = next(
        item for item in source.collections["ci_relationship_edges"]
        if item["_id"] == "drel_ab"
    )
    edge["voteCounts"] = {
        "bonded": 2,
        "playmate": 0,
        "housemate": 0,
        "needs_space": 2,
        "unsure": 0,
    }
    edge["totalVotes"] = 4
    snapshot = build_snapshot(source, "cloud-test")
    relation = next(item for item in snapshot["relationships"] if item["id"] == "drel_ab")
    assert relation["selfLoop"] is True
    assert relation["valid"] is False
    assert relation["directionState"] == "self_loop_needs_review"
    assert relation["dominantChoice"] == ""
    assert relation["dominantLabel"] == "意见并列"
    assert any(item["kind"] == "relationship_self_loop" for item in snapshot["issues"])


def test_projection_audits_directed_relationship_cloud_contract():
    cases = (
        (
            lambda edge: edge.pop("relationshipContractId"),
            "relationship_contract_incomplete",
        ),
        (
            lambda edge: edge.update(directionKey="cat_b_alias::cat_a"),
            "relationship_direction_key_mismatch",
        ),
        (
            lambda edge: edge.update(catAId="cat_b_alias"),
            "relationship_compatibility_mismatch",
        ),
        (
            lambda edge: edge.update(relationshipContractVersion=3),
            "relationship_contract_mismatch",
        ),
    )
    for mutate, expected_issue in cases:
        source = fixture_result()
        edge = next(
            item for item in source.collections["ci_relationship_edges"]
            if item["_id"] == "drel_ab"
        )
        mutate(edge)
        snapshot = build_snapshot(source, "cloud-test")
        relation = next(item for item in snapshot["relationships"] if item["id"] == "drel_ab")
        assert relation["valid"] is False
        assert relation["contractValid"] is False
        assert relation["directionState"] == "directed_contract_invalid"
        assert any(item["kind"] == expected_issue for item in snapshot["issues"])


def test_projection_rejects_non_finite_or_out_of_range_map_coordinates():
    for longitude, latitude in (
        (math.nan, 31.2),
        (math.inf, 31.2),
        (121.5, -math.inf),
        (181, 31.2),
        (121.5, 91),
    ):
        source = fixture_result()
        coarse = source.collections["ci_sightings_public"][0]["coarseLocation"]
        coarse["longitude"] = longitude
        coarse["latitude"] = latitude
        snapshot = build_snapshot(source, "cloud-test")
        assert snapshot["sightings"][0]["coarseLocation"]["longitude"] is None
        assert snapshot["sightings"][0]["coarseLocation"]["latitude"] is None
        json.dumps(snapshot, ensure_ascii=False, allow_nan=False)


def test_cloud_source_marks_collection_truncated_at_exact_limit_boundary():
    settings = AdminSettings(
        env_id="cloud-test",
        page_size=200,
        max_documents_per_collection=250,
    )
    source = object.__new__(TcbCliSource)
    source.settings = settings
    rows_by_name = {name: [] for name in READ_COLLECTIONS}
    rows_by_name["ci_communities"] = [{"_id": f"row-{index:03}"} for index in range(251)]

    def query_batch(names, offsets):
        result = []
        for name in names:
            remaining = settings.max_documents_per_collection - offsets[name]
            limit = 1 if remaining <= 0 else min(settings.page_size, remaining + 1)
            start = offsets[name]
            result.append(copy.deepcopy(rows_by_name[name][start:start + limit]))
        return result

    source._query_batch = query_batch
    result = source.load()
    assert len(result.collections["ci_communities"]) == 250
    assert result.truncated_collections == ("ci_communities",)


def test_query_projections_exclude_sensitive_fields_and_exact_place_text():
    flattened = {field for fields in FIELD_PROJECTIONS.values() for field in fields}
    assert "ownerKey" not in flattened
    assert "localPetId" not in flattened
    assert "embedding" not in flattened
    assert "coarseLocation" not in flattened
    assert "coarseLocation.areaText" not in flattened
    relationship_fields = set(FIELD_PROJECTIONS["ci_relationship_edges"])
    assert {
        "relationshipContractId",
        "relationshipContractVersion",
        "directionVersion",
        "directionState",
        "directionKey",
        "fromCatId",
        "toCatId",
        "catAId",
        "catBId",
    } <= relationship_fields


def test_fastapi_admin_routes_keep_primary_data_read_only_and_filterable():
    source = FakeSource()
    settings = AdminSettings(
        env_id="cloud-test",
        host="127.0.0.1",
        port=8510,
        cache_ttl_seconds=30,
    )
    app = create_app(settings, source, enforce_loopback=False)
    client = TestClient(app)

    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["readOnly"] is False
    assert health.json()["primaryDataReadOnly"] is True

    snapshot = client.get("/api/snapshot")
    assert snapshot.status_code == 200
    assert snapshot.json()["data"]["stats"]["catCount"] == 2

    cats = client.get("/api/cats", params={"communityId": "com_a", "q": "奶糖"})
    assert cats.status_code == 200
    assert cats.json()["count"] == 1
    assert cats.json()["data"][0]["id"] == "cat_b"

    detail = client.get("/api/communities/com_a")
    assert detail.status_code == 200
    assert len(detail.json()["data"]["relationships"]) == 2

    missing = client.get("/api/communities/not-found")
    assert missing.status_code == 404

    root = client.get("/")
    assert root.status_code == 200
    assert "Cat-AI 云端管理台" in root.text
    assert "小程序只负责收集意见" in root.text
    assert "管理员登记" not in root.text
    assert "获批执行" not in root.text
    assert source.calls == 1


def test_house_crud_routes_are_versioned_audited_and_map_is_coarse_only():
    source = CommunityWritableFakeSource()
    app = create_app(
        AdminSettings(env_id="cloud-test", host="127.0.0.1", port=8510, cache_ttl_seconds=0),
        source, enforce_loopback=False,
    )
    client = TestClient(app)
    health = client.get("/api/health").json()
    assert health["communityWritesEnabled"] is True
    assert health["primaryDataReadOnly"] is False

    created = client.post("/api/communities", json={
        "name": "新小屋", "scope": "invite", "reason": "验收创建",
        "idempotencyKey": "create-test-001",
    })
    assert created.status_code == 200
    assert created.json()["data"]["inviteCode"] == "ABCDE-FGHJK"

    updated = client.patch("/api/communities/com_a", json={
        "name": "花园猫屋", "scope": "private", "expectedVersion": 0,
        "reason": "验收编辑", "idempotencyKey": "update-test-001",
    })
    assert updated.status_code == 200
    disabled = client.post("/api/communities/com_a/disable", json={
        "expectedVersion": 1, "reason": "暂停维护", "idempotencyKey": "disable-test-001",
    })
    assert disabled.status_code == 200
    detail = client.get("/api/communities/com_a").json()["data"]
    assert detail["community"]["status"] == "disabled"
    assert {item["operation"] for item in detail["auditLogs"]} >= {"update", "disable"}

    map_result = client.get("/api/map-distribution", params={"communityId": "com_a", "reviewStatus": "APPROVED"})
    assert map_result.status_code == 200
    map_data = map_result.json()["data"]
    assert map_data["privacy"]["exactCoordinatesReturned"] is False
    assert map_data["privacy"]["precisionKm"] == 2
    serialized = json.dumps(map_data, ensure_ascii=False)
    assert "exactLocation" not in serialized


def test_fastapi_rejects_dns_rebinding_and_cross_origin_requests():
    settings = AdminSettings(env_id="cloud-test", host="127.0.0.1", port=8510)
    app = create_app(settings, FakeSource(), enforce_loopback=True)
    client = TestClient(
        app,
        base_url="http://127.0.0.1:8510",
        client=("127.0.0.1", 50500),
    )

    assert client.get("/api/health").status_code == 200
    assert client.get("/api/docs").status_code == 404
    assert client.get("/api/snapshot", headers={"Host": "attacker.example:8510"}).status_code == 421
    assert client.get(
        "/api/snapshot",
        headers={
            "Host": "127.0.0.1:8510",
            "Origin": "http://attacker.example:8510",
        },
    ).status_code == 403
    assert client.get(
        "/api/snapshot",
        headers={"Host": "127.0.0.1:8510", "Sec-Fetch-Site": "cross-site"},
    ).status_code == 403


def test_feedback_audit_and_local_review_execution_gate():
    source = WritableFakeSource()
    codex = FakeCodexWorkflow()
    settings = AdminSettings(
        env_id="cloud-test",
        host="127.0.0.1",
        port=8510,
        cache_ttl_seconds=0,
    )
    app = create_app(settings, source, codex_workflow=codex, enforce_loopback=False)
    client = TestClient(app)

    health = client.get("/api/health").json()
    assert health["primaryDataReadOnly"] is True
    assert health["feedbackWorkflowWritesEnabled"] is True

    assert client.post("/api/app-admins", json={"publicUserId": "user_demo"}).status_code == 404

    audit = client.post("/api/feedback/audit", json={"feedbackIds": ["fb_demo"]})
    assert audit.status_code == 200
    proposal_id = audit.json()["data"]["proposalId"]
    assert codex.audited[0][0]["id"] == "fb_demo"
    assert "13812345678" not in codex.audited[0][0]["content"]
    feedback = source.result.collections["ci_feedback"][0]
    assert feedback["status"] == "INCLUDED_IN_PROPOSAL"
    assert feedback["proposalId"] == proposal_id
    linked_version = feedback["version"]
    source.link_feedback_to_proposal(["fb_demo"], proposal_id, feedback["updatedAt"])
    assert feedback["version"] == linked_version

    proposal = next(
        item for item in source.result.collections["ci_change_proposals"]
        if item.get("_id") == proposal_id
    )
    assert proposal["status"] == "READY_FOR_LOCAL_REVIEW"
    executed = client.post(
        f"/api/proposals/{proposal_id}/execute",
        json={"expectedVersion": 1},
    )
    assert executed.status_code == 200
    assert executed.json()["data"]["status"] == "COMPLETED"
    assert len(codex.executed) == 1
    assert proposal["status"] == "COMPLETED"
    assert feedback["status"] == "CLOSED"
    closed_version = feedback["version"]
    source.sync_feedback_for_proposal(proposal_id, "COMPLETED", "2026-08-30T10:00:00Z")
    assert feedback["version"] == closed_version


def test_failed_execution_keeps_feedback_recoverable_and_not_closed():
    source = WritableFakeSource()
    source.result.collections["ci_feedback"][0].update(
        status="INCLUDED_IN_PROPOSAL", proposalId="proposal_demo", version=2
    )
    proposal = source.result.collections["ci_change_proposals"][0]
    proposal.update(status="READY_FOR_LOCAL_REVIEW", version=2)
    app = create_app(
        AdminSettings(env_id="cloud-test", host="127.0.0.1", port=8510, cache_ttl_seconds=0),
        source,
        codex_workflow=FailingCodexWorkflow(),
        enforce_loopback=False,
    )
    client = TestClient(app)

    response = client.post("/api/proposals/proposal_demo/execute", json={"expectedVersion": 2})
    assert response.status_code == 503
    assert proposal["status"] == "FAILED"
    assert source.result.collections["ci_feedback"][0]["status"] == "INCLUDED_IN_PROPOSAL"
