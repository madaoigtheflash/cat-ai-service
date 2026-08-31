"""FastAPI entry point for the isolated Cat-AI Re-ID worker."""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .auth import AUTH_SCHEME, NonceReplayGuard, verify_signature
from .config import Settings
from .contracts import (
    ErrorBody,
    ErrorEnvelope,
    HealthResponse,
    ImageInfo,
    ProcessData,
    ProcessEnvelope,
    ProcessRequest,
    ReadyData,
    ReadyResponse,
    encode_embedding,
)
from .errors import ModelContractError, ServiceError
from .fetcher import HttpImageFetcher, ImageFetcher
from .model_registry import ModelRegistry
from .preprocess import validate_and_preprocess
from .search import exact_search


def utc_now() -> datetime:
    return datetime.now(UTC)


def create_app(settings: Settings | None = None, fetcher: ImageFetcher | None = None) -> FastAPI:
    runtime_settings = settings or Settings.from_env()
    secret_bytes = runtime_settings.worker_hmac_secret.encode("utf-8")
    auth_required = runtime_settings.engine_mode != "stub" or bool(secret_bytes)
    auth_configured = len(secret_bytes) >= 32
    registry = ModelRegistry(runtime_settings)
    image_fetcher = fetcher or HttpImageFetcher(runtime_settings)
    nonce_guard = NonceReplayGuard(runtime_settings.hmac_max_skew_seconds)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await run_in_threadpool(registry.load)
        yield

    app = FastAPI(
        title="Cat-AI Re-ID Service",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.settings = runtime_settings
    app.state.registry = registry
    app.state.fetcher = image_fetcher

    @app.middleware("http")
    async def authenticate_process(request: Request, call_next):
        is_process = request.method.upper() == "POST" and request.url.path == "/internal/v1/reid/process"
        if is_process:
            if auth_required and not auth_configured:
                return _error_response(
                    ErrorEnvelope(
                        requestId=None,
                        serverTime=utc_now(),
                        error=ErrorBody(
                            code="AUTH_NOT_CONFIGURED",
                            message="Worker HMAC is not securely configured",
                            retryable=False,
                        ),
                    ),
                    503,
                )
            try:
                body = await _bounded_body(request, runtime_settings.max_request_bytes)
                if auth_required:
                    nonce, _ = verify_signature(
                        secret=runtime_settings.worker_hmac_secret,
                        method=request.method,
                        path=request.url.path,
                        headers=request.headers,
                        body=body,
                        max_skew_seconds=runtime_settings.hmac_max_skew_seconds,
                    )
                    if not nonce_guard.accept(nonce):
                        raise ServiceError(
                            "AUTH_REPLAYED_NONCE",
                            "HMAC nonce has already been used",
                            status_code=401,
                            retryable=False,
                        )
            except ServiceError as exc:
                return _error_response(
                    ErrorEnvelope(
                        requestId=None,
                        serverTime=utc_now(),
                        error=ErrorBody(code=exc.code, message=exc.message, retryable=exc.retryable),
                    ),
                    exc.status_code,
                    headers={"WWW-Authenticate": "HMAC"},
                )
        return await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, _: RequestValidationError) -> JSONResponse:
        request_id = _request_id_from_body(await _safe_body(request))
        return _error_response(
            ErrorEnvelope(
                requestId=request_id,
                serverTime=utc_now(),
                error=ErrorBody(
                    code="VALIDATION_ERROR",
                    message="Request does not match the Re-ID worker contract",
                    retryable=False,
                ),
            ),
            422,
        )

    @app.exception_handler(ServiceError)
    async def handle_service_error(request: Request, exc: ServiceError) -> JSONResponse:
        request_id = _request_id_from_body(await _safe_body(request))
        return _error_response(
            ErrorEnvelope(
                requestId=request_id,
                serverTime=utc_now(),
                error=ErrorBody(code=exc.code, message=exc.message, retryable=exc.retryable),
            ),
            exc.status_code,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, _: Exception) -> JSONResponse:
        request_id = _request_id_from_body(await _safe_body(request))
        return _error_response(
            ErrorEnvelope(
                requestId=request_id,
                serverTime=utc_now(),
                error=ErrorBody(
                    code="INTERNAL_ERROR",
                    message="Re-identification worker failed unexpectedly",
                    retryable=True,
                ),
            ),
            500,
        )

    @app.get("/internal/v1/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(serverTime=utc_now())

    @app.get("/internal/v1/ready")
    async def ready() -> JSONResponse:
        embedder = registry.embedder
        errors = list(registry.errors)
        if not runtime_settings.allowed_image_hosts:
            errors.append("REID_ALLOWED_IMAGE_HOSTS is empty")
        if auth_required and not auth_configured:
            errors.append("REID_WORKER_HMAC_SECRET must contain at least 32 UTF-8 bytes")
        is_ready = registry.ready and bool(runtime_settings.allowed_image_hosts) and (not auth_required or auth_configured)
        payload = ReadyResponse(
            ok=is_ready,
            serverTime=utc_now(),
            data=ReadyData(
                ready=is_ready,
                engine=embedder.name if embedder else runtime_settings.engine_mode,
                testOnly=bool(embedder and embedder.test_only),
                authRequired=auth_required,
                authScheme=AUTH_SCHEME if auth_required else "disabled",
                modelPresent=bool(embedder and embedder.model_present),
                modelContractValid=registry.ready,
                indexReady=registry.ready,
                errors=errors,
            ),
        )
        return JSONResponse(
            status_code=200 if is_ready else 503,
            content=payload.model_dump(mode="json", by_alias=True),
        )

    @app.post("/internal/v1/reid/process", response_model=ProcessEnvelope)
    async def process(payload: ProcessRequest) -> ProcessEnvelope:
        if len(payload.gallery) > runtime_settings.max_templates:
            raise ServiceError(
                "GALLERY_TOO_LARGE",
                "Gallery exceeds the exact-search template limit",
                status_code=422,
            )
        if payload.top_k > runtime_settings.max_top_k:
            raise ServiceError("TOP_K_TOO_LARGE", "topK exceeds the service limit", status_code=422)
        if payload.image.size_bytes > runtime_settings.max_image_bytes:
            raise ServiceError("IMAGE_TOO_LARGE", "Image exceeds the byte limit", status_code=422)

        embedder = registry.require_embedder()
        image_bytes = await image_fetcher.fetch(payload.image)
        preprocessed = await run_in_threadpool(
            validate_and_preprocess,
            image_bytes,
            payload.image,
            runtime_settings,
        )
        try:
            query_vector = await run_in_threadpool(embedder.embed, preprocessed.tensor)
        except ModelContractError as exc:
            raise ServiceError(
                "INFERENCE_CONTRACT_FAILED",
                "Embedding inference violated the pinned model contract",
                status_code=503,
                retryable=True,
            ) from exc
        candidates, template_matches = await run_in_threadpool(
            exact_search,
            query_vector,
            payload.gallery,
            payload.top_k,
        )
        query_embedding = encode_embedding(query_vector)
        return ProcessEnvelope(
            requestId=payload.request_id,
            serverTime=utc_now(),
            data=ProcessData(
                gallerySnapshotId=payload.gallery_snapshot_id,
                cropVersion=payload.contract.crop_version,
                engine=embedder.name,
                testOnly=embedder.test_only,
                image=ImageInfo(
                    mimeType=preprocessed.mime_type,
                    sizeBytes=preprocessed.size_bytes,
                    width=preprocessed.width,
                    height=preprocessed.height,
                ),
                queryEmbedding=query_embedding,
                candidates=candidates,
                templateMatches=template_matches,
                templatesCompared=len(payload.gallery),
                identitiesCompared=len({item.cat_id for item in payload.gallery}),
            ),
        )

    return app


async def _bounded_body(request: Request, max_bytes: int) -> bytes:
    raw_length = request.headers.get("content-length")
    if raw_length is not None:
        try:
            declared = int(raw_length)
        except ValueError as exc:
            raise ServiceError("INVALID_CONTENT_LENGTH", "Content-Length is invalid", status_code=400) from exc
        if declared < 0 or declared > max_bytes:
            raise ServiceError("REQUEST_TOO_LARGE", "Request body exceeds the configured limit", status_code=413)

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise ServiceError("REQUEST_TOO_LARGE", "Request body exceeds the configured limit", status_code=413)
        chunks.append(chunk)
    body = b"".join(chunks)
    request._body = body
    return body


async def _safe_body(request: Request) -> object:
    try:
        return await request.json()
    except Exception:
        return None


def _request_id_from_body(body: object) -> str | None:
    if not isinstance(body, dict):
        return None
    value = body.get("requestId")
    return value if isinstance(value, str) and len(value) <= 128 else None


def _error_response(
    payload: ErrorEnvelope,
    status_code: int,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=payload.model_dump(mode="json", by_alias=True),
        headers=headers,
    )


app = create_app()
