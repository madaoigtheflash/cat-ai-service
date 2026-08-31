"""Pinned ONNX Runtime embedder and a deterministic, test-only stub."""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Protocol

import numpy as np

from .constants import (
    EMBEDDING_DIMENSION,
    MODEL_INPUT_DTYPE,
    MODEL_INPUT_NAME,
    MODEL_OUTPUT_DTYPE,
    MODEL_OUTPUT_NAME,
    MODEL_SHA256,
    MODEL_SIZE_BYTES,
)
from .errors import ModelContractError


class Embedder(Protocol):
    name: str
    test_only: bool
    model_present: bool

    def embed(self, tensor: np.ndarray) -> np.ndarray: ...


def _normalize_output(value: np.ndarray) -> np.ndarray:
    vector = np.asarray(value, dtype=np.float32)
    if vector.shape == (1, EMBEDDING_DIMENSION):
        vector = vector[0]
    if vector.shape != (EMBEDDING_DIMENSION,):
        raise ModelContractError(f"embedding output has unexpected shape {vector.shape!r}")
    if not np.isfinite(vector).all():
        raise ModelContractError("embedding output contains non-finite values")
    norm = float(np.linalg.norm(vector.astype(np.float64)))
    if not math.isfinite(norm) or not 0.98 <= norm <= 1.02:
        raise ModelContractError(f"embedding output is not L2-normalized (norm={norm:.6f})")
    return np.ascontiguousarray(vector / np.float32(norm), dtype=np.float32)


class DeterministicStubEmbedder:
    """Hash the preprocessed tensor into a stable 512D unit vector.

    This deliberately has no visual semantics and must never be enabled for a
    production deployment. It keeps API, validation and exact-search tests
    usable when neither the 89 MB model nor ONNX Runtime is installed.
    """

    name = "deterministic-stub"
    test_only = True
    model_present = False

    def embed(self, tensor: np.ndarray) -> np.ndarray:
        value = np.asarray(tensor, dtype="<f4")
        if value.shape != (1, 3, 224, 224) or not np.isfinite(value).all():
            raise ModelContractError("stub input violates the pinned tensor contract")
        digest = hashlib.shake_256(np.ascontiguousarray(value).tobytes(order="C")).digest(
            EMBEDDING_DIMENSION * 4
        )
        integers = np.frombuffer(digest, dtype="<u4").astype(np.float64)
        vector = ((integers + 0.5) / float(2**32)) * 2.0 - 1.0
        norm = float(np.linalg.norm(vector))
        if not math.isfinite(norm) or norm <= 1e-12:
            raise ModelContractError("stub generated an invalid vector")
        return np.ascontiguousarray(vector / norm, dtype=np.float32)


class OnnxEmbedder:
    name = "onnxruntime-cpu"
    test_only = False
    model_present = True

    def __init__(self, model_path: Path) -> None:
        model_path = Path(model_path)
        if not model_path.is_file():
            raise ModelContractError(f"model file does not exist: {model_path}")
        if model_path.stat().st_size != MODEL_SIZE_BYTES:
            raise ModelContractError("model file size does not match the pinned artifact")
        if _sha256_file(model_path) != MODEL_SHA256:
            raise ModelContractError("model SHA-256 does not match the pinned artifact")

        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise ModelContractError("onnxruntime is not installed") from exc

        try:
            self._session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        except Exception as exc:  # onnxruntime exposes several backend-specific exceptions
            raise ModelContractError("ONNX Runtime could not load the pinned model") from exc
        self._validate_session_contract()

    def _validate_session_contract(self) -> None:
        inputs = self._session.get_inputs()
        outputs = self._session.get_outputs()
        if len(inputs) != 1 or len(outputs) != 1:
            raise ModelContractError("model must expose exactly one input and one output")
        model_input, model_output = inputs[0], outputs[0]
        if model_input.name != MODEL_INPUT_NAME or model_input.type != MODEL_INPUT_DTYPE:
            raise ModelContractError("model input name or dtype does not match the pinned contract")
        if model_output.name != MODEL_OUTPUT_NAME or model_output.type != MODEL_OUTPUT_DTYPE:
            raise ModelContractError("model output name or dtype does not match the pinned contract")
        if len(model_input.shape) != 4 or tuple(model_input.shape[1:]) != (3, 224, 224):
            raise ModelContractError("model input shape does not match [batch,3,224,224]")
        if len(model_output.shape) != 2 or model_output.shape[1] != EMBEDDING_DIMENSION:
            raise ModelContractError("model output shape does not match [batch,512]")
        if "CPUExecutionProvider" not in self._session.get_providers():
            raise ModelContractError("CPUExecutionProvider is not available")

    def embed(self, tensor: np.ndarray) -> np.ndarray:
        value = np.asarray(tensor, dtype=np.float32)
        if value.shape != (1, 3, 224, 224) or not np.isfinite(value).all():
            raise ModelContractError("model input violates the pinned tensor contract")
        try:
            output = self._session.run([MODEL_OUTPUT_NAME], {MODEL_INPUT_NAME: value})[0]
        except Exception as exc:
            raise ModelContractError("ONNX Runtime inference failed") from exc
        return _normalize_output(output)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

