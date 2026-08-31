from __future__ import annotations

import pytest

from app.errors import ServiceError
from app.fetcher import validate_source_url


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://files.example.com/cat.jpg?token=x", ("files.example.com",)),
        ("https://a.files.example.com/cat.jpg", ("*.files.example.com",)),
        ("https://files.example.com/cat.jpg", (".example.com",)),
    ],
)
def test_source_url_allowlist_accepts_expected_hosts(url: str, allowed: tuple[str, ...]) -> None:
    validate_source_url(url, allowed)


@pytest.mark.parametrize(
    ("url", "allowed", "code"),
    [
        ("http://files.example.com/cat.jpg", ("files.example.com",), "IMAGE_URL_INVALID"),
        ("https://127.0.0.1/cat.jpg", ("127.0.0.1",), "IMAGE_URL_INVALID"),
        ("https://files.example.com:444/cat.jpg", ("files.example.com",), "IMAGE_URL_INVALID"),
        ("https://evil.example/cat.jpg", ("files.example.com",), "IMAGE_HOST_NOT_ALLOWED"),
        ("https://files.example.com/cat.jpg", (), "IMAGE_HOST_POLICY_NOT_CONFIGURED"),
    ],
)
def test_source_url_allowlist_fails_closed(url: str, allowed: tuple[str, ...], code: str) -> None:
    with pytest.raises(ServiceError) as captured:
        validate_source_url(url, allowed)
    assert captured.value.code == code

