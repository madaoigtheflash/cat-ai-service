from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

from app.config import Settings
from app.auth import NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, calculate_signature
from app.main import create_app

from conftest import StaticImageFetcher, gallery_item, process_payload, source_payload, stub_vector


def test_health_and_stub_readiness_without_model(
    image_bytes: bytes,
    stub_settings: Settings,
) -> None:
    fetcher = StaticImageFetcher({source_payload(image_bytes)["url"]: image_bytes})
    with TestClient(create_app(stub_settings, fetcher)) as client:
        health = client.get("/internal/v1/health")
        assert health.status_code == 200
        assert health.json()["status"] == "alive"

        ready = client.get("/internal/v1/ready")
        assert ready.status_code == 200
        assert ready.json()["data"]["authRequired"] is False
        assert ready.json()["data"]["authScheme"] == "disabled"
        assert ready.json()["data"] == {
            **ready.json()["data"],
            "ready": True,
            "engine": "deterministic-stub",
            "testOnly": True,
            "modelPresent": False,
            "modelContractValid": True,
            "indexMode": "request_exact_numpy",
            "indexReady": True,
            "errors": [],
        }


def test_process_is_deterministic_and_returns_exact_top_k(
    image_bytes: bytes,
    stub_settings: Settings,
) -> None:
    query = stub_vector(image_bytes, stub_settings)
    basis = np.zeros_like(query)
    basis[int(np.argmin(np.abs(query)))] = 1.0
    orthogonal = basis - np.dot(basis, query) * query
    orthogonal /= np.linalg.norm(orthogonal)
    medium = np.asarray(0.8 * query + 0.6 * orthogonal, dtype=np.float32)
    medium /= np.linalg.norm(medium)

    gallery = [
        gallery_item("tpl-medium", "cat-medium", "session-1", medium),
        gallery_item("tpl-same", "cat-same", "session-1", query),
        gallery_item("tpl-negative", "cat-negative", "session-1", -query),
    ]
    payload = process_payload(image_bytes, gallery, top_k=2)
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})

    with TestClient(create_app(stub_settings, fetcher)) as client:
        first = client.post("/internal/v1/reid/process", json=payload)
        second = client.post("/internal/v1/reid/process", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    first_data = first.json()["data"]
    second_data = second.json()["data"]
    assert first_data["testOnly"] is True
    assert first_data["decisionPolicy"] == "candidate_only"
    assert first_data["searchMode"] == "exact_cosine"
    assert first_data["templatesCompared"] == 3
    assert first_data["identitiesCompared"] == 3
    assert [item["catId"] for item in first_data["candidates"]] == ["cat-same", "cat-medium"]
    assert [item["templateId"] for item in first_data["templateMatches"]] == ["tpl-same", "tpl-medium"]
    assert abs(first_data["candidates"][0]["bestSimilarity"] - 1.0) < 1e-6
    assert abs(first_data["candidates"][1]["bestSimilarity"] - 0.8) < 1e-5
    assert first_data["queryEmbedding"] == second_data["queryEmbedding"]
    assert first_data["candidates"] == second_data["candidates"]
    assert fetcher.calls == [payload["image"]["url"], payload["image"]["url"]]


def test_process_supports_an_empty_gallery(image_bytes: bytes, stub_settings: Settings) -> None:
    payload = process_payload(image_bytes, [], top_k=5)
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(stub_settings, fetcher)) as client:
        response = client.post("/internal/v1/reid/process", json=payload)
    assert response.status_code == 200
    assert response.json()["data"]["candidates"] == []
    assert response.json()["data"]["templateMatches"] == []


def test_bad_embedding_is_rejected(
    image_bytes: bytes,
    stub_settings: Settings,
) -> None:
    payload = process_payload(
        image_bytes,
        [
            {
                "templateId": "bad-a",
                "catId": "cat-a",
                "sessionId": "session-1",
                "embeddingBase64": "AAAA",
            },
            {
                "templateId": "bad-b",
                "catId": "cat-b",
                "sessionId": "session-2",
                "embeddingBase64": "AAAA",
            },
        ],
    )
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(stub_settings, fetcher)) as client:
        response = client.post("/internal/v1/reid/process", json=payload)
    assert response.status_code == 422
    assert response.json()["ok"] is False
    assert response.json()["requestId"] == "req-test-1"
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert fetcher.calls == []


def test_duplicate_template_ids_are_rejected(
    image_bytes: bytes,
    stub_settings: Settings,
) -> None:
    query = stub_vector(image_bytes, stub_settings)
    payload = process_payload(
        image_bytes,
        [
            gallery_item("duplicate", "cat-a", "session-1", query),
            gallery_item("duplicate", "cat-b", "session-2", -query),
        ],
    )
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(stub_settings, fetcher)) as client:
        response = client.post("/internal/v1/reid/process", json=payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert fetcher.calls == []


def test_wrong_model_contract_is_rejected_before_download(
    image_bytes: bytes,
    stub_settings: Settings,
) -> None:
    payload = process_payload(image_bytes, [])
    payload["contract"] = {"modelSha256": "0" * 64}
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(stub_settings, fetcher)) as client:
        response = client.post("/internal/v1/reid/process", json=payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert fetcher.calls == []


def test_download_hash_mismatch_is_rejected(image_bytes: bytes, stub_settings: Settings) -> None:
    payload = process_payload(image_bytes, [])
    payload["image"]["sha256"] = "0" * 64
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(stub_settings, fetcher)) as client:
        response = client.post("/internal/v1/reid/process", json=payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "IMAGE_HASH_MISMATCH"
    assert response.json()["error"]["retryable"] is False


def test_missing_onnx_model_fails_ready_and_process(tmp_path: Path, image_bytes: bytes) -> None:
    settings = Settings(
        engine_mode="onnx",
        model_path=tmp_path / "missing.onnx",
        allowed_image_hosts=("authorized.example",),
        worker_hmac_secret="unit-test-worker-secret-at-least-32-bytes",
    )
    payload = process_payload(image_bytes, [])
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    timestamp = str(int(time.time()))
    nonce = "nonce-missing-model-0001"
    headers = {
        "Content-Type": "application/json",
        TIMESTAMP_HEADER: timestamp,
        NONCE_HEADER: nonce,
        SIGNATURE_HEADER: calculate_signature(
            settings.worker_hmac_secret,
            "POST",
            "/internal/v1/reid/process",
            timestamp,
            nonce,
            body,
        ),
    }
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(settings, fetcher)) as client:
        ready = client.get("/internal/v1/ready")
        process = client.post("/internal/v1/reid/process", content=body, headers=headers)
    assert ready.status_code == 503
    assert ready.json()["data"]["ready"] is False
    assert ready.json()["data"]["modelContractValid"] is False
    assert process.status_code == 503
    assert process.json()["error"]["code"] == "WORKER_NOT_READY"
    assert fetcher.calls == []


def test_runtime_limits_are_enforced(image_bytes: bytes, stub_settings: Settings) -> None:
    payload = process_payload(image_bytes, [], top_k=5)
    limited = Settings(
        engine_mode="stub",
        model_path=stub_settings.model_path,
        allowed_image_hosts=stub_settings.allowed_image_hosts,
        max_top_k=2,
    )
    fetcher = StaticImageFetcher({payload["image"]["url"]: image_bytes})
    with TestClient(create_app(limited, fetcher)) as client:
        response = client.post("/internal/v1/reid/process", json=payload)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "TOP_K_TOO_LARGE"
