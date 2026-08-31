"""Environment-backed worker settings without an extra settings dependency."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .constants import (
    DEFAULT_MAX_IMAGE_BYTES,
    DEFAULT_MAX_IMAGE_PIXELS,
    DEFAULT_MAX_REQUEST_BYTES,
    DEFAULT_MAX_TEMPLATES,
    DEFAULT_MAX_TOP_K,
    MODEL_FILENAME,
)


def _repo_model_path() -> Path:
    return Path(__file__).resolve().parents[3] / "tools" / "pet_reid" / "models" / MODEL_FILENAME


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime settings.

    ``stub`` is deliberately opt-in. The normal process starts in ``onnx`` mode
    and fails readiness if the pinned model is missing or has a wrong contract.
    """

    engine_mode: str = "onnx"
    model_path: Path = _repo_model_path()
    allowed_image_hosts: tuple[str, ...] = ()
    max_image_bytes: int = DEFAULT_MAX_IMAGE_BYTES
    max_image_pixels: int = DEFAULT_MAX_IMAGE_PIXELS
    max_templates: int = DEFAULT_MAX_TEMPLATES
    max_top_k: int = DEFAULT_MAX_TOP_K
    max_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES
    request_timeout_seconds: float = 15.0
    worker_hmac_secret: str = field(default="", repr=False)
    hmac_max_skew_seconds: int = 300

    def __post_init__(self) -> None:
        mode = self.engine_mode.strip().lower()
        if mode not in {"onnx", "stub"}:
            raise ValueError("engine_mode must be 'onnx' or 'stub'")
        object.__setattr__(self, "engine_mode", mode)
        object.__setattr__(self, "model_path", Path(self.model_path).resolve())

        hosts: list[str] = []
        for host in self.allowed_image_hosts:
            normalized = host.strip().lower().rstrip(".")
            if normalized and normalized not in hosts:
                hosts.append(normalized)
        object.__setattr__(self, "allowed_image_hosts", tuple(hosts))

        for name in ("max_image_bytes", "max_image_pixels", "max_templates", "max_top_k", "max_request_bytes"):
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")
        if self.request_timeout_seconds <= 0:
            raise ValueError("request_timeout_seconds must be positive")
        if self.hmac_max_skew_seconds <= 0:
            raise ValueError("hmac_max_skew_seconds must be positive")

    @classmethod
    def from_env(cls) -> "Settings":
        hosts = tuple(part for part in os.getenv("REID_ALLOWED_IMAGE_HOSTS", "").split(",") if part.strip())
        return cls(
            engine_mode=os.getenv("REID_ENGINE", "onnx"),
            model_path=Path(os.getenv("REID_MODEL_PATH", str(_repo_model_path()))),
            allowed_image_hosts=hosts,
            max_image_bytes=_positive_int("REID_MAX_IMAGE_BYTES", DEFAULT_MAX_IMAGE_BYTES),
            max_image_pixels=_positive_int("REID_MAX_IMAGE_PIXELS", DEFAULT_MAX_IMAGE_PIXELS),
            max_templates=_positive_int("REID_MAX_TEMPLATES", DEFAULT_MAX_TEMPLATES),
            max_top_k=_positive_int("REID_MAX_TOP_K", DEFAULT_MAX_TOP_K),
            max_request_bytes=_positive_int("REID_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES),
            request_timeout_seconds=float(os.getenv("REID_REQUEST_TIMEOUT_SECONDS", "15")),
            worker_hmac_secret=os.getenv("REID_WORKER_HMAC_SECRET", ""),
            hmac_max_skew_seconds=_positive_int("REID_HMAC_MAX_SKEW_SECONDS", 300),
        )
