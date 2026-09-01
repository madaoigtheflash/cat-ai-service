"""启动 Cat-AI 本地 CloudBase 管理台。"""

from __future__ import annotations

import argparse
import json
import os
import socket
import threading
import urllib.error
import urllib.request
import webbrowser


def _port_value(value: str) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("端口必须是 1024–65535 之间的整数") from exc
    if not 1024 <= port <= 65535:
        raise argparse.ArgumentTypeError("端口必须是 1024–65535 之间的整数")
    return port


def _browser_url(host: str, port: int) -> str:
    value = host.strip()
    url_host = f"[{value}]" if ":" in value else value
    return f"http://{url_host}:{port}/"


def _existing_admin(url: str) -> dict | None:
    try:
        with urllib.request.urlopen(f"{url}api/health", timeout=1.2) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None
    if isinstance(payload, dict) and payload.get("service") == "cat-ai-cloud-admin":
        return payload
    return None


def _port_is_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.8):
            return True
    except OSError:
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="启动 Cat-AI 云端管理台（小屋受审计写入、反馈工作流受控写入）")
    parser.add_argument("--host", default=os.getenv("CAT_ADMIN_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=_port_value,
        default=os.getenv("CAT_ADMIN_PORT", "8510"),
        help="本地监听端口（1024–65535）",
    )
    parser.add_argument("--env", default=os.getenv("CAT_ADMIN_CLOUDBASE_ENV_ID", "cloud1-d6gpjpxunc74669d7"))
    parser.add_argument("--snapshot", default=os.getenv("CAT_ADMIN_SNAPSHOT_FILE", ""))
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    host = args.host.strip()
    os.environ["CAT_ADMIN_HOST"] = host
    os.environ["CAT_ADMIN_PORT"] = str(args.port)
    os.environ["CAT_ADMIN_CLOUDBASE_ENV_ID"] = args.env
    if args.snapshot:
        os.environ["CAT_ADMIN_SNAPSHOT_FILE"] = args.snapshot

    from cloud_admin.config import is_loopback_host

    if not is_loopback_host(host):
        raise SystemExit("安全限制：管理台只能监听 127.0.0.1、::1 或 localhost")

    url = _browser_url(host, args.port)
    existing = _existing_admin(url)
    if existing:
        print(f"Cat-AI 管理台已在运行：{url}")
        print(f"云环境：{existing.get('envId') or '未知'}")
        if not args.no_browser:
            webbrowser.open(url)
        return
    if _port_is_open(host, args.port):
        raise SystemExit(
            f"端口 {args.port} 已被其他程序占用。请关闭占用程序，"
            f"或使用 --port {args.port + 1} 启动。"
        )
    print("=" * 62)
    print(" Cat-AI CloudBase 本地管理台")
    print("=" * 62)
    print(f" 云环境: {args.env}")
    print(f" 地址:   {url}")
    print(" 权限:   小屋经 catAdmin 原子写入并审计；其余主体数据保持只读")
    print(" 安全:   小程序只反馈；Codex 修改必须由本机操作者确认")
    print(" 停止:   Ctrl+C\n")

    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    try:
        import fastapi  # noqa: F401 - fail early with an actionable dependency message
        import uvicorn
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "缺少管理台 Python 依赖。请执行：\n"
            "python -m pip install -r cloud_admin/requirements.txt"
        ) from exc

    uvicorn.run(
        "cloud_admin.main:app",
        host=host,
        port=args.port,
        reload=False,
        access_log=True,
    )


if __name__ == "__main__":
    main()
