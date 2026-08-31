from __future__ import annotations

import argparse
import json

import pytest

import run_cloud_admin


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


def _args(*, no_browser=True):
    return argparse.Namespace(
        host="127.0.0.1",
        port=8510,
        env="cloud-test",
        snapshot="",
        no_browser=no_browser,
    )


def test_existing_admin_only_accepts_the_cat_ai_health_contract(monkeypatch):
    monkeypatch.setattr(
        run_cloud_admin.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: _Response({"service": "cat-ai-cloud-admin", "envId": "cloud-test"}),
    )
    assert run_cloud_admin._existing_admin("http://127.0.0.1:8510/")["envId"] == "cloud-test"

    monkeypatch.setattr(
        run_cloud_admin.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: _Response({"service": "other-service"}),
    )
    assert run_cloud_admin._existing_admin("http://127.0.0.1:8510/") is None


def test_duplicate_launch_reuses_existing_dashboard_without_binding_again(monkeypatch):
    monkeypatch.setattr(run_cloud_admin, "parse_args", lambda: _args())
    monkeypatch.setattr(
        run_cloud_admin,
        "_existing_admin",
        lambda _url: {"service": "cat-ai-cloud-admin", "envId": "cloud-test"},
    )
    monkeypatch.setattr(
        run_cloud_admin,
        "_port_is_open",
        lambda *_args: pytest.fail("existing dashboard must return before a second bind"),
    )
    run_cloud_admin.main()


def test_unrelated_port_occupant_gets_a_specific_error(monkeypatch):
    monkeypatch.setattr(run_cloud_admin, "parse_args", lambda: _args())
    monkeypatch.setattr(run_cloud_admin, "_existing_admin", lambda _url: None)
    monkeypatch.setattr(run_cloud_admin, "_port_is_open", lambda *_args: True)

    with pytest.raises(SystemExit, match="端口 8510 已被其他程序占用"):
        run_cloud_admin.main()
