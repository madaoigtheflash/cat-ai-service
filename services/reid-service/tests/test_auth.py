from __future__ import annotations

import json
import time
from dataclasses import replace

from fastapi.testclient import TestClient

from app.auth import NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, calculate_signature
from app.config import Settings
from app.main import create_app

from conftest import StaticImageFetcher, process_payload

PROCESS_PATH = "/internal/v1/reid/process"
TEST_SECRET = "unit-test-worker-secret-at-least-32-bytes"


def _signed_headers(
    body: bytes,
    *,
    timestamp: int | None = None,
    nonce: str = "nonce-unit-test-0001",
    secret: str = TEST_SECRET,
) -> dict[str, str]:
    timestamp_text = str(int(time.time()) if timestamp is None else timestamp)
    return {
        "Content-Type": "application/json",
        TIMESTAMP_HEADER: timestamp_text,
        NONCE_HEADER: nonce,
        SIGNATURE_HEADER: calculate_signature(
            secret,
            "POST",
            PROCESS_PATH,
            timestamp_text,
            nonce,
            body,
        ),
    }


def _secure_settings(settings: Settings) -> Settings:
    return replace(settings, worker_hmac_secret=TEST_SECRET, hmac_max_skew_seconds=60)


def _json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def test_ready_marks_hmac_as_required(image_bytes: bytes, stub_settings: Settings) -> None:
    payload = process_payload(image_bytes, [])
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(_secure_settings(stub_settings), fetcher)) as client:
        health = client.get("/internal/v1/health")
        ready = client.get("/internal/v1/ready")
    assert health.status_code == 200
    assert ready.status_code == 200
    assert ready.json()["data"]["authRequired"] is True
    assert ready.json()["data"]["authScheme"] == "hmac-sha256-v1"


def test_missing_hmac_is_rejected_before_request_validation(
    image_bytes: bytes,
    stub_settings: Settings,
) -> None:
    fetcher = StaticImageFetcher({})
    with TestClient(create_app(_secure_settings(stub_settings), fetcher)) as client:
        response = client.post(PROCESS_PATH, content=b"{}", headers={"Content-Type": "application/json"})
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "HMAC"
    assert response.json()["error"]["code"] == "AUTH_REQUIRED"
    assert fetcher.calls == []


def test_valid_hmac_allows_process_and_replayed_nonce_is_rejected(
    image_bytes: bytes,
    stub_settings: Settings,
) -> None:
    payload = process_payload(image_bytes, [])
    body = _json_bytes(payload)
    headers = _signed_headers(body)
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(_secure_settings(stub_settings), fetcher)) as client:
        accepted = client.post(PROCESS_PATH, content=body, headers=headers)
        replayed = client.post(PROCESS_PATH, content=body, headers=headers)
    assert accepted.status_code == 200
    assert accepted.json()["data"]["testOnly"] is True
    assert replayed.status_code == 401
    assert replayed.json()["error"]["code"] == "AUTH_REPLAYED_NONCE"
    assert fetcher.calls == [payload["image"]["url"]]


def test_expired_hmac_is_rejected(image_bytes: bytes, stub_settings: Settings) -> None:
    payload = process_payload(image_bytes, [])
    body = _json_bytes(payload)
    headers = _signed_headers(body, timestamp=int(time.time()) - 120, nonce="nonce-expired-0001")
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(_secure_settings(stub_settings), fetcher)) as client:
        response = client.post(PROCESS_PATH, content=body, headers=headers)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTH_TIMESTAMP_EXPIRED"
    assert fetcher.calls == []


def test_bad_signature_and_tampered_body_are_rejected(
    image_bytes: bytes,
    stub_settings: Settings,
) -> None:
    payload = process_payload(image_bytes, [])
    body = _json_bytes(payload)
    bad_headers = _signed_headers(body, nonce="nonce-bad-signature-1")
    bad_headers[SIGNATURE_HEADER] = "0" * 64
    tampered_headers = _signed_headers(body, nonce="nonce-tampered-body-1")
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(_secure_settings(stub_settings), fetcher)) as client:
        bad_signature = client.post(PROCESS_PATH, content=body, headers=bad_headers)
        tampered = client.post(PROCESS_PATH, content=body + b" ", headers=tampered_headers)
    assert bad_signature.status_code == 401
    assert bad_signature.json()["error"]["code"] == "AUTH_SIGNATURE_INVALID"
    assert tampered.status_code == 401
    assert tampered.json()["error"]["code"] == "AUTH_SIGNATURE_INVALID"
    assert fetcher.calls == []


def test_invalid_timestamp_and_nonce_are_rejected(image_bytes: bytes, stub_settings: Settings) -> None:
    payload = process_payload(image_bytes, [])
    body = _json_bytes(payload)
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(_secure_settings(stub_settings), fetcher)) as client:
        timestamp_headers = _signed_headers(body, nonce="nonce-invalid-time-1")
        timestamp_headers[TIMESTAMP_HEADER] = "not-a-time"
        bad_timestamp = client.post(PROCESS_PATH, content=body, headers=timestamp_headers)

        nonce_headers = _signed_headers(body, nonce="nonce-valid-initial-1")
        nonce_headers[NONCE_HEADER] = "short"
        bad_nonce = client.post(PROCESS_PATH, content=body, headers=nonce_headers)
    assert bad_timestamp.status_code == 401
    assert bad_timestamp.json()["error"]["code"] == "AUTH_TIMESTAMP_INVALID"
    assert bad_nonce.status_code == 401
    assert bad_nonce.json()["error"]["code"] == "AUTH_NONCE_INVALID"
    assert fetcher.calls == []


def test_onnx_mode_fails_closed_without_a_strong_hmac_secret(
    image_bytes: bytes,
    stub_settings: Settings,
) -> None:
    settings = replace(stub_settings, engine_mode="onnx", worker_hmac_secret="short")
    payload = process_payload(image_bytes, [])
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(settings, fetcher)) as client:
        ready = client.get("/internal/v1/ready")
        response = client.post(PROCESS_PATH, json=payload)
    assert ready.status_code == 503
    assert ready.json()["data"]["authRequired"] is True
    assert any("at least 32" in item for item in ready.json()["data"]["errors"])
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AUTH_NOT_CONFIGURED"
    assert fetcher.calls == []


def test_process_body_is_bounded_before_auth_or_validation(
    image_bytes: bytes,
    stub_settings: Settings,
) -> None:
    settings = replace(stub_settings, max_request_bytes=64)
    fetcher = StaticImageFetcher({})
    with TestClient(create_app(settings, fetcher)) as client:
        response = client.post(
            PROCESS_PATH,
            content=b"x" * 65,
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "REQUEST_TOO_LARGE"
    assert fetcher.calls == []
