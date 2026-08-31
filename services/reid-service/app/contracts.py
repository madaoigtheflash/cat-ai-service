"""Pydantic contracts for the internal worker API."""

from __future__ import annotations

import base64
import binascii
import math
from datetime import datetime
from typing import Annotated, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

from .constants import (
    DEFAULT_CROP_VERSION,
    EMBEDDING_DIMENSION,
    EMBEDDING_ENCODING,
    MODEL_ID,
    MODEL_SHA256,
    MODEL_VERSION,
    PREPROCESS_VERSION,
)

SafeId = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:@/-]+$"),
]
Sha256Hex = Annotated[str, StringConstraints(to_lower=True, pattern=r"^[0-9a-fA-F]{64}$")]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)


class ModelContract(ContractModel):
    model_id: Literal[MODEL_ID] = Field(default=MODEL_ID, alias="modelId")
    model_sha256: Literal[MODEL_SHA256] = Field(default=MODEL_SHA256, alias="modelSha256")
    preprocess_version: Literal[PREPROCESS_VERSION] = Field(
        default=PREPROCESS_VERSION,
        alias="preprocessVersion",
    )
    crop_version: SafeId = Field(default=DEFAULT_CROP_VERSION, alias="cropVersion")
    dimension: Literal[EMBEDDING_DIMENSION] = EMBEDDING_DIMENSION
    encoding: Literal[EMBEDDING_ENCODING] = EMBEDDING_ENCODING


class ImageSource(ContractModel):
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2048)]
    sha256: Sha256Hex
    size_bytes: int = Field(gt=0, alias="sizeBytes")
    mime_type: Literal["image/jpeg", "image/png", "image/webp"] = Field(alias="mimeType")


class GalleryTemplate(ContractModel):
    template_id: SafeId = Field(alias="templateId")
    cat_id: SafeId = Field(alias="catId")
    session_id: SafeId = Field(alias="sessionId")
    embedding_base64: str = Field(alias="embeddingBase64", min_length=4, max_length=4096)
    quality: float = Field(default=1.0, ge=0.0, le=1.0)
    view: str | None = Field(default=None, max_length=32)

    @field_validator("embedding_base64")
    @classmethod
    def validate_embedding(cls, value: str) -> str:
        decode_embedding(value)
        return value


class ProcessRequest(ContractModel):
    schema_version: Literal[1] = Field(alias="schemaVersion")
    request_id: SafeId = Field(alias="requestId")
    idempotency_key: SafeId = Field(alias="idempotencyKey")
    gallery_snapshot_id: SafeId = Field(alias="gallerySnapshotId")
    contract: ModelContract = Field(default_factory=ModelContract)
    image: ImageSource
    gallery: list[GalleryTemplate] = Field(default_factory=list, max_length=5_000)
    top_k: int = Field(default=5, ge=1, le=50, alias="topK")

    @model_validator(mode="after")
    def reject_duplicate_templates(self) -> "ProcessRequest":
        template_ids = [item.template_id for item in self.gallery]
        if len(template_ids) != len(set(template_ids)):
            raise ValueError("gallery contains duplicate templateId values")
        return self


class ErrorBody(ContractModel):
    code: str
    message: str
    retryable: bool


class ErrorEnvelope(ContractModel):
    ok: Literal[False] = False
    request_id: str | None = Field(default=None, alias="requestId")
    server_time: datetime = Field(alias="serverTime")
    error: ErrorBody


class HealthResponse(ContractModel):
    ok: Literal[True] = True
    service: Literal["cat-ai-reid-service"] = "cat-ai-reid-service"
    status: Literal["alive"] = "alive"
    server_time: datetime = Field(alias="serverTime")


class ReadyData(ContractModel):
    ready: bool
    engine: str
    test_only: bool = Field(alias="testOnly")
    auth_required: bool = Field(alias="authRequired")
    auth_scheme: Literal["hmac-sha256-v1", "disabled"] = Field(alias="authScheme")
    model_present: bool = Field(alias="modelPresent")
    model_contract_valid: bool = Field(alias="modelContractValid")
    model_version: str = Field(default=MODEL_VERSION, alias="modelVersion")
    model_sha256: str = Field(default=MODEL_SHA256, alias="modelSha256")
    index_mode: Literal["request_exact_numpy"] = Field(
        default="request_exact_numpy",
        alias="indexMode",
    )
    index_ready: bool = Field(alias="indexReady")
    errors: list[str] = Field(default_factory=list)


class ReadyResponse(ContractModel):
    ok: bool
    server_time: datetime = Field(alias="serverTime")
    data: ReadyData


class TemplateMatch(ContractModel):
    rank: int
    template_id: str = Field(alias="templateId")
    cat_id: str = Field(alias="catId")
    session_id: str = Field(alias="sessionId")
    cosine_similarity: float = Field(alias="cosineSimilarity")


class IdentityCandidate(ContractModel):
    rank: int
    cat_id: str = Field(alias="catId")
    retrieval_score: float = Field(alias="retrievalScore")
    best_similarity: float = Field(alias="bestSimilarity")
    mean_top_sessions: float = Field(alias="meanTopSessions")
    median_session_similarity: float = Field(alias="medianSessionSimilarity")
    session_stddev: float = Field(alias="sessionStddev")
    independent_sessions: int = Field(alias="independentSessions")
    templates_compared: int = Field(alias="templatesCompared")
    best_template_id: str = Field(alias="bestTemplateId")


class QueryEmbedding(ContractModel):
    encoding: Literal[EMBEDDING_ENCODING] = EMBEDDING_ENCODING
    dimension: Literal[EMBEDDING_DIMENSION] = EMBEDDING_DIMENSION
    data: str
    sha256: str


class ImageInfo(ContractModel):
    mime_type: str = Field(alias="mimeType")
    size_bytes: int = Field(alias="sizeBytes")
    width: int
    height: int


class ProcessData(ContractModel):
    gallery_snapshot_id: str = Field(alias="gallerySnapshotId")
    model_version: str = Field(default=MODEL_VERSION, alias="modelVersion")
    model_sha256: str = Field(default=MODEL_SHA256, alias="modelSha256")
    preprocess_version: str = Field(default=PREPROCESS_VERSION, alias="preprocessVersion")
    crop_version: str = Field(alias="cropVersion")
    engine: str
    test_only: bool = Field(alias="testOnly")
    search_mode: Literal["exact_cosine"] = Field(default="exact_cosine", alias="searchMode")
    decision_policy: Literal["candidate_only"] = Field(
        default="candidate_only",
        alias="decisionPolicy",
    )
    image: ImageInfo
    query_embedding: QueryEmbedding = Field(alias="queryEmbedding")
    candidates: list[IdentityCandidate]
    template_matches: list[TemplateMatch] = Field(alias="templateMatches")
    templates_compared: int = Field(alias="templatesCompared")
    identities_compared: int = Field(alias="identitiesCompared")


class ProcessEnvelope(ContractModel):
    ok: Literal[True] = True
    request_id: str = Field(alias="requestId")
    server_time: datetime = Field(alias="serverTime")
    data: ProcessData


def decode_embedding(value: str) -> np.ndarray:
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("embeddingBase64 must be strict base64") from exc
    expected_bytes = EMBEDDING_DIMENSION * 4
    if len(raw) != expected_bytes:
        raise ValueError(f"embeddingBase64 must contain exactly {expected_bytes} bytes")
    vector = np.frombuffer(raw, dtype="<f4").astype(np.float32, copy=True)
    if not np.isfinite(vector).all():
        raise ValueError("embedding contains non-finite values")
    norm = float(np.linalg.norm(vector.astype(np.float64)))
    if not math.isfinite(norm) or not 0.98 <= norm <= 1.02:
        raise ValueError("embedding must be L2-normalized (norm in [0.98, 1.02])")
    return vector / np.float32(norm)


def encode_embedding(vector: np.ndarray) -> QueryEmbedding:
    normalized = np.asarray(vector, dtype=np.float32).reshape(-1)
    if normalized.shape != (EMBEDDING_DIMENSION,) or not np.isfinite(normalized).all():
        raise ValueError("query embedding violates the 512D finite contract")
    norm = float(np.linalg.norm(normalized.astype(np.float64)))
    if not math.isfinite(norm) or norm <= 1e-12:
        raise ValueError("query embedding has zero or invalid norm")
    normalized = normalized / np.float32(norm)
    raw = normalized.astype("<f4", copy=False).tobytes(order="C")
    import hashlib

    return QueryEmbedding(data=base64.b64encode(raw).decode("ascii"), sha256=hashlib.sha256(raw).hexdigest())
