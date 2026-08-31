"""HMAC-SHA256 authentication for the process endpoint."""

from __future__ import annotations

import hashlib
import hmac
import re
import threading
import time
from collections.abc import Mapping

from .errors import ServiceError

AUTH_SCHEME = "hmac-sha256-v1"
TIMESTAMP_HEADER = "X-CatAI-Timestamp"
NONCE_HEADER = "X-CatAI-Nonce"
SIGNATURE_HEADER = "X-CatAI-Signature"

_TIMESTAMP_RE = re.compile(r"^[0-9]{10,13}$")
_NONCE_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_SIGNATURE_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def body_sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical_message(method: str, path: str, timestamp: str, nonce: str, body: bytes) -> bytes:
    """Build the exact v1 canonical message.

    The request body is hashed byte-for-byte. A caller must sign the same JSON
    bytes it transmits, not a parsed/re-serialized object.
    """

    canonical = "|".join(
        (
            method.upper(),
            path,
            timestamp,
            nonce,
            body_sha256(body),
        )
    )
    return canonical.encode("utf-8")


def calculate_signature(
    secret: str,
    method: str,
    path: str,
    timestamp: str,
    nonce: str,
    body: bytes,
) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        canonical_message(method, path, timestamp, nonce, body),
        hashlib.sha256,
    ).hexdigest()


def verify_signature(
    *,
    secret: str,
    method: str,
    path: str,
    headers: Mapping[str, str],
    body: bytes,
    max_skew_seconds: int,
    now_seconds: float | None = None,
) -> tuple[str, int]:
    """Verify required headers and return ``(nonce, timestamp)``.

    Raises a deliberately coarse ServiceError; no computed MAC or body hash is
    ever returned to the caller.
    """

    timestamp_raw = headers.get(TIMESTAMP_HEADER)
    nonce = headers.get(NONCE_HEADER)
    signature = headers.get(SIGNATURE_HEADER)
    if timestamp_raw is None or nonce is None or signature is None:
        raise ServiceError(
            "AUTH_REQUIRED",
            "Valid worker HMAC headers are required",
            status_code=401,
            retryable=False,
        )
    if not _TIMESTAMP_RE.fullmatch(timestamp_raw):
        raise ServiceError(
            "AUTH_TIMESTAMP_INVALID",
            "HMAC timestamp is invalid",
            status_code=401,
            retryable=False,
        )
    if not _NONCE_RE.fullmatch(nonce):
        raise ServiceError(
            "AUTH_NONCE_INVALID",
            "HMAC nonce is invalid",
            status_code=401,
            retryable=False,
        )
    if not _SIGNATURE_RE.fullmatch(signature):
        raise ServiceError(
            "AUTH_SIGNATURE_INVALID",
            "HMAC signature is invalid",
            status_code=401,
            retryable=False,
        )

    timestamp = int(timestamp_raw)
    now = time.time() if now_seconds is None else now_seconds
    if abs(now - timestamp) > max_skew_seconds:
        raise ServiceError(
            "AUTH_TIMESTAMP_EXPIRED",
            "HMAC timestamp is outside the allowed clock window",
            status_code=401,
            retryable=False,
        )

    expected = calculate_signature(secret, method, path, timestamp_raw, nonce, body)
    if not hmac.compare_digest(signature.lower(), expected):
        raise ServiceError(
            "AUTH_SIGNATURE_INVALID",
            "HMAC signature is invalid",
            status_code=401,
            retryable=False,
        )
    return nonce, timestamp


class NonceReplayGuard:
    """Bounded, process-local replay protection for the HMAC validity window."""

    def __init__(self, max_skew_seconds: int) -> None:
        self._ttl_seconds = max_skew_seconds * 2
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def accept(self, nonce: str, now_seconds: float | None = None) -> bool:
        now = time.time() if now_seconds is None else now_seconds
        cutoff = now - self._ttl_seconds
        with self._lock:
            expired = [key for key, seen_at in self._seen.items() if seen_at < cutoff]
            for key in expired:
                del self._seen[key]
            if nonce in self._seen:
                return False
            self._seen[nonce] = now
            return True

