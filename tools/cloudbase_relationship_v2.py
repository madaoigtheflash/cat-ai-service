"""Safely migrate Cat-AI CloudBase relationship data and indexes to v2.

The command is dry-run by default. Cloud writes are possible only when both
``--apply`` and an explicit ``--env-id`` are supplied.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
EDGES_COLLECTION = "ci_relationship_edges"
VOTES_COLLECTION = "ci_relationship_votes"
OLD_UNIQUE_INDEX = "uniq_relationship_pair"
RELATIONSHIP_CONTRACT_ID = "cat-ai.relationship.directed"
RELATIONSHIP_CONTRACT_VERSION = 2
RELATIONSHIP_DIRECTION_VERSION = 2

EDGE_FIELDS = (
    "_id",
    "communityId",
    "relationshipContractId",
    "relationshipContractVersion",
    "directionVersion",
    "directionState",
    "directionKey",
    "fromCatId",
    "toCatId",
    "catAId",
    "catBId",
)
VOTE_FIELDS = (
    "_id",
    "edgeId",
    "communityId",
    "relationshipContractId",
    "relationshipContractVersion",
    "directionVersion",
    "directionState",
    "directionKey",
    "fromCatId",
    "toCatId",
)


class MigrationError(RuntimeError):
    """A safe-to-display migration failure without raw CloudBase payloads."""


@dataclass(frozen=True)
class DocumentPatch:
    collection: str
    document_id: str
    set_fields: Mapping[str, Any]


@dataclass(frozen=True)
class PlanIssue:
    code: str
    collection: str
    document_id: str
    message: str


@dataclass(frozen=True)
class EdgeContract:
    edge_id: str
    community_id: str
    kind: str
    fields: Mapping[str, Any]


@dataclass(frozen=True)
class MigrationPlan:
    edge_count: int
    vote_count: int
    directed_edge_count: int
    legacy_edge_count: int
    edge_patches: tuple[DocumentPatch, ...]
    vote_patches: tuple[DocumentPatch, ...]
    issues: tuple[PlanIssue, ...]

    @property
    def patch_count(self) -> int:
        return len(self.edge_patches) + len(self.vote_patches)

    @property
    def ready(self) -> bool:
        return not self.issues


@dataclass(frozen=True)
class IndexSpec:
    name: str
    keys: tuple[tuple[str, int], ...]
    unique: bool = False

    def mongo_document(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "name": self.name,
            "key": {field: order for field, order in self.keys},
            "background": True,
        }
        if self.unique:
            value["unique"] = True
        return value


NEW_EDGE_INDEXES = (
    IndexSpec(
        "uniq_relationship_direction_key",
        (("communityId", 1), ("directionKey", 1)),
        unique=True,
    ),
    IndexSpec(
        "idx_relationship_active_from",
        (("communityId", 1), ("state", 1), ("fromCatId", 1)),
    ),
    IndexSpec(
        "idx_relationship_active_to",
        (("communityId", 1), ("state", 1), ("toCatId", 1)),
    ),
)


def _text(value: Any, limit: int = 192) -> str:
    if value is None:
        return ""
    return "".join(char for char in str(value) if ord(char) >= 32).strip()[:limit]


def _integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def relationship_direction_key(from_cat_id: str, to_cat_id: str) -> str:
    source = _text(from_cat_id, 80)
    target = _text(to_cat_id, 80)
    if not source or not target:
        raise ValueError("v2 relationship endpoints are required")
    if source == target:
        raise ValueError("v2 relationship endpoints must be different")
    return f"{source}::{target}"


def _changed_fields(document: Mapping[str, Any], desired: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in desired.items() if document.get(key) != value}


def _edge_contract(document: Mapping[str, Any]) -> tuple[EdgeContract | None, PlanIssue | None]:
    edge_id = _text(document.get("_id") or document.get("id"), 160)
    community_id = _text(document.get("communityId"), 120)
    reference = edge_id or "<missing-id>"
    if not edge_id:
        return None, PlanIssue(
            "missing_edge_id", EDGES_COLLECTION, reference, "关系边缺少文档 ID"
        )
    if not community_id:
        return None, PlanIssue(
            "missing_community", EDGES_COLLECTION, reference, "关系边缺少 communityId"
        )

    if _integer(document.get("directionVersion"), 1) == RELATIONSHIP_DIRECTION_VERSION:
        from_cat_id = _text(document.get("fromCatId"), 80)
        to_cat_id = _text(document.get("toCatId"), 80)
        try:
            direction_key = relationship_direction_key(from_cat_id, to_cat_id)
        except ValueError:
            return None, PlanIssue(
                "invalid_v2_endpoints",
                EDGES_COLLECTION,
                reference,
                "v2 关系边缺少有效的不同端点",
            )
        fields = {
            "relationshipContractId": RELATIONSHIP_CONTRACT_ID,
            "relationshipContractVersion": RELATIONSHIP_CONTRACT_VERSION,
            "directionVersion": RELATIONSHIP_DIRECTION_VERSION,
            "directionState": "directed",
            "directionKey": direction_key,
            "fromCatId": from_cat_id,
            "toCatId": to_cat_id,
            "catAId": from_cat_id,
            "catBId": to_cat_id,
        }
        return EdgeContract(edge_id, community_id, "directed", fields), None

    fields = {
        "relationshipContractId": RELATIONSHIP_CONTRACT_ID,
        "relationshipContractVersion": 1,
        "directionVersion": 1,
        "directionState": "legacy_pending",
        "directionKey": f"legacy::{edge_id}",
    }
    return EdgeContract(edge_id, community_id, "legacy", fields), None


def build_migration_plan(
    edges: Sequence[Mapping[str, Any]],
    votes: Sequence[Mapping[str, Any]],
) -> MigrationPlan:
    """Build a deterministic, side-effect-free migration plan."""

    issues: list[PlanIssue] = []
    edge_patches: list[DocumentPatch] = []
    vote_patches: list[DocumentPatch] = []
    contracts: dict[str, EdgeContract] = {}
    direction_owners: dict[tuple[str, str], str] = {}
    directed_count = 0
    legacy_count = 0

    for edge in edges:
        contract, issue = _edge_contract(edge)
        if issue:
            issues.append(issue)
            continue
        assert contract is not None
        if contract.edge_id in contracts:
            issues.append(PlanIssue(
                "duplicate_edge_id",
                EDGES_COLLECTION,
                contract.edge_id,
                "读取结果中出现重复的关系边 ID",
            ))
            continue
        contracts[contract.edge_id] = contract
        unique_key = (contract.community_id, str(contract.fields["directionKey"]))
        previous = direction_owners.get(unique_key)
        if previous and previous != contract.edge_id:
            issues.append(PlanIssue(
                "duplicate_direction_key",
                EDGES_COLLECTION,
                contract.edge_id,
                f"与关系边 {previous} 产生相同的 communityId+directionKey",
            ))
        else:
            direction_owners[unique_key] = contract.edge_id
        if contract.kind == "directed":
            directed_count += 1
        else:
            legacy_count += 1
        changed = _changed_fields(edge, contract.fields)
        if changed:
            edge_patches.append(DocumentPatch(EDGES_COLLECTION, contract.edge_id, changed))

    seen_vote_ids: set[str] = set()
    for vote in votes:
        vote_id = _text(vote.get("_id") or vote.get("id"), 160)
        edge_id = _text(vote.get("edgeId"), 160)
        reference = vote_id or "<missing-id>"
        if not vote_id:
            issues.append(PlanIssue(
                "missing_vote_id", VOTES_COLLECTION, reference, "关系投票缺少文档 ID"
            ))
            continue
        if vote_id in seen_vote_ids:
            issues.append(PlanIssue(
                "duplicate_vote_id", VOTES_COLLECTION, reference, "读取结果中出现重复的投票 ID"
            ))
            continue
        seen_vote_ids.add(vote_id)
        contract = contracts.get(edge_id)
        if not contract:
            issues.append(PlanIssue(
                "orphan_vote", VOTES_COLLECTION, reference, "投票引用的关系边不存在或无法迁移"
            ))
            continue
        vote_community = _text(vote.get("communityId"), 120)
        if vote_community and vote_community != contract.community_id:
            issues.append(PlanIssue(
                "vote_community_mismatch",
                VOTES_COLLECTION,
                reference,
                "投票与关系边的 communityId 不一致",
            ))
            continue
        desired: dict[str, Any] = {
            "communityId": contract.community_id,
            "relationshipContractId": contract.fields["relationshipContractId"],
            "relationshipContractVersion": contract.fields["relationshipContractVersion"],
            "directionVersion": contract.fields["directionVersion"],
            "directionState": contract.fields["directionState"],
            "directionKey": contract.fields["directionKey"],
        }
        if contract.kind == "directed":
            desired["fromCatId"] = contract.fields["fromCatId"]
            desired["toCatId"] = contract.fields["toCatId"]
        changed = _changed_fields(vote, desired)
        if changed:
            vote_patches.append(DocumentPatch(VOTES_COLLECTION, vote_id, changed))

    return MigrationPlan(
        edge_count=len(edges),
        vote_count=len(votes),
        directed_edge_count=directed_count,
        legacy_edge_count=legacy_count,
        edge_patches=tuple(edge_patches),
        vote_patches=tuple(vote_patches),
        issues=tuple(issues),
    )


def make_update_command(collection: str, patches: Sequence[DocumentPatch]) -> dict[str, Any]:
    """Build a CloudBase UPDATE command from already-sanitized patch fields."""

    if not patches:
        raise ValueError("at least one patch is required")
    if any(item.collection != collection for item in patches):
        raise ValueError("all patches must target the same collection")
    command = {
        "update": collection,
        "updates": [
            {
                "q": {"_id": item.document_id},
                "u": {"$set": dict(item.set_fields)},
                "multi": False,
                "upsert": False,
            }
            for item in patches
        ],
    }
    return _mgo_command(collection, "UPDATE", command)


def make_create_indexes_command(specs: Sequence[IndexSpec]) -> dict[str, Any]:
    if not specs:
        raise ValueError("at least one index is required")
    return _mgo_command(
        EDGES_COLLECTION,
        "COMMAND",
        {
            "createIndexes": EDGES_COLLECTION,
            "indexes": [spec.mongo_document() for spec in specs],
        },
    )


def make_list_indexes_command() -> dict[str, Any]:
    return _mgo_command(
        EDGES_COLLECTION,
        "COMMAND",
        {"listIndexes": EDGES_COLLECTION, "cursor": {}},
    )


def make_drop_old_index_command() -> dict[str, Any]:
    return _mgo_command(
        EDGES_COLLECTION,
        "COMMAND",
        {"dropIndexes": EDGES_COLLECTION, "index": OLD_UNIQUE_INDEX},
    )


def _mgo_command(table: str, command_type: str, command: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "TableName": table,
        "CommandType": command_type,
        "Command": json.dumps(command, ensure_ascii=False, separators=(",", ":")),
    }


def _plain_ejson(value: Any) -> Any:
    if isinstance(value, list):
        return [_plain_ejson(item) for item in value]
    if not isinstance(value, dict):
        return value
    if set(value) == {"$date"}:
        raw = value["$date"]
        if isinstance(raw, dict) and "$numberLong" in raw:
            return raw["$numberLong"]
        return raw
    for number_key in ("$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"):
        if set(value) == {number_key}:
            raw = value[number_key]
            try:
                return float(raw) if number_key in {"$numberDouble", "$numberDecimal"} else int(raw)
            except (TypeError, ValueError):
                return raw
    return {str(key): _plain_ejson(item) for key, item in value.items()}


def _decode_cli_envelope(output: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    errors: list[dict[str, Any]] = []
    successes: list[dict[str, Any]] = []
    for index, char in enumerate(output):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(output[index:])
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict):
            continue
        data = value.get("data")
        if isinstance(data, dict) and isinstance(data.get("results"), list):
            successes.append(value)
        elif "error" in value:
            errors.append(value)
    if successes:
        return successes[-1]
    if errors:
        return errors[-1]
    raise MigrationError("CloudBase CLI 未返回可解析的 JSON 结果")


def _safe_error_code(value: Any) -> str:
    text = re.sub(r"[^A-Za-z0-9_.:-]", "", str(value or "CLOUDBASE_ERROR"))
    return text[:80] or "CLOUDBASE_ERROR"


class CloudBaseRunner:
    def __init__(self, env_id: str, *, timeout_seconds: int = 60, page_size: int = 200):
        self.env_id = _text(env_id, 160)
        if not self.env_id:
            raise MigrationError("缺少 CloudBase 环境 ID")
        self.timeout_seconds = min(max(int(timeout_seconds), 10), 300)
        self.page_size = min(max(int(page_size), 10), 500)
        self.node_bin = self._resolve_node(os.getenv("CAT_ADMIN_NODE_BIN", "node"))
        self.tcb_bin = self._resolve_tcb(os.getenv("CAT_ADMIN_TCB_BIN", ""))

    @staticmethod
    def _resolve_node(value: str) -> str:
        resolved = shutil.which(value)
        if resolved:
            return resolved
        path = Path(value).expanduser()
        if path.is_file():
            return str(path.resolve())
        raise MigrationError("未找到 Node.js；请设置 CAT_ADMIN_NODE_BIN")

    @staticmethod
    def _resolve_tcb(value: str) -> str:
        if value:
            path = Path(value).expanduser()
            if path.is_file():
                return str(path.resolve())
            raise MigrationError("CAT_ADMIN_TCB_BIN 指向的文件不存在")
        home = Path.home()
        candidates: list[Path] = []
        npm_cache = home / "AppData" / "Local" / "npm-cache" / "_npx"
        if npm_cache.is_dir():
            candidates.extend(npm_cache.glob("*/node_modules/@cloudbase/cli/bin/tcb"))
        candidates.extend((home / ".npm" / "_npx").glob("*/node_modules/@cloudbase/cli/bin/tcb"))
        files = [path for path in candidates if path.is_file()]
        if files:
            return str(max(files, key=lambda path: path.stat().st_mtime).resolve())
        command = shutil.which("tcb")
        if command and Path(command).is_file() and Path(command).suffix.lower() not in {".cmd", ".bat"}:
            return str(Path(command).resolve())
        raise MigrationError(
            "未找到 CloudBase CLI；请运行 npx @cloudbase/cli login，或设置 CAT_ADMIN_TCB_BIN"
        )

    def execute(self, commands: Sequence[Mapping[str, Any]]) -> list[Any]:
        if not commands:
            return []
        args = [
            self.node_bin,
            self.tcb_bin,
            "db",
            "nosql",
            "execute",
            "-e",
            self.env_id,
            "--command",
            json.dumps(list(commands), ensure_ascii=False, separators=(",", ":")),
            "--json",
        ]
        try:
            completed = subprocess.run(
                args,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.timeout_seconds,
                check=False,
                env=os.environ.copy(),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired as exc:
            raise MigrationError("CloudBase 命令超时；未继续后续步骤") from exc
        except OSError as exc:
            raise MigrationError("CloudBase CLI 无法启动") from exc
        combined = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
        try:
            envelope = _decode_cli_envelope(combined)
        except MigrationError:
            if completed.returncode != 0:
                raise MigrationError(f"CloudBase CLI 命令失败（exit {completed.returncode}）")
            raise
        if envelope.get("error"):
            error = envelope["error"] if isinstance(envelope["error"], dict) else {}
            raise MigrationError(f"CloudBase 命令失败：{_safe_error_code(error.get('code'))}")
        if completed.returncode != 0:
            raise MigrationError(f"CloudBase CLI 命令失败（exit {completed.returncode}）")
        data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
        results = data.get("results") if isinstance(data, dict) else None
        if not isinstance(results, list) or len(results) != len(commands):
            raise MigrationError("CloudBase 返回的结果数量与命令数量不一致")
        return [_plain_ejson(item) for item in results]

    def query_all(self, collection: str, fields: Sequence[str]) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        last_id = ""
        projection = {field: 1 for field in fields}
        while True:
            filter_value: dict[str, Any] = {"_id": {"$gt": last_id}} if last_id else {}
            command = _mgo_command(
                collection,
                "QUERY",
                {
                    "find": collection,
                    "filter": filter_value,
                    "projection": projection,
                    "sort": {"_id": 1},
                    "limit": self.page_size,
                },
            )
            result = self.execute([command])[0]
            if not isinstance(result, list):
                raise MigrationError(f"{collection} 查询结果格式无效")
            rows = [item for item in result if isinstance(item, dict)]
            if not rows:
                break
            next_last_id = _text(rows[-1].get("_id") or rows[-1].get("id"), 160)
            if not next_last_id or (last_id and next_last_id <= last_id):
                raise MigrationError(f"{collection} 游标分页未向前推进")
            output.extend(rows)
            last_id = next_last_id
            if len(rows) < self.page_size:
                break
        return output

    def list_indexes(self) -> list[dict[str, Any]]:
        result = self.execute([make_list_indexes_command()])[0]
        if not isinstance(result, list):
            raise MigrationError("关系边索引列表格式无效")
        return [item for item in result if isinstance(item, dict)]


def _index_by_name(indexes: Iterable[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    return {
        _text(item.get("name"), 160): item
        for item in indexes
        if _text(item.get("name"), 160)
    }


def index_matches_spec(index: Mapping[str, Any], spec: IndexSpec) -> bool:
    key = index.get("key") if isinstance(index.get("key"), dict) else {}
    actual_keys = tuple((str(field), _integer(order)) for field, order in key.items())
    return actual_keys == spec.keys and bool(index.get("unique")) == spec.unique


def _validate_index_names(indexes: Sequence[Mapping[str, Any]]) -> tuple[IndexSpec, ...]:
    by_name = _index_by_name(indexes)
    missing: list[IndexSpec] = []
    for spec in NEW_EDGE_INDEXES:
        existing = by_name.get(spec.name)
        if existing is None:
            missing.append(spec)
        elif not index_matches_spec(existing, spec):
            raise MigrationError(f"索引 {spec.name} 已存在但定义不匹配；未执行写入")
    return tuple(missing)


def _chunks(values: Sequence[DocumentPatch], size: int = 40) -> Iterable[Sequence[DocumentPatch]]:
    for index in range(0, len(values), size):
        yield values[index:index + size]


def _execute_patches(runner: CloudBaseRunner, patches: Sequence[DocumentPatch]) -> None:
    for chunk in _chunks(patches):
        runner.execute([make_update_command(chunk[0].collection, chunk)])


def _load_plan(runner: CloudBaseRunner) -> MigrationPlan:
    edges = runner.query_all(EDGES_COLLECTION, EDGE_FIELDS)
    votes = runner.query_all(VOTES_COLLECTION, VOTE_FIELDS)
    return build_migration_plan(edges, votes)


def _wait_for_new_indexes(runner: CloudBaseRunner, timeout_seconds: int = 60) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout_seconds
    while True:
        indexes = runner.list_indexes()
        if not _validate_index_names(indexes):
            return indexes
        if time.monotonic() >= deadline:
            raise MigrationError("新关系索引未在限时内确认；旧唯一索引已保留")
        time.sleep(2)


def apply_migration(runner: CloudBaseRunner, plan: MigrationPlan) -> None:
    if not plan.ready:
        raise MigrationError("迁移计划存在阻断问题；未执行任何写入")

    # Validate conflicting index names before the first document write.
    existing_indexes = runner.list_indexes()
    _validate_index_names(existing_indexes)

    _execute_patches(runner, plan.edge_patches)
    _execute_patches(runner, plan.vote_patches)

    verified_plan = _load_plan(runner)
    if not verified_plan.ready or verified_plan.patch_count:
        raise MigrationError("文档回读验证未通过；旧唯一索引已保留，可安全重跑")

    indexes_after_documents = runner.list_indexes()
    missing = _validate_index_names(indexes_after_documents)
    if missing:
        runner.execute([make_create_indexes_command(missing)])

    confirmed_indexes = _wait_for_new_indexes(runner)
    confirmed_by_name = _index_by_name(confirmed_indexes)
    if OLD_UNIQUE_INDEX in confirmed_by_name:
        # Re-read once more after index construction. A concurrent legacy writer
        # must never cause the old uniqueness guard to be removed silently.
        final_document_plan = _load_plan(runner)
        if not final_document_plan.ready or final_document_plan.patch_count:
            raise MigrationError(
                "新索引创建期间出现未迁移文档；旧唯一索引已保留，请重跑"
            )
        runner.execute([make_drop_old_index_command()])
        final_by_name = _index_by_name(runner.list_indexes())
        if OLD_UNIQUE_INDEX in final_by_name:
            raise MigrationError("旧唯一索引删除未确认；请检查 CloudBase 索引状态")


def _infer_env_id() -> str:
    configured = _text(os.getenv("CAT_ADMIN_CLOUDBASE_ENV_ID"), 160)
    if configured:
        return configured
    config_path = PROJECT_ROOT / "cloudbaserc.json"
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    return _text(payload.get("envId") if isinstance(payload, dict) else "", 160)


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("必须是正整数") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("必须是正整数")
    return parsed


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cat-AI 猫际关系 v2 CloudBase 数据/索引迁移")
    parser.add_argument("--env-id", default="", help="CloudBase 环境 ID")
    parser.add_argument("--apply", action="store_true", help="执行写入；默认仅 dry-run")
    parser.add_argument("--page-size", type=_positive_int, default=200, help="只读分页大小（10–500）")
    parser.add_argument("--timeout", type=_positive_int, default=60, help="单次 CLI 命令超时秒数")
    args = parser.parse_args(argv)
    if not 10 <= args.page_size <= 500:
        parser.error("--page-size 必须在 10–500 之间")
    if not 10 <= args.timeout <= 300:
        parser.error("--timeout 必须在 10–300 之间")
    if args.apply and not _text(args.env_id, 160):
        parser.error("写入迁移必须同时显式提供 --apply 和 --env-id")
    return args


def _print_plan(
    plan: MigrationPlan,
    *,
    mode: str,
    env_id: str,
    missing_indexes: Sequence[IndexSpec],
    old_index_present: bool,
) -> None:
    print("=" * 68)
    print(" Cat-AI CloudBase 猫际关系 v2 迁移")
    print("=" * 68)
    print(f" 模式: {mode}")
    print(f" 环境: {env_id}")
    print(f" 关系边: {plan.edge_count}（v2 {plan.directed_edge_count} / legacy {plan.legacy_edge_count}）")
    print(f" 投票: {plan.vote_count}")
    print(f" 待更新: 边 {len(plan.edge_patches)} / 投票 {len(plan.vote_patches)}")
    if missing_indexes:
        print(" 待创建索引: " + ", ".join(spec.name for spec in missing_indexes))
    else:
        print(" 新索引: 已存在且定义匹配")
    if old_index_present:
        print(f" 待删除旧索引: {OLD_UNIQUE_INDEX}（仅在新索引回读确认后删除）")
    else:
        print(f" 旧索引: {OLD_UNIQUE_INDEX} 不存在，无需删除")
    if plan.issues:
        print(f" 阻断问题: {len(plan.issues)}")
        for issue in plan.issues[:20]:
            print(f"  - [{issue.code}] {issue.collection}/{issue.document_id}: {issue.message}")
        if len(plan.issues) > 20:
            print(f"  - 其余 {len(plan.issues) - 20} 条未展开")
    else:
        print(" 预检: 通过")


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    explicit_env_id = _text(args.env_id, 160)
    env_id = explicit_env_id or _infer_env_id()
    if not env_id:
        print("错误：无法确定 CloudBase 环境；请提供 --env-id", file=sys.stderr)
        return 2
    try:
        runner = CloudBaseRunner(env_id, timeout_seconds=args.timeout, page_size=args.page_size)
        plan = _load_plan(runner)
        current_indexes = runner.list_indexes()
        missing_indexes = _validate_index_names(current_indexes)
        old_index_present = OLD_UNIQUE_INDEX in _index_by_name(current_indexes)
        _print_plan(
            plan,
            mode="APPLY" if args.apply else "DRY-RUN",
            env_id=env_id,
            missing_indexes=missing_indexes,
            old_index_present=old_index_present,
        )
        if not plan.ready:
            print("结果：预检未通过，未写入 CloudBase。", file=sys.stderr)
            return 2
        if not args.apply:
            print("\n结果：dry-run 完成，未写入 CloudBase。")
            print("Apply 命令：python tools/cloudbase_relationship_v2.py --apply --env-id <ENV_ID>")
            return 0
        # parse_args requires the environment ID to be explicitly supplied in apply mode.
        if not explicit_env_id:
            raise MigrationError("apply 模式缺少显式 --env-id")
        apply_migration(runner, plan)
        print("\n结果：文档迁移、新索引确认和旧索引清理已完成。")
        return 0
    except MigrationError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
