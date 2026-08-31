"""Small startup registry that keeps health alive while readiness fails closed."""

from __future__ import annotations

from .config import Settings
from .embedder import DeterministicStubEmbedder, Embedder, OnnxEmbedder
from .errors import ServiceError


class ModelRegistry:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.embedder: Embedder | None = None
        self.errors: list[str] = []

    def load(self) -> None:
        self.embedder = None
        self.errors.clear()
        try:
            if self.settings.engine_mode == "stub":
                self.embedder = DeterministicStubEmbedder()
            else:
                self.embedder = OnnxEmbedder(self.settings.model_path)
        except Exception as exc:
            self.errors.append(str(exc) or exc.__class__.__name__)

    @property
    def ready(self) -> bool:
        return self.embedder is not None

    def require_embedder(self) -> Embedder:
        if self.embedder is None:
            raise ServiceError(
                "WORKER_NOT_READY",
                "Re-identification engine is not ready",
                status_code=503,
                retryable=True,
            )
        return self.embedder

