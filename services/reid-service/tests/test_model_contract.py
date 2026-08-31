from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import pytest

from app.constants import EMBEDDING_DIMENSION, MODEL_FILENAME
from app.embedder import OnnxEmbedder


REPO_ROOT = Path(__file__).resolve().parents[3]
MODEL_PATH = REPO_ROOT / "tools" / "pet_reid" / "models" / MODEL_FILENAME


@pytest.mark.skipif(
    not MODEL_PATH.is_file() or importlib.util.find_spec("onnxruntime") is None,
    reason="The pinned optional ONNX artifact/runtime is not installed",
)
def test_pinned_onnx_model_loads_and_emits_unit_embedding() -> None:
    embedder = OnnxEmbedder(MODEL_PATH)
    tensor = np.zeros((1, 3, 224, 224), dtype=np.float32)
    vector = embedder.embed(tensor)
    assert vector.shape == (EMBEDDING_DIMENSION,)
    assert vector.dtype == np.float32
    assert np.isfinite(vector).all()
    assert float(np.linalg.norm(vector)) == pytest.approx(1.0, abs=1e-5)

