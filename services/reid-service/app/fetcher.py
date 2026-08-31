"""Controlled download of short-lived, allow-listed image URLs."""

from __future__ import annotations

import ipaddress
from collections.abc import AsyncIterator
from typing import Protocol
from urllib.parse import urlsplit

import httpx

from .config import Settings
from .contracts import ImageSource
from .errors import ServiceError


class ImageFetcher(Protocol):
    async def fetch(self, source: ImageSource) -> bytes: ...


def validate_source_url(url: str, allowed_hosts: tuple[str, ...]) -> None:
    """Fail closed for arbitrary URLs to reduce SSRF exposure."""

    if not allowed_hosts:
        raise ServiceError(
            "IMAGE_HOST_POLICY_NOT_CONFIGURED",
            "No image host allow-list is configured",
            status_code=503,
            retryable=False,
        )
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise ServiceError("IMAGE_URL_INVALID", "Image URL is invalid", status_code=422) from exc
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise ServiceError("IMAGE_URL_INVALID", "Image URL must use HTTPS", status_code=422)
    if parsed.username or parsed.password or parsed.fragment:
        raise ServiceError("IMAGE_URL_INVALID", "Image URL contains forbidden components", status_code=422)
    if port not in (None, 443):
        raise ServiceError("IMAGE_URL_INVALID", "Image URL port is not allowed", status_code=422)

    hostname = parsed.hostname.lower().rstrip(".")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise ServiceError("IMAGE_URL_INVALID", "IP-literal image URLs are not allowed", status_code=422)

    def matches(rule: str) -> bool:
        if rule.startswith("*."):
            suffix = rule[2:]
            return bool(suffix) and hostname.endswith("." + suffix)
        if rule.startswith("."):
            suffix = rule[1:]
            return hostname == suffix or hostname.endswith("." + suffix)
        return hostname == rule

    if not any(matches(rule) for rule in allowed_hosts):
        raise ServiceError("IMAGE_HOST_NOT_ALLOWED", "Image host is not allowed", status_code=422)


class HttpImageFetcher:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def fetch(self, source: ImageSource) -> bytes:
        validate_source_url(source.url, self._settings.allowed_image_hosts)
        timeout = httpx.Timeout(self._settings.request_timeout_seconds)
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
                async with client.stream("GET", source.url, headers={"Accept": source.mime_type}) as response:
                    if response.status_code != 200:
                        raise ServiceError(
                            "IMAGE_FETCH_FAILED",
                            f"Image source returned HTTP {response.status_code}",
                            status_code=502,
                            retryable=response.status_code >= 500 or response.status_code == 429,
                        )
                    content_length = response.headers.get("content-length")
                    if content_length:
                        try:
                            announced = int(content_length)
                        except ValueError:
                            announced = -1
                        if announced > self._settings.max_image_bytes:
                            raise ServiceError("IMAGE_TOO_LARGE", "Image exceeds the byte limit", status_code=422)

                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in _iter_bytes(response):
                        size += len(chunk)
                        if size > self._settings.max_image_bytes:
                            raise ServiceError("IMAGE_TOO_LARGE", "Image exceeds the byte limit", status_code=422)
                        chunks.append(chunk)
                    return b"".join(chunks)
        except ServiceError:
            raise
        except httpx.HTTPError as exc:
            raise ServiceError(
                "IMAGE_FETCH_FAILED",
                "Image download failed",
                status_code=502,
                retryable=True,
            ) from exc


async def _iter_bytes(response: httpx.Response) -> AsyncIterator[bytes]:
    async for chunk in response.aiter_bytes():
        if chunk:
            yield chunk
