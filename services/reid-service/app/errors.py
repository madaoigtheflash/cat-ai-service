"""Service errors mapped to the internal API error envelope."""

from __future__ import annotations


class ServiceError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable


class ModelContractError(RuntimeError):
    """Raised when a model file or inference output violates the pinned contract."""

