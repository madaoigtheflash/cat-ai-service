"""Cat-AI CloudBase 本地受审计管理台。"""

from __future__ import annotations

import asyncio
import copy
import time
import uuid
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .cloudbase_cli import CloudSource, CloudSourceError, create_source
from .codex_workflow import (
    CodexWorkflow,
    CodexWorkflowError,
    LOCAL_EXECUTABLE_STATUSES,
    MAX_FEEDBACK_PER_AUDIT,
    proposal_document,
    utc_now,
)
from .config import AdminSettings, is_loopback_host
from .projection import build_snapshot


STATIC_DIR = Path(__file__).parent / "static"
FORCE_REFRESH_COOLDOWN_SECONDS = 2.0


class UnavailableSource:
    def __init__(self, message: str):
        self.message = message

    def load(self):
        raise CloudSourceError(self.message)


class SnapshotService:
    def __init__(self, settings: AdminSettings, source: CloudSource):
        self.settings = settings
        self.source = source
        self._snapshot: dict[str, Any] | None = None
        self._loaded_at = 0.0
        self._lock = asyncio.Lock()

    async def get(self, force: bool = False) -> dict[str, Any]:
        now = time.monotonic()
        if (
            force
            and self._snapshot is not None
            and now - self._loaded_at < FORCE_REFRESH_COOLDOWN_SECONDS
        ):
            return copy.deepcopy(self._snapshot)
        if (
            not force
            and self._snapshot is not None
            and now - self._loaded_at <= self.settings.cache_ttl_seconds
        ):
            return copy.deepcopy(self._snapshot)

        async with self._lock:
            now = time.monotonic()
            if (
                force
                and self._snapshot is not None
                and now - self._loaded_at < FORCE_REFRESH_COOLDOWN_SECONDS
            ):
                return copy.deepcopy(self._snapshot)
            if (
                not force
                and self._snapshot is not None
                and now - self._loaded_at <= self.settings.cache_ttl_seconds
            ):
                return copy.deepcopy(self._snapshot)
            try:
                raw = await asyncio.to_thread(self.source.load)
                snapshot = build_snapshot(raw, self.settings.env_id)
            except CloudSourceError:
                if self._snapshot is not None:
                    stale = copy.deepcopy(self._snapshot)
                    stale["stale"] = True
                    stale["warning"] = "云端刷新失败，当前展示上一次成功读取的数据"
                    return stale
                raise
            self._snapshot = snapshot
            self._loaded_at = time.monotonic()
            return copy.deepcopy(snapshot)

    def invalidate(self) -> None:
        self._snapshot = None
        self._loaded_at = 0.0

    async def fresh(self) -> dict[str, Any]:
        """安全敏感写操作前强制回源，不使用冷却期或陈旧缓存。"""
        async with self._lock:
            raw = await asyncio.to_thread(self.source.load)
            snapshot = build_snapshot(raw, self.settings.env_id)
            self._snapshot = snapshot
            self._loaded_at = time.monotonic()
            return copy.deepcopy(snapshot)


class FeedbackAuditRequest(BaseModel):
    feedback_ids: list[str] = Field(alias="feedbackIds", min_length=1, max_length=MAX_FEEDBACK_PER_AUDIT)


class ProposalExecutionRequest(BaseModel):
    expected_version: int = Field(alias="expectedVersion", ge=1)


class CommunityCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    scope: Literal["invite", "private"] = "invite"
    reason: str = Field(default="本地管理台创建", max_length=200)
    idempotency_key: str = Field(alias="idempotencyKey", min_length=8, max_length=128)


class CommunityUpdateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    scope: Literal["invite", "private"] = "invite"
    expected_version: int = Field(alias="expectedVersion", ge=0)
    reason: str = Field(default="本地管理台编辑", max_length=200)
    idempotency_key: str = Field(alias="idempotencyKey", min_length=8, max_length=128)


class CommunityActionRequest(BaseModel):
    expected_version: int = Field(alias="expectedVersion", ge=0)
    reason: str = Field(min_length=2, max_length=200)
    idempotency_key: str = Field(alias="idempotencyKey", min_length=8, max_length=128)


def _safe_error(exc: Exception) -> str:
    text = str(exc).strip().replace("\r", " ").replace("\n", " ")
    return (text or "云端数据读取失败")[:280]


def _safe_request_host(raw_host: str, expected_port: int) -> bool:
    """只接受 loopback Host，阻止恶意域名通过 DNS rebinding 读取管理数据。"""
    value = raw_host.strip()
    if not value or "@" in value or "/" in value or "\\" in value:
        return False
    try:
        parsed = urlsplit(f"//{value}")
        hostname = parsed.hostname or ""
        port = parsed.port
    except ValueError:
        return False
    return is_loopback_host(hostname) and (port is None or port == expected_port)


def _safe_request_origin(raw_origin: str, expected_port: int) -> bool:
    if not raw_origin:
        return True
    try:
        parsed = urlsplit(raw_origin)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme in {"http", "https"}
        and bool(parsed.hostname)
        and is_loopback_host(parsed.hostname or "")
        and port == expected_port
        and not parsed.username
        and not parsed.password
    )


def create_app(
    settings: AdminSettings | None = None,
    source: CloudSource | None = None,
    codex_workflow: Any | None = None,
    *,
    enforce_loopback: bool = True,
) -> FastAPI:
    settings = settings or AdminSettings.from_env()
    settings.validate()
    if source is None:
        try:
            source = create_source(settings)
        except CloudSourceError as exc:
            source = UnavailableSource(_safe_error(exc))

    service = SnapshotService(settings, source)
    workflow_lock = asyncio.Lock()
    workflow_holder = {"value": codex_workflow}
    workflow_writes_enabled = all(callable(getattr(source, name, None)) for name in (
        "insert_change_proposal", "link_feedback_to_proposal",
        "claim_change_proposal", "complete_change_proposal", "sync_feedback_for_proposal",
    )) and not isinstance(source, UnavailableSource)
    community_writes_enabled = callable(getattr(source, "mutate_community", None)) and not isinstance(
        source, UnavailableSource
    )
    community_write_lock = asyncio.Lock()

    def require_workflow_writes() -> None:
        if not workflow_writes_enabled:
            raise HTTPException(status_code=503, detail="当前数据源不支持反馈工作流写入")

    def require_community_writes() -> None:
        if not community_writes_enabled:
            raise HTTPException(status_code=503, detail="当前数据源不支持小屋管理写入")

    async def mutate_community(payload: dict[str, Any]) -> dict[str, Any]:
        require_community_writes()
        async with community_write_lock:
            try:
                result = await asyncio.to_thread(source.mutate_community, payload)
            except CloudSourceError as exc:
                message = _safe_error(exc)
                status = 409 if message.startswith(("VERSION_CONFLICT:", "STATE_CONFLICT:", "CONFLICT:")) else 404 if message.startswith("NOT_FOUND:") else 503
                raise HTTPException(status_code=status, detail=message.split(": ", 1)[-1]) from exc
            service.invalidate()
            return result

    def get_codex_workflow():
        if workflow_holder["value"] is None:
            try:
                workflow_holder["value"] = CodexWorkflow()
            except CodexWorkflowError as exc:
                raise HTTPException(status_code=503, detail=_safe_error(exc)) from exc
        return workflow_holder["value"]

    def codex_available() -> bool:
        if workflow_holder["value"] is not None:
            return True
        try:
            workflow_holder["value"] = CodexWorkflow()
        except CodexWorkflowError:
            return False
        return True
    app = FastAPI(
        title="Cat-AI 云端管理台",
        description="本机聚合 CloudBase 数据，并受控处理反馈、Codex 审计与本地确认修改",
        version="1.2.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings
    app.state.snapshot_service = service

    @app.middleware("http")
    async def local_only_and_security_headers(request: Request, call_next):
        client_host = request.client.host if request.client else ""
        host_ok = _safe_request_host(request.headers.get("host", ""), settings.port)
        origin_ok = _safe_request_origin(request.headers.get("origin", ""), settings.port)
        fetch_site = request.headers.get("sec-fetch-site", "").lower()
        if enforce_loopback and (
            not is_loopback_host(client_host)
            or not host_ok
            or not origin_ok
            or fetch_site == "cross-site"
        ):
            return JSONResponse(
                status_code=421 if not host_ok else 403,
                content={"ok": False, "error": "本地管理台只接受同源的本机连接"},
            )
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        return response

    @app.exception_handler(CloudSourceError)
    async def cloud_source_error_handler(_: Request, exc: CloudSourceError):
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "error": {
                    "code": "CLOUD_SOURCE_UNAVAILABLE",
                    "message": _safe_error(exc),
                    "retryable": True,
                },
            },
        )

    @app.get("/api/health")
    async def health():
        source_configured = not isinstance(source, UnavailableSource)
        snapshot_loaded = service._snapshot is not None
        return {
            "ok": True,
            "service": "cat-ai-cloud-admin",
            "readOnly": False,
            "primaryDataReadOnly": not community_writes_enabled,
            "communityWritesEnabled": community_writes_enabled,
            "feedbackWorkflowWritesEnabled": workflow_writes_enabled,
            "codexAvailable": codex_available(),
            "localOnly": True,
            "cloudSourceConfigured": source_configured,
            "snapshotLoaded": snapshot_loaded,
            "cloudReady": snapshot_loaded,
            "envId": settings.env_id,
            "cacheTtlSeconds": settings.cache_ttl_seconds,
        }

    @app.get("/api/snapshot")
    async def snapshot(refresh: bool = Query(False)):
        return {"ok": True, "data": await service.get(force=refresh)}

    @app.get("/api/communities")
    async def communities(
        refresh: bool = Query(False),
        q: str = Query("", max_length=80),
        status: str = Query("", max_length=24),
        min_members: int = Query(0, alias="minMembers", ge=0),
        max_members: int | None = Query(None, alias="maxMembers", ge=0),
    ):
        payload = await service.get(force=refresh)
        rows = payload["communities"]
        needle = q.strip().casefold()
        if needle:
            rows = [item for item in rows if needle in f"{item['name']} {item['id']}".casefold()]
        if status:
            rows = [item for item in rows if item["status"] == status]
        rows = [item for item in rows if item["memberCount"] >= min_members]
        if max_members is not None:
            rows = [item for item in rows if item["memberCount"] <= max_members]
        return {
            "ok": True,
            "data": rows,
            "count": len(rows),
            "generatedAt": payload["generatedAt"],
            "stale": bool(payload.get("stale")),
        }

    @app.get("/api/communities/{community_id}")
    async def community_detail(community_id: str, refresh: bool = Query(False)):
        payload = await service.get(force=refresh)
        community = next((item for item in payload["communities"] if item["id"] == community_id), None)
        if not community:
            raise HTTPException(status_code=404, detail="小屋不存在")
        return {
            "ok": True,
            "data": {
                "community": community,
                "members": [item for item in payload.get("members", []) if item["communityId"] == community_id],
                "cats": [item for item in payload["cats"] if item["communityId"] == community_id],
                "relationships": [
                    item for item in payload["relationships"] if item["communityId"] == community_id
                ],
                "sightings": [
                    item for item in payload["sightings"] if item["communityId"] == community_id
                ],
                "mapCells": [
                    item for item in payload["mapCells"] if item["communityId"] == community_id
                ],
                "issues": [
                    item for item in payload["issues"] if item["communityId"] == community_id
                ],
                "auditLogs": [
                    item for item in payload.get("auditLogs", []) if item["entityId"] == community_id
                ],
                "feedback": [],
                "feedbackLinkSupported": False,
            },
            "generatedAt": payload["generatedAt"],
        }

    @app.post("/api/communities")
    async def create_community(body: CommunityCreateRequest):
        data = await mutate_community({
            "operation": "create", "patch": {"name": body.name.strip(), "scope": body.scope},
            "reason": body.reason.strip(), "idempotencyKey": body.idempotency_key,
        })
        return {"ok": True, "data": data}

    @app.patch("/api/communities/{community_id}")
    async def update_community(community_id: str, body: CommunityUpdateRequest):
        data = await mutate_community({
            "operation": "update", "communityId": community_id,
            "expectedVersion": body.expected_version,
            "patch": {"name": body.name.strip(), "scope": body.scope},
            "reason": body.reason.strip(), "idempotencyKey": body.idempotency_key,
        })
        return {"ok": True, "data": data}

    @app.post("/api/communities/{community_id}/{operation}")
    async def change_community_state(
        community_id: str,
        operation: Literal["disable", "restore", "delete"],
        body: CommunityActionRequest,
    ):
        data = await mutate_community({
            "operation": operation, "communityId": community_id,
            "expectedVersion": body.expected_version,
            "reason": body.reason.strip(), "idempotencyKey": body.idempotency_key,
        })
        return {"ok": True, "data": data}

    @app.get("/api/cats")
    async def cats(
        community_id: str = Query("", alias="communityId"),
        state: str = Query(""),
        q: str = Query("", max_length=80),
    ):
        payload = await service.get()
        needle = q.strip().casefold()
        rows = payload["cats"]
        if community_id:
            rows = [item for item in rows if item["communityId"] == community_id]
        if state:
            rows = [item for item in rows if item["state"] == state]
        if needle:
            rows = [
                item for item in rows
                if needle in item["displayName"].casefold()
                or needle in item["id"].casefold()
                or needle in item["breed"].casefold()
            ]
        return {"ok": True, "data": rows, "count": len(rows)}

    @app.get("/api/relationships")
    async def relationships(community_id: str = Query("", alias="communityId")):
        payload = await service.get()
        rows = payload["relationships"]
        if community_id:
            rows = [item for item in rows if item["communityId"] == community_id]
        return {"ok": True, "data": rows, "count": len(rows)}

    @app.get("/api/sightings")
    async def sightings(community_id: str = Query("", alias="communityId")):
        payload = await service.get()
        rows = payload["sightings"]
        if community_id:
            rows = [item for item in rows if item["communityId"] == community_id]
        return {"ok": True, "data": rows, "count": len(rows)}

    @app.get("/api/map-distribution")
    async def map_distribution(
        community_id: str = Query("", alias="communityId"),
        cat_id: str = Query("", alias="catId"),
        start: str = Query("", max_length=40),
        end: str = Query("", max_length=40),
        review_status: Literal["APPROVED"] = Query("APPROVED", alias="reviewStatus"),
    ):
        payload = await service.get()
        rows = payload["sightings"]
        if community_id:
            rows = [item for item in rows if item["communityId"] == community_id]
        if cat_id:
            rows = [item for item in rows if item.get("catId") == cat_id]
        if start:
            rows = [item for item in rows if (item.get("reviewedAt") or item.get("submittedAt") or "") >= start]
        if end:
            rows = [item for item in rows if (item.get("reviewedAt") or item.get("submittedAt") or "") <= end]
        rows = [item for item in rows if item.get("state") == review_status and item.get("coarseLocation") and item["coarseLocation"].get("longitude") is not None]
        cells: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            location = row["coarseLocation"]
            key = (row["communityId"], location.get("cellId") or row["id"])
            cell = cells.setdefault(key, {
                **location, "communityId": row["communityId"], "sightingCount": 0,
                "catIds": set(), "catNames": set(), "sightingIds": [], "latestTimeBucket": "",
            })
            cell["sightingCount"] += 1
            if row.get("catId"): cell["catIds"].add(row["catId"])
            if row.get("catName"): cell["catNames"].add(row["catName"])
            cell["sightingIds"].append(row["id"])
            cell["latestTimeBucket"] = max(cell["latestTimeBucket"], row.get("observedTimeBucket") or "")
        safe_cells = [{**cell, "catIds": sorted(cell["catIds"]), "catNames": sorted(cell["catNames"])} for cell in cells.values()]
        return {
            "ok": True,
            "data": {"cells": safe_cells, "sightings": rows, "privacy": {"precisionKm": 2, "exactCoordinatesReturned": False}},
            "count": len(rows),
        }

    @app.get("/api/feedback")
    async def feedback(
        status: str = Query("", max_length=48),
        q: str = Query("", max_length=80),
        refresh: bool = Query(False),
    ):
        payload = await service.get(force=refresh)
        rows = payload.get("feedback", [])
        if status:
            rows = [item for item in rows if item.get("status") == status]
        needle = q.strip().casefold()
        if needle:
            rows = [item for item in rows if needle in " ".join((
                str(item.get("title", "")), str(item.get("content", "")),
                str(item.get("steps", "")), str(item.get("category", "")),
            )).casefold()]
        return {"ok": True, "data": rows, "count": len(rows)}

    @app.post("/api/feedback/audit")
    async def audit_feedback(body: FeedbackAuditRequest):
        require_workflow_writes()
        if workflow_lock.locked():
            raise HTTPException(status_code=409, detail="已有 Codex 工作正在运行")
        async with workflow_lock:
            payload = await service.fresh()
            by_id = {item.get("id"): item for item in payload.get("feedback", [])}
            selected = []
            seen = set()
            for feedback_id in body.feedback_ids:
                if feedback_id in seen:
                    continue
                seen.add(feedback_id)
                item = by_id.get(feedback_id)
                if not item:
                    raise HTTPException(status_code=404, detail=f"反馈不存在：{feedback_id[:40]}")
                if item.get("status") not in {"OPEN", "TRIAGED"}:
                    raise HTTPException(status_code=409, detail="所选反馈已进入其他提案或已经关闭")
                selected.append(item)
            workflow = get_codex_workflow()
            try:
                report = await asyncio.to_thread(workflow.audit, selected)
                proposal = proposal_document(report, [item["id"] for item in selected])
                await asyncio.to_thread(source.insert_change_proposal, proposal)
                await asyncio.to_thread(
                    source.link_feedback_to_proposal,
                    [item["id"] for item in selected],
                    proposal["_id"],
                    proposal["generatedAt"],
                )
            except (CodexWorkflowError, CloudSourceError) as exc:
                raise HTTPException(status_code=503, detail=_safe_error(exc)) from exc
            service.invalidate()
            return {
                "ok": True,
                "data": {
                    "proposalId": proposal["_id"],
                    "status": proposal["status"],
                    "title": proposal["title"],
                    "summary": proposal["summary"],
                    "feedbackCount": proposal["feedbackCount"],
                },
            }

    @app.post("/api/proposals/{proposal_id}/execute")
    async def execute_proposal(proposal_id: str, body: ProposalExecutionRequest):
        require_workflow_writes()
        if workflow_lock.locked():
            raise HTTPException(status_code=409, detail="已有 Codex 工作正在运行")
        async with workflow_lock:
            payload = await service.fresh()
            proposal = next(
                (item for item in payload.get("changeProposals", []) if item.get("id") == proposal_id),
                None,
            )
            if not proposal:
                raise HTTPException(status_code=404, detail="修改提案不存在")
            if proposal.get("status") not in LOCAL_EXECUTABLE_STATUSES:
                raise HTTPException(status_code=409, detail="提案不在等待本机审阅状态")
            if int(proposal.get("version") or 0) != body.expected_version:
                raise HTTPException(status_code=409, detail="提案版本已变化，请刷新后重试")
            lease_id = f"lease_{uuid.uuid4().hex}"
            now = utc_now()
            await asyncio.to_thread(
                source.claim_change_proposal,
                proposal_id,
                body.expected_version,
                lease_id,
                now,
            )
            workflow = get_codex_workflow()
            try:
                summary = await asyncio.to_thread(workflow.execute, proposal)
            except Exception as exc:
                safe_message = _safe_error(exc)
                try:
                    await asyncio.to_thread(
                        source.complete_change_proposal,
                        proposal_id,
                        lease_id,
                        "FAILED",
                        safe_message,
                        utc_now(),
                    )
                    await asyncio.to_thread(
                        source.sync_feedback_for_proposal,
                        proposal_id,
                        "FAILED",
                        utc_now(),
                    )
                except CloudSourceError:
                    pass
                service.invalidate()
                if isinstance(exc, CodexWorkflowError):
                    raise HTTPException(status_code=503, detail=safe_message) from exc
                raise
            await asyncio.to_thread(
                source.complete_change_proposal,
                proposal_id,
                lease_id,
                "COMPLETED",
                summary,
                utc_now(),
            )
            try:
                await asyncio.to_thread(
                    source.sync_feedback_for_proposal,
                    proposal_id,
                    "COMPLETED",
                    utc_now(),
                )
            except CloudSourceError:
                # 展示阶段仍可由已完成的提案安全派生；后续重复同步可修复反馈行。
                pass
            service.invalidate()
            return {"ok": True, "data": {"proposalId": proposal_id, "status": "COMPLETED", "summary": summary}}

    app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="cloud-admin-assets")

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(STATIC_DIR / "index.html")

    return app


app = create_app()
