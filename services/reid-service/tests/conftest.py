from __future__ import annotations

import hashlib
import io
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.config import Settings
from app.contracts import ImageSource, encode_embedding
from app.embedder import DeterministicStubEmbedder
from app.preprocess import validate_and_preprocess


class StaticImageFetcher:
    def __init__(self, mapping: dict[str, bytes]) -> None:
        self.mapping = mapping
        self.calls: list[str] = []

    async def fetch(self, source: ImageSource) -> bytes:
        self.calls.append(source.url)
        return self.mapping[source.url]


@pytest.fixture
def image_bytes() -> bytes:
    buffer = io.BytesIO()
    image = Image.new("RGB", (320, 240), (236, 116, 142))
    for x in range(40, 280):
        for y in range(60, 190):
            if (x // 24 + y // 20) % 2 == 0:
                image.putpixel((x, y), (60, 45, 52))
    image.save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


@pytest.fixture
def stub_settings(tmp_path: Path) -> Settings:
    return Settings(
        engine_mode="stub",
        model_path=tmp_path / "model-not-required.onnx",
        allowed_image_hosts=("authorized.example",),
        max_templates=100,
        max_top_k=10,
    )


def source_payload(data: bytes, *, sha256: str | None = None, size_bytes: int | None = None) -> dict[str, object]:
    return {
        "url": "https://authorized.example/signed/cat.jpg?token=test",
        "sha256": sha256 or hashlib.sha256(data).hexdigest(),
        "sizeBytes": len(data) if size_bytes is None else size_bytes,
        "mimeType": "image/jpeg",
    }


def stub_vector(data: bytes, settings: Settings) -> np.ndarray:
    source = ImageSource.model_validate(source_payload(data))
    tensor = validate_and_preprocess(data, source, settings).tensor
    return DeterministicStubEmbedder().embed(tensor)


def embedding_base64(vector: np.ndarray) -> str:
    return encode_embedding(vector).data


def gallery_item(
    template_id: str,
    cat_id: str,
    session_id: str,
    vector: np.ndarray,
) -> dict[str, object]:
    return {
        "templateId": template_id,
        "catId": cat_id,
        "sessionId": session_id,
        "embeddingBase64": embedding_base64(vector),
        "quality": 1.0,
        "view": "body_left",
    }


def process_payload(data: bytes, gallery: list[dict[str, object]], *, top_k: int = 5) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "requestId": "req-test-1",
        "idempotencyKey": "idem-test-1",
        "gallerySnapshotId": "gallery-test-1",
        "image": source_payload(data),
        "gallery": gallery,
        "topK": top_k,
    }

