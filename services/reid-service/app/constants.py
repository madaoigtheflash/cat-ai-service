"""Immutable model and wire-format contract constants."""

from __future__ import annotations

MODEL_ID = "open-noodle/pet-recognition-small"
MODEL_FILENAME = "pet-recognition-small.onnx"
MODEL_SHA256 = "6a5e2373ab348bed588cef4072f3914ca9c8bacde3e8d0651019e8dad86b24ba"
MODEL_SIZE_BYTES = 89_227_604
MODEL_INPUT_NAME = "input"
MODEL_INPUT_SHAPE = ("batch", 3, 224, 224)
MODEL_OUTPUT_NAME = "embedding"
MODEL_OUTPUT_SHAPE = ("batch", 512)
MODEL_INPUT_DTYPE = "tensor(float)"
MODEL_OUTPUT_DTYPE = "tensor(float)"
MODEL_IMAGE_SIZE = 224
EMBEDDING_DIMENSION = 512
EMBEDDING_ENCODING = "f32le-base64"

PREPROCESS_VERSION = "open-noodle-imagenet-fit224-v1"
DEFAULT_CROP_VERSION = "whole-animal-manual-v1"
MODEL_VERSION = f"pet-recognition-small@sha256:{MODEL_SHA256}"

SUPPORTED_MIME_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
MIME_TO_PIL_FORMAT = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}

DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_IMAGE_PIXELS = 25_000_000
DEFAULT_MAX_TEMPLATES = 5_000
DEFAULT_MAX_TOP_K = 50
DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024
