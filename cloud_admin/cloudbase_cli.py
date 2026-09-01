"""通过本机已登录的 CloudBase CLI 查询数据并调用受审计的管理云函数。"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .config import AdminSettings


READ_COLLECTIONS = (
    "ci_communities",
    "ci_members",
    "ci_user_pet_links",
    "ci_cat_identities",
    "ci_relationship_edges",
    "ci_sightings_public",
    "ci_identity_jobs",
    "ci_identity_assignments",
    "ci_identity_templates",
    "ci_feedback",
    "ci_change_proposals",
    "ci_admin_audit_logs",
)

# 管理员 QUERY 也坚持最小化：敏感字段不应先下载后再脱敏。
FIELD_PROJECTIONS: dict[str, tuple[str, ...]] = {
    "ci_communities": (
        "_id", "name", "scope", "status", "version", "ownerPending",
        "managedByLocalAdmin", "createdAt", "updatedAt", "disabledAt", "deletedAt",
    ),
    "ci_members": ("_id", "communityId", "role", "status", "createdAt", "updatedAt"),
    "ci_user_pet_links": (
        "_id", "catId", "communityId", "displayName", "breed", "gender",
        "coatColor", "estimatedAge", "state", "createdAt", "updatedAt",
    ),
    "ci_cat_identities": (
        "_id", "communityId", "displayName", "breed", "gender", "coatColor",
        "estimatedAge", "state", "canonicalCatId", "identityVersion", "source",
        "createdAt", "updatedAt",
    ),
    "ci_relationship_edges": (
        "_id", "communityId", "relationshipContractId", "relationshipContractVersion",
        "directionVersion", "directionState", "directionKey", "fromCatId", "toCatId",
        "catAId", "catBId", "voteCounts", "totalVotes", "state", "updatedAt",
    ),
    "ci_sightings_public": (
        "_id", "communityId", "identityCatId", "catId", "remotePetId", "state",
        "caption", "coarseLocation.cellId", "coarseLocation.precisionKm",
        "coarseLocation.coordinateSystem", "coarseLocation.longitude",
        "coarseLocation.latitude", "observedTimeBucket", "submittedAt", "reviewedAt",
        "identityTemplateReady",
    ),
    "ci_identity_jobs": ("_id", "communityId", "linkedCatId", "state"),
    "ci_identity_assignments": ("_id", "communityId", "catId", "state"),
    "ci_identity_templates": ("_id", "communityId", "catId", "state"),
    "ci_feedback": (
        "_id", "category", "title", "content", "steps", "client.version",
        "client.platform", "client.sdkVersion", "client.sourcePage", "status",
        "version", "proposalId", "createdAt", "updatedAt",
    ),
    "ci_change_proposals": (
        "_id", "title", "summary", "recommendation", "feasibility",
        "affectedAreas", "risks", "draftChanges", "testPlan", "feedbackCount",
        "status", "version", "generatedAt", "decidedAt", "decisionNote",
        "executionSummary", "updatedAt",
    ),
    "ci_admin_audit_logs": (
        "_id", "entityType", "entityId", "operation", "operator", "reason",
        "before.id", "before.name", "before.scope", "before.status", "before.version",
        "after.id", "after.name", "after.scope", "after.status", "after.version",
        "result", "createdAt",
    ),
}

SAFE_DOCUMENT_ID = re.compile(r"^[A-Za-z0-9._:-]{3,160}$")
LOCAL_REVIEW_STATUSES = (
    "READY_FOR_LOCAL_REVIEW",
    "AWAITING_ADMIN_APPROVAL",
    "APPROVED_FOR_LOCAL_EXECUTION",
)


class CloudSourceError(RuntimeError):
    """可安全显示给本地管理员的数据源错误。"""


@dataclass(frozen=True)
class SourceResult:
    collections: dict[str, list[dict[str, Any]]]
    truncated_collections: tuple[str, ...]
    source_name: str


class CloudSource(Protocol):
    def load(self) -> SourceResult: ...
    def mutate_community(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def sync_feedback_for_proposal(
        self, proposal_id: str, status: str, now: str
    ) -> None: ...


def _plain_ejson(value: Any) -> Any:
    if isinstance(value, list):
        return [_plain_ejson(item) for item in value]
    if not isinstance(value, dict):
        return value
    if set(value) == {"$date"}:
        raw = value["$date"]
        if isinstance(raw, dict) and "$numberLong" in raw:
            return raw["$numberLong"]
        return raw
    for number_key in ("$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"):
        if set(value) == {number_key}:
            raw = value[number_key]
            try:
                return float(raw) if number_key in {"$numberDouble", "$numberDecimal"} else int(raw)
            except (TypeError, ValueError):
                return raw
    return {str(key): _plain_ejson(item) for key, item in value.items()}


class JsonSnapshotSource:
    """用于离线演示和自动化测试的 JSON 快照数据源。"""

    def __init__(self, path: str):
        self.path = Path(path).expanduser().resolve()

    def load(self) -> SourceResult:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise CloudSourceError(f"无法读取离线快照：{exc}") from exc
        raw_collections = payload.get("collections", payload)
        if not isinstance(raw_collections, dict):
            raise CloudSourceError("离线快照必须是 collections 对象")
        collections: dict[str, list[dict[str, Any]]] = {}
        for name in READ_COLLECTIONS:
            rows = raw_collections.get(name, [])
            collections[name] = [
                _plain_ejson(item) for item in rows if isinstance(item, dict)
            ] if isinstance(rows, list) else []
        return SourceResult(collections, tuple(), f"json:{self.path.name}")

    def _write_disabled(self, *_args, **_kwargs):
        raise CloudSourceError("离线快照模式不允许写入云端")

    insert_change_proposal = _write_disabled
    link_feedback_to_proposal = _write_disabled
    claim_change_proposal = _write_disabled
    complete_change_proposal = _write_disabled
    sync_feedback_for_proposal = _write_disabled
    mutate_community = _write_disabled


class TcbCliSource:
    """使用 CloudBase CLI 登录态查询，并调用仅管理端可用的云函数。"""

    def __init__(self, settings: AdminSettings):
        self.settings = settings
        self.node_bin = self._resolve_node(settings.node_bin)
        self.tcb_bin = self._resolve_tcb(settings.tcb_bin)

    @staticmethod
    def _resolve_node(value: str) -> str:
        resolved = shutil.which(value)
        if resolved:
            return resolved
        path = Path(value).expanduser()
        if path.is_file():
            return str(path.resolve())
        raise CloudSourceError("未找到 Node.js；请设置 CAT_ADMIN_NODE_BIN")

    @staticmethod
    def _resolve_tcb(value: str) -> str:
        if value:
            path = Path(value).expanduser()
            if path.is_file():
                return str(path.resolve())
            raise CloudSourceError("CAT_ADMIN_TCB_BIN 指向的文件不存在")

        home = Path.home()
        candidates: list[Path] = []
        npm_cache = home / "AppData" / "Local" / "npm-cache" / "_npx"
        if npm_cache.is_dir():
            candidates.extend(npm_cache.glob("*/node_modules/@cloudbase/cli/bin/tcb"))
        candidates.extend((home / ".npm" / "_npx").glob("*/node_modules/@cloudbase/cli/bin/tcb"))
        files = [path for path in candidates if path.is_file()]
        if files:
            return str(max(files, key=lambda path: path.stat().st_mtime).resolve())

        command = shutil.which("tcb")
        if command and Path(command).is_file() and Path(command).suffix.lower() not in {".cmd", ".bat"}:
            return str(Path(command).resolve())
        raise CloudSourceError(
            "未找到 CloudBase CLI。请运行 npx @cloudbase/cli login，或设置 CAT_ADMIN_TCB_BIN"
        )

    @staticmethod
    def _decode_payload(output: str) -> dict[str, Any]:
        decoder = json.JSONDecoder()
        candidates: list[dict[str, Any]] = []
        for index, char in enumerate(output):
            if char != "{":
                continue
            try:
                value, _ = decoder.raw_decode(output[index:])
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and ("data" in value or "error" in value):
                candidates.append(value)
        if not candidates:
            raise CloudSourceError("CloudBase CLI 未返回可解析的 JSON")
        return candidates[-1]

    def _query_batch(self, names: list[str], offsets: dict[str, int]) -> list[list[dict[str, Any]]]:
        commands = []
        for name in names:
            remaining = self.settings.max_documents_per_collection - offsets[name]
            # 在最后一页多读 1 条，区分“刚好等于上限”和“已被截断”。
            limit = 1 if remaining <= 0 else min(
                self.settings.page_size,
                remaining + 1,
            )
            command = {
                "find": name,
                "filter": {},
                "projection": {field: 1 for field in FIELD_PROJECTIONS[name]},
                "sort": {"_id": 1},
                "skip": offsets[name],
                "limit": limit,
            }
            commands.append(
                {
                    "TableName": name,
                    "CommandType": "QUERY",
                    "Command": json.dumps(command, ensure_ascii=False, separators=(",", ":")),
                }
            )

        results = self._execute_commands(commands, "查询")
        if len(results) != len(names):
            raise CloudSourceError("CloudBase 返回的集合数量与请求不一致")
        normalized: list[list[dict[str, Any]]] = []
        for result in results:
            rows = result if isinstance(result, list) else []
            normalized.append([
                _plain_ejson(item) for item in rows if isinstance(item, dict)
            ])
        return normalized

    def _execute_commands(self, commands: list[dict[str, Any]], operation: str) -> list[Any]:
        args = [
            self.node_bin,
            self.tcb_bin,
            "db",
            "nosql",
            "execute",
            "-e",
            self.settings.env_id,
            "--command",
            json.dumps(commands, ensure_ascii=False, separators=(",", ":")),
            "--json",
        ]
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            completed = subprocess.run(
                args,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.settings.query_timeout_seconds,
                check=False,
                env=os.environ.copy(),
                creationflags=creation_flags,
            )
        except subprocess.TimeoutExpired as exc:
            raise CloudSourceError(f"CloudBase {operation}超时，请稍后重试") from exc
        except OSError as exc:
            raise CloudSourceError(f"无法启动 CloudBase CLI：{exc}") from exc

        combined = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
        payload = self._decode_payload(combined)
        if payload.get("error"):
            error = payload["error"] if isinstance(payload["error"], dict) else {}
            code = str(error.get("code", "CLOUDBASE_ERROR"))[:80]
            message = str(error.get("message", "CloudBase 查询失败"))[:240]
            raise CloudSourceError(f"{code}: {message}")
        if completed.returncode != 0:
            raise CloudSourceError(f"CloudBase CLI {operation}失败（exit {completed.returncode}）")

        data = payload.get("data", {})
        results = data.get("results", []) if isinstance(data, dict) else []
        if not isinstance(results, list):
            raise CloudSourceError(f"CloudBase {operation}未返回结果数组")
        return [_plain_ejson(item) for item in results]

    def _invoke_function(self, name: str, payload: dict[str, Any]) -> dict[str, Any]:
        args = [
            self.node_bin, self.tcb_bin, "fn", "invoke", name,
            "-e", self.settings.env_id,
            "--params", json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            "--json",
        ]
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            completed = subprocess.run(
                args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=self.settings.query_timeout_seconds, check=False,
                env=os.environ.copy(), creationflags=creation_flags,
            )
        except subprocess.TimeoutExpired as exc:
            raise CloudSourceError("CloudBase 管理云函数调用超时") from exc
        except OSError as exc:
            raise CloudSourceError(f"无法启动 CloudBase CLI：{exc}") from exc
        combined = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
        try:
            envelope = json.loads(completed.stdout)
            invoke_data = envelope.get("data", {}) if isinstance(envelope, dict) else {}
            raw = invoke_data.get("RetMsg", "") if isinstance(invoke_data, dict) else ""
            result = json.loads(raw) if isinstance(raw, str) else raw
        except (json.JSONDecodeError, TypeError, AttributeError) as exc:
            raise CloudSourceError("CloudBase 管理云函数未返回可解析结果") from exc
        if completed.returncode != 0 or not isinstance(result, dict):
            raise CloudSourceError("CloudBase 管理云函数调用失败")
        if result.get("ok") is not True:
            error = result.get("error") if isinstance(result.get("error"), dict) else {}
            code = str(error.get("code") or "ADMIN_ERROR")[:80]
            message = str(error.get("message") or "云端管理操作失败")[:240]
            raise CloudSourceError(f"{code}: {message}")
        return _plain_ejson(result.get("data") or {})

    def mutate_community(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._invoke_function("catAdmin", {"action": "mutateCommunity", **payload})

    @staticmethod
    def _safe_id(value: str, field: str) -> str:
        text = str(value or "").strip()
        if not SAFE_DOCUMENT_ID.fullmatch(text):
            raise CloudSourceError(f"{field} 格式无效")
        return text

    def _query_one(
        self, collection: str, document_id: str, projection: tuple[str, ...]
    ) -> dict[str, Any] | None:
        command = {
            "find": collection,
            "filter": {"_id": document_id},
            "projection": {field: 1 for field in projection},
            "limit": 1,
        }
        results = self._execute_commands([{
            "TableName": collection,
            "CommandType": "QUERY",
            "Command": json.dumps(command, ensure_ascii=False, separators=(",", ":")),
        }], "校验写入结果")
        rows = results[0] if results and isinstance(results[0], list) else []
        return rows[0] if rows and isinstance(rows[0], dict) else None

    def insert_change_proposal(self, proposal: dict[str, Any]) -> None:
        proposal_id = self._safe_id(proposal.get("_id") or proposal.get("id"), "proposalId")
        document = dict(proposal)
        document.pop("id", None)
        document["_id"] = proposal_id
        command = {
            "insert": "ci_change_proposals",
            "documents": [document],
        }
        self._execute_commands([{
            "TableName": "ci_change_proposals",
            "CommandType": "INSERT",
            "Command": json.dumps(command, ensure_ascii=False, separators=(",", ":")),
        }], "写入修改提案")
        saved = self._query_one(
            "ci_change_proposals", proposal_id, ("_id", "status", "version")
        )
        if not saved or saved.get("status") != "READY_FOR_LOCAL_REVIEW":
            raise CloudSourceError("修改提案写入后校验失败")

    def link_feedback_to_proposal(
        self, feedback_ids: list[str], proposal_id: str, now: str
    ) -> None:
        safe_ids = [self._safe_id(value, "feedbackId") for value in feedback_ids[:50]]
        if not safe_ids:
            raise CloudSourceError("至少选择一条反馈")
        safe_proposal_id = self._safe_id(proposal_id, "proposalId")
        update = {
            "update": "ci_feedback",
            "updates": [{
                "q": {"_id": {"$in": safe_ids}, "status": {"$in": ["OPEN", "TRIAGED"]}},
                "u": {"$set": {
                    "status": "INCLUDED_IN_PROPOSAL",
                    "proposalId": safe_proposal_id,
                    "updatedAt": now,
                }, "$inc": {"version": 1}},
                "upsert": False,
                "multi": True,
            }],
        }
        self._execute_commands([{
            "TableName": "ci_feedback",
            "CommandType": "UPDATE",
            "Command": json.dumps(update, ensure_ascii=False, separators=(",", ":")),
        }], "关联反馈与修改提案")

    def claim_change_proposal(
        self, proposal_id: str, expected_version: int, lease_id: str, now: str
    ) -> None:
        safe_proposal_id = self._safe_id(proposal_id, "proposalId")
        safe_lease_id = self._safe_id(lease_id, "leaseId")
        update = {
            "update": "ci_change_proposals",
            "updates": [{
                "q": {
                    "_id": safe_proposal_id,
                    "status": {"$in": list(LOCAL_REVIEW_STATUSES)},
                    "version": int(expected_version),
                },
                "u": {
                    "$set": {
                        "status": "EXECUTING",
                        "executionLeaseId": safe_lease_id,
                        "executionStartedAt": now,
                        "updatedAt": now,
                    },
                    "$inc": {"version": 1},
                },
                "upsert": False,
                "multi": False,
            }],
        }
        self._execute_commands([{
            "TableName": "ci_change_proposals",
            "CommandType": "UPDATE",
            "Command": json.dumps(update, ensure_ascii=False, separators=(",", ":")),
        }], "领取修改提案")
        saved = self._query_one(
            "ci_change_proposals", safe_proposal_id,
            ("_id", "status", "version", "executionLeaseId"),
        )
        if not saved or saved.get("status") != "EXECUTING" or saved.get("executionLeaseId") != safe_lease_id:
            raise CloudSourceError("提案状态已变化，未取得本地执行租约")

    def complete_change_proposal(
        self, proposal_id: str, lease_id: str, status: str, summary: str, now: str
    ) -> None:
        safe_proposal_id = self._safe_id(proposal_id, "proposalId")
        safe_lease_id = self._safe_id(lease_id, "leaseId")
        normalized_status = str(status or "").strip().upper()
        if normalized_status not in {"COMPLETED", "FAILED"}:
            raise CloudSourceError("执行结果状态无效")
        safe_summary = "".join(char for char in str(summary or "") if ord(char) >= 32).strip()[:1000]
        update = {
            "update": "ci_change_proposals",
            "updates": [{
                "q": {
                    "_id": safe_proposal_id,
                    "status": "EXECUTING",
                    "executionLeaseId": safe_lease_id,
                },
                "u": {
                    "$set": {
                        "status": normalized_status,
                        "executionSummary": safe_summary,
                        "executionFinishedAt": now,
                        "updatedAt": now,
                    },
                    "$unset": {"executionLeaseId": ""},
                    "$inc": {"version": 1},
                },
                "upsert": False,
                "multi": False,
            }],
        }
        self._execute_commands([{
            "TableName": "ci_change_proposals",
            "CommandType": "UPDATE",
            "Command": json.dumps(update, ensure_ascii=False, separators=(",", ":")),
        }], "回写执行结果")
        saved = self._query_one(
            "ci_change_proposals", safe_proposal_id, ("_id", "status", "executionSummary")
        )
        if not saved or saved.get("status") != normalized_status:
            raise CloudSourceError("执行结果回写后校验失败")

    def sync_feedback_for_proposal(
        self, proposal_id: str, status: str, now: str
    ) -> None:
        safe_proposal_id = self._safe_id(proposal_id, "proposalId")
        normalized_status = str(status or "").strip().upper()
        if normalized_status not in {"COMPLETED", "FAILED"}:
            raise CloudSourceError("反馈同步结果状态无效")
        if normalized_status == "FAILED":
            return
        update = {
            "update": "ci_feedback",
            "updates": [{
                "q": {
                    "proposalId": safe_proposal_id,
                    "status": "INCLUDED_IN_PROPOSAL",
                },
                "u": {
                    "$set": {"status": "CLOSED", "updatedAt": now},
                    "$inc": {"version": 1},
                },
                "upsert": False,
                "multi": True,
            }],
        }
        self._execute_commands([{
            "TableName": "ci_feedback",
            "CommandType": "UPDATE",
            "Command": json.dumps(update, ensure_ascii=False, separators=(",", ":")),
        }], "同步关联反馈结果")

    def load(self) -> SourceResult:
        collections = {name: [] for name in READ_COLLECTIONS}
        offsets = {name: 0 for name in READ_COLLECTIONS}
        active = list(READ_COLLECTIONS)
        truncated: set[str] = set()

        while active:
            batch = self._query_batch(active, offsets)
            next_active: list[str] = []
            for name, rows in zip(active, batch, strict=True):
                remaining = self.settings.max_documents_per_collection - len(collections[name])
                collections[name].extend(rows[:remaining])
                if len(rows) > max(remaining, 0):
                    truncated.add(name)
                    continue
                if remaining <= 0:
                    continue
                requested = min(self.settings.page_size, remaining + 1)
                if len(rows) >= requested:
                    offsets[name] += len(rows)
                    next_active.append(name)
            active = next_active

        return SourceResult(
            collections=collections,
            truncated_collections=tuple(sorted(truncated)),
            source_name="cloudbase-cli",
        )


def create_source(settings: AdminSettings) -> CloudSource:
    if settings.snapshot_file:
        return JsonSnapshotSource(settings.snapshot_file)
    return TcbCliSource(settings)
