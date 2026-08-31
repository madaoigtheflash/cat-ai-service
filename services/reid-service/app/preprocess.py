"""Image validation and the pinned open-noodle preprocessing contract."""

from __future__ import annotations

import hashlib
import io
import warnings
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import Settings
from .constants import MIME_TO_PIL_FORMAT, MODEL_IMAGE_SIZE
from .contracts import ImageSource
from .errors import ServiceError

IMAGENET_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)


@dataclass(frozen=True, slots=True)
class PreprocessedImage:
    tensor: np.ndarray
    width: int
    height: int
    mime_type: str
    size_bytes: int


def validate_and_preprocess(data: bytes, source: ImageSource, settings: Settings) -> PreprocessedImage:
    if not data:
        raise ServiceError("IMAGE_EMPTY", "Image is empty", status_code=422)
    if len(data) > settings.max_image_bytes or source.size_bytes > settings.max_image_bytes:
        raise ServiceError("IMAGE_TOO_LARGE", "Image exceeds the byte limit", status_code=422)
    if len(data) != source.size_bytes:
        raise ServiceError("IMAGE_SIZE_MISMATCH", "Downloaded image size does not match metadata", status_code=422)
    if hashlib.sha256(data).hexdigest() != source.sha256:
        raise ServiceError("IMAGE_HASH_MISMATCH", "Downloaded image hash does not match metadata", status_code=422)

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as probe:
                source_format = (probe.format or "").upper()
                if getattr(probe, "n_frames", 1) != 1:
                    raise ServiceError("IMAGE_ANIMATED", "Animated images are not supported", status_code=422)
                width, height = probe.size
                if width <= 0 or height <= 0 or width * height > settings.max_image_pixels:
                    raise ServiceError("IMAGE_DIMENSIONS_INVALID", "Image dimensions are not allowed", status_code=422)
                probe.verify()

            expected_format = MIME_TO_PIL_FORMAT[source.mime_type]
            if source_format != expected_format:
                raise ServiceError("IMAGE_MIME_MISMATCH", "Image bytes do not match mimeType", status_code=422)

            with Image.open(io.BytesIO(data)) as opened:
                opened.load()
                image = ImageOps.exif_transpose(opened).convert("RGB")
    except ServiceError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ServiceError("IMAGE_DIMENSIONS_INVALID", "Image dimensions are not allowed", status_code=422)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ServiceError("IMAGE_DECODE_FAILED", "Image cannot be decoded safely", status_code=422) from exc

    width, height = image.size
    fitted = ImageOps.fit(
        image,
        (MODEL_IMAGE_SIZE, MODEL_IMAGE_SIZE),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )
    array = np.asarray(fitted, dtype=np.float32) / np.float32(255.0)
    array = (array - IMAGENET_MEAN) / IMAGENET_STD
    tensor = np.ascontiguousarray(np.transpose(array, (2, 0, 1))[None, ...], dtype=np.float32)
    return PreprocessedImage(
        tensor=tensor,
        width=width,
        height=height,
        mime_type=source.mime_type,
        size_bytes=len(data),
    )

