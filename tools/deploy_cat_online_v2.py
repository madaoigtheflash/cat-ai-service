"""Deploy catOnlineV2 without exposing or replacing its existing owner secret.

The command is read-only unless both ``--apply`` and an explicit ``--env-id``
are supplied. Deployment uses a temporary source-only directory so Windows
``node_modules`` are never uploaded; CloudBase installs dependencies remotely.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence

try:
    from tools.cloudbase_relationship_v2 import CloudBaseRunner, MigrationError
except ModuleNotFoundError:  # Direct execution puts tools/ first on sys.path.
    from cloudbase_relationship_v2 import CloudBaseRunner, MigrationError


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = PROJECT_ROOT / "miniapp" / "cloudfunctions" / "catOnline"
SOURCE_FILES = ("core.js", "index.js", "sanitize.js", "package.json", "package-lock.json")
FUNCTION_NAME = "catOnlineV2"
OWNER_SECRET_KEY = "CAT_ONLINE_OWNER_SECRET"


class DeployError(RuntimeError):
    """A deployment failure that never contains secret values."""


def _json_objects(output: str):
    decoder = json.JSONDecoder()
    for index, char in enumerate(output):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(output[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            yield value


def _detail_payload(output: str) -> dict[str, Any]:
    for value in _json_objects(output):
        data = value.get("data")
        if isinstance(data, dict) and data.get("FunctionName") == FUNCTION_NAME:
            return data
    raise DeployError("CloudBase CLI 未返回可解析的函数配置")


def _safe_error_hint(output: str) -> str:
    matches = re.findall(
        r"(?:error|code|message)[^\r\n]{0,180}",
        output,
        flags=re.IGNORECASE,
    )
    if not matches:
        return "未返回稳定错误码"
    hint = re.sub(r"[^A-Za-z0-9_.:\- /()\u4e00-\u9fff]", "", matches[-1])
    return hint[:240] or "未返回稳定错误码"


class CatOnlineDeployer:
    def __init__(self, env_id: str, timeout_seconds: int = 900):
        self.env_id = str(env_id or "").strip()
        if not self.env_id:
            raise DeployError("缺少 CloudBase 环境 ID")
        self.timeout_seconds = min(max(int(timeout_seconds), 60), 1800)
        try:
            self.node_bin = CloudBaseRunner._resolve_node(
                os.getenv("CAT_ADMIN_NODE_BIN", "node")
            )
            self.tcb_bin = CloudBaseRunner._resolve_tcb(
                os.getenv("CAT_ADMIN_TCB_BIN", "")
            )
        except MigrationError as exc:
            raise DeployError(str(exc)) from exc

    def _run(self, arguments: Sequence[str], *, environment=None, timeout=None):
        try:
            return subprocess.run(
                [self.node_bin, self.tcb_bin, *arguments],
                cwd=PROJECT_ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout or self.timeout_seconds,
                check=False,
                env=environment or os.environ.copy(),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired as exc:
            raise DeployError("CloudBase 发布超时；请先检查函数状态再重试") from exc
        except OSError as exc:
            raise DeployError("CloudBase CLI 无法启动") from exc

    def detail(self) -> tuple[dict[str, Any], dict[str, str]]:
        result = self._run(
            ("fn", "detail", FUNCTION_NAME, "-e", self.env_id, "--json"),
            timeout=120,
        )
        combined = "\n".join(part for part in (result.stdout, result.stderr) if part)
        if result.returncode:
            raise DeployError(f"读取现网函数配置失败（exit {result.returncode}）")
        detail = _detail_payload(combined)
        environment = detail.get("Environment")
        items = environment.get("Variables") if isinstance(environment, dict) else []
        variables = {
            str(item.get("Key")): str(item.get("Value"))
            for item in items or []
            if isinstance(item, dict) and item.get("Key")
        }
        return detail, variables

    def preflight(self) -> dict[str, Any]:
        missing = [name for name in SOURCE_FILES if not (SOURCE_DIR / name).is_file()]
        if missing:
            raise DeployError("发布源文件不完整：" + ", ".join(missing))
        detail, variables = self.detail()
        secret = variables.get(OWNER_SECRET_KEY, "")
        if len(secret.encode("utf-8")) < 32:
            raise DeployError("现网 owner secret 缺失或长度不足；已停止")
        return {
            "detail": detail,
            "variables": variables,
            "secret": secret,
        }

    def deploy(self, preflight: dict[str, Any]) -> None:
        secret = str(preflight["secret"])
        child_env = os.environ.copy()
        child_env[OWNER_SECRET_KEY] = secret
        with tempfile.TemporaryDirectory(prefix="cat-ai-catOnlineV2-") as temp_dir:
            stage = Path(temp_dir)
            for name in SOURCE_FILES:
                shutil.copy2(SOURCE_DIR / name, stage / name)
            result = self._run(
                (
                    "fn",
                    "deploy",
                    FUNCTION_NAME,
                    "--force",
                    "--install-dependency",
                    "true",
                    "--dir",
                    str(stage),
                    "-e",
                    self.env_id,
                    "--json",
                ),
                environment=child_env,
            )
        combined = "\n".join(part for part in (result.stdout, result.stderr) if part)
        if result.returncode:
            redacted = combined.replace(secret, "<redacted>")
            raise DeployError(
                f"CloudBase 发布失败（exit {result.returncode}）：{_safe_error_hint(redacted)}"
            )

        detail, variables = self.detail()
        if variables.get(OWNER_SECRET_KEY) != secret:
            raise DeployError("发布后 owner secret 校验不一致；请立即检查函数配置")
        if detail.get("Runtime") != "Nodejs20.19":
            raise DeployError("发布后运行时不是 Nodejs20.19")
        if detail.get("Status") != "Active" or detail.get("AvailableStatus") != "Available":
            raise DeployError("发布命令已返回，但函数尚未处于 Active/Available")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="安全发布 Cat-AI catOnlineV2 云函数")
    parser.add_argument("--env-id", default="", help="CloudBase 环境 ID")
    parser.add_argument("--apply", action="store_true", help="执行发布；默认只预检")
    parser.add_argument("--timeout", type=int, default=900, help="发布超时秒数（60–1800）")
    args = parser.parse_args(argv)
    if not 60 <= args.timeout <= 1800:
        parser.error("--timeout 必须在 60–1800 之间")
    if args.apply and not str(args.env_id or "").strip():
        parser.error("发布必须同时显式提供 --apply 和 --env-id")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if not str(args.env_id or "").strip():
        print("错误：请显式提供 --env-id", file=sys.stderr)
        return 2
    try:
        deployer = CatOnlineDeployer(args.env_id, timeout_seconds=args.timeout)
        deployer.preflight()
        print(f"预检通过：{FUNCTION_NAME} 现网密钥可安全继承，发布包不含 node_modules。")
        if not args.apply:
            print("结果：只读预检完成，未部署。")
            return 0
        deployer.deploy(deployer.preflight())
        print("结果：catOnlineV2 已发布，现网密钥、Nodejs20.19 与 Active/Available 均已回读确认。")
        return 0
    except DeployError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
