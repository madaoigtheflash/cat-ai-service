"""本地管理台配置。"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from pathlib import Path


DEFAULT_ENV_ID = "cloud1-d6gpjpxunc74669d7"


def _int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return min(max(value, minimum), maximum)


def is_loopback_host(host: str) -> bool:
    value = host.strip().lower()
    if value == "localhost":
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class AdminSettings:
    env_id: str = DEFAULT_ENV_ID
    host: str = "127.0.0.1"
    port: int = 8510
    cache_ttl_seconds: int = 30
    page_size: int = 200
    max_documents_per_collection: int = 5000
    query_timeout_seconds: int = 60
    node_bin: str = "node"
    tcb_bin: str = ""
    snapshot_file: str = ""
    amap_key: str = ""
    amap_security_code: str = ""

    @classmethod
    def from_env(cls) -> "AdminSettings":
        return cls(
            env_id=os.getenv("CAT_ADMIN_CLOUDBASE_ENV_ID", DEFAULT_ENV_ID).strip() or DEFAULT_ENV_ID,
            host=os.getenv("CAT_ADMIN_HOST", "127.0.0.1").strip() or "127.0.0.1",
            port=_int_env("CAT_ADMIN_PORT", 8510, 1024, 65535),
            cache_ttl_seconds=_int_env("CAT_ADMIN_CACHE_TTL_SECONDS", 30, 0, 3600),
            page_size=_int_env("CAT_ADMIN_PAGE_SIZE", 200, 10, 500),
            max_documents_per_collection=_int_env(
                "CAT_ADMIN_MAX_DOCUMENTS", 5000, 100, 50000
            ),
            query_timeout_seconds=_int_env("CAT_ADMIN_QUERY_TIMEOUT_SECONDS", 60, 10, 300),
            node_bin=os.getenv("CAT_ADMIN_NODE_BIN", "node").strip() or "node",
            tcb_bin=os.getenv("CAT_ADMIN_TCB_BIN", "").strip(),
            snapshot_file=os.getenv("CAT_ADMIN_SNAPSHOT_FILE", "").strip(),
            amap_key=os.getenv("CAT_ADMIN_AMAP_KEY", "").strip(),
            amap_security_code=os.getenv("CAT_ADMIN_AMAP_SECURITY_CODE", "").strip(),
        )

    def validate(self) -> None:
        if not self.env_id or len(self.env_id) > 160:
            raise RuntimeError("CAT_ADMIN_CLOUDBASE_ENV_ID 配置无效")
        if not is_loopback_host(self.host):
            raise RuntimeError(
                "本地管理台只允许监听 loopback 地址；请使用 127.0.0.1 或 localhost"
            )
        if self.snapshot_file and not Path(self.snapshot_file).expanduser().is_file():
            raise RuntimeError("CAT_ADMIN_SNAPSHOT_FILE 指向的文件不存在")
        if bool(self.amap_key) != bool(self.amap_security_code):
            raise RuntimeError("高德地图必须同时配置 CAT_ADMIN_AMAP_KEY 与 CAT_ADMIN_AMAP_SECURITY_CODE")
        if len(self.amap_key) > 128 or len(self.amap_security_code) > 256:
            raise RuntimeError("高德地图配置长度无效")
