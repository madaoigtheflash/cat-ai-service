"""把 CloudBase 管理员文档投影为浏览器可安全读取的统一视图。"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

from .cloudbase_cli import SourceResult


CHOICE_LABELS = {
    "bonded": ("主动亲近", "主动亲近方", "亲近对象"),
    "playmate": ("发起玩耍", "玩耍发起方", "玩耍回应方"),
    "housemate": ("平静共处", "平静共处方", "共处伙伴"),
    "needs_space": ("需要空间", "需要空间方", "相处对象"),
    "unsure": ("暂时看不准", "观察发起方", "观察对象"),
}

ROLE_LABELS = {
    "owner": "创建者",
    "admin": "管理员",
    "reviewer": "审核员",
    "member": "成员",
}

RELATION_CONTRACT_ID = "cat-ai.relationship.directed"
RELATION_CONTRACT_VERSION = 2
RELATION_DIRECTION_VERSION = 2
RELATION_DIRECTION_STATE = "directed"

SENSITIVE_PATTERNS = (
    (re.compile(r"(?i)\bsk-[A-Za-z0-9_-]{12,}\b"), "[API_KEY_REDACTED]"),
    (re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"), "[EMAIL_REDACTED]"),
    (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "[PHONE_REDACTED]"),
    (re.compile(r"\bowner_[A-Za-z0-9_-]{12,}\b"), "[OWNER_KEY_REDACTED]"),
)


def _doc_id(document: dict[str, Any]) -> str:
    return str(document.get("_id") or document.get("id") or "").strip()[:160]


def _text(value: Any, limit: int = 160) -> str:
    if value is None:
        return ""
    return "".join(char for char in str(value) if ord(char) >= 32).strip()[:limit]


def _number(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def _timestamp(value: Any) -> str:
    return _text(value, 64)


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _redacted_text(value: Any, limit: int) -> str:
    text = _text(value, limit)
    for pattern, replacement in SENSITIVE_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def _new_cat(community_id: str, cat_id: str) -> dict[str, Any]:
    return {
        "id": cat_id,
        "canonicalCatId": cat_id,
        "communityId": community_id,
        "displayName": "未命名猫咪",
        "breed": "",
        "gender": "",
        "coatColor": "",
        "estimatedAge": "",
        "state": "reference_only",
        "source": "reference_only",
        "identityVersion": 0,
        "aliasIds": set(),
        "remotePetIds": set(),
        "linkStates": set(),
        "templateCount": 0,
        "activeTemplateCount": 0,
        "assignmentCount": 0,
        "activeAssignmentCount": 0,
        "identityTaskCount": 0,
        "sightingCount": 0,
        "incomingRelationCount": 0,
        "outgoingRelationCount": 0,
        "legacyRelationCount": 0,
        "lastSeenAt": "",
        "lastSyncedAt": "",
        "createdAt": "",
        "updatedAt": "",
        "warnings": set(),
    }


def _latest(*values: Any) -> str:
    return max((_timestamp(value) for value in values), default="")


def build_snapshot(source: SourceResult, env_id: str) -> dict[str, Any]:
    data = source.collections
    issues: list[dict[str, str]] = []
    issue_keys: set[tuple[str, str, str, str]] = set()
    communities_raw = {
        _doc_id(item): item
        for item in data.get("ci_communities", [])
        if _doc_id(item)
    }
    identities_raw = {
        _doc_id(item): item
        for item in data.get("ci_cat_identities", [])
        if _doc_id(item)
    }

    def add_issue(kind: str, message: str, community_id: str = "", ref_id: str = "") -> None:
        item = {
            "kind": _text(kind, 80),
            "message": _text(message, 240),
            "communityId": _text(community_id, 120),
            "referenceId": _text(ref_id, 160),
        }
        key = (item["kind"], item["message"], item["communityId"], item["referenceId"])
        if key not in issue_keys:
            issue_keys.add(key)
            issues.append(item)

    def resolve_cat_id(raw_id: Any, expected_community: str = "") -> str:
        current = _text(raw_id, 160)
        if not current:
            return ""
        visited: set[str] = set()
        for _ in range(8):
            if current in visited:
                add_issue("canonical_cycle", "猫咪 canonicalCatId 出现循环", expected_community, current)
                return current
            visited.add(current)
            identity = identities_raw.get(current)
            if not identity:
                return current
            identity_community = _text(identity.get("communityId"), 120)
            if expected_community and identity_community and identity_community != expected_community:
                add_issue("cross_community", "猫咪身份引用跨越了小屋", expected_community, current)
                return current
            next_id = _text(identity.get("canonicalCatId"), 160)
            if not next_id or next_id == current:
                return current
            if next_id not in identities_raw:
                add_issue(
                    "missing_canonical_target",
                    f"猫咪 canonicalCatId 指向不存在的身份：{next_id}",
                    expected_community,
                    current,
                )
                return current
            target_community = _text(identities_raw[next_id].get("communityId"), 120)
            if expected_community and target_community and target_community != expected_community:
                add_issue(
                    "cross_community",
                    "猫咪 canonicalCatId 指向了另一个小屋的身份",
                    expected_community,
                    current,
                )
                return current
            current = next_id
        add_issue("canonical_depth", "猫咪 canonicalCatId 链超过 8 层", expected_community, current)
        return current

    cats: dict[tuple[str, str], dict[str, Any]] = {}

    def ensure_cat(community_id: str, cat_id: str) -> dict[str, Any]:
        key = (community_id, cat_id)
        if key not in cats:
            cats[key] = _new_cat(community_id, cat_id)
        return cats[key]

    for identity_id, identity in identities_raw.items():
        community_id = _text(identity.get("communityId"), 120)
        if not community_id:
            add_issue("orphan_identity", "猫咪身份缺少 communityId", "", identity_id)
            continue
        canonical_id = resolve_cat_id(identity_id, community_id)
        cat = ensure_cat(community_id, canonical_id)
        if identity_id != canonical_id:
            cat["aliasIds"].add(identity_id)
        is_canonical_record = identity_id == canonical_id
        display_name = _text(identity.get("displayName"), 60)
        if display_name and (is_canonical_record or cat["displayName"] == "未命名猫咪"):
            cat["displayName"] = display_name
        for field in ("breed", "gender", "coatColor", "estimatedAge"):
            value = _text(identity.get(field), 80)
            if value and (is_canonical_record or not cat[field]):
                cat[field] = value
        if is_canonical_record or cat["state"] == "reference_only":
            cat["state"] = _text(identity.get("state"), 32) or "active"
            cat["source"] = _text(identity.get("source"), 64) or "identity"
            cat["identityVersion"] = _number(identity.get("identityVersion"))
        cat["createdAt"] = cat["createdAt"] or _timestamp(identity.get("createdAt"))
        cat["updatedAt"] = _latest(cat["updatedAt"], identity.get("updatedAt"))

    for link in data.get("ci_user_pet_links", []):
        remote_id = _doc_id(link)
        community_id = _text(link.get("communityId"), 120)
        raw_cat_id = _text(link.get("catId"), 160) or remote_id
        if not community_id or not raw_cat_id:
            add_issue("orphan_link", "云端档案映射缺少小屋或猫咪 ID", community_id, remote_id)
            continue
        canonical_id = resolve_cat_id(raw_cat_id, community_id)
        cat = ensure_cat(community_id, canonical_id)
        cat["remotePetIds"].add(remote_id)
        state = _text(link.get("state"), 32) or "active"
        cat["linkStates"].add(state)
        for field, limit in (
            ("displayName", 60), ("breed", 80), ("gender", 32),
            ("coatColor", 80), ("estimatedAge", 80),
        ):
            value = _text(link.get(field), limit)
            if value and (field != "displayName" or cat[field] == "未命名猫咪") and not cat[field if field != "displayName" else "displayName"]:
                cat[field] = value
            elif field == "displayName" and value and cat["displayName"] == "未命名猫咪":
                cat["displayName"] = value
        if cat["source"] == "reference_only":
            cat["source"] = "synced_user_pet"
            cat["state"] = state
        cat["lastSyncedAt"] = _latest(cat["lastSyncedAt"], link.get("updatedAt"))
        cat["createdAt"] = cat["createdAt"] or _timestamp(link.get("createdAt"))
        cat["updatedAt"] = _latest(cat["updatedAt"], link.get("updatedAt"))
        if raw_cat_id not in identities_raw:
            cat["warnings"].add("缺少规范身份文档")
            add_issue("missing_identity", "云端档案映射指向的规范猫身份不存在", community_id, raw_cat_id)

    for template in data.get("ci_identity_templates", []):
        community_id = _text(template.get("communityId"), 120)
        cat_id = resolve_cat_id(template.get("catId"), community_id)
        if not community_id or not cat_id:
            continue
        cat = ensure_cat(community_id, cat_id)
        cat["templateCount"] += 1
        if _text(template.get("state"), 32) == "active":
            cat["activeTemplateCount"] += 1

    for assignment in data.get("ci_identity_assignments", []):
        community_id = _text(assignment.get("communityId"), 120)
        cat_id = resolve_cat_id(assignment.get("catId"), community_id)
        if not community_id or not cat_id:
            continue
        cat = ensure_cat(community_id, cat_id)
        cat["assignmentCount"] += 1
        if _text(assignment.get("state"), 32) == "active":
            cat["activeAssignmentCount"] += 1

    job_counts: Counter[str] = Counter()
    for job in data.get("ci_identity_jobs", []):
        community_id = _text(job.get("communityId"), 120)
        if community_id:
            job_counts[community_id] += 1
        cat_id = resolve_cat_id(job.get("linkedCatId"), community_id)
        if community_id and cat_id:
            ensure_cat(community_id, cat_id)["identityTaskCount"] += 1

    sightings: list[dict[str, Any]] = []
    sighting_counts: Counter[str] = Counter()
    map_cells: dict[tuple[str, str], dict[str, Any]] = {}
    for document in data.get("ci_sightings_public", []):
        sighting_id = _doc_id(document)
        community_id = _text(document.get("communityId"), 120)
        raw_cat_id = (
            _text(document.get("identityCatId"), 160)
            or _text(document.get("catId"), 160)
            or _text(document.get("remotePetId"), 160)
        )
        cat_id = resolve_cat_id(raw_cat_id, community_id) if raw_cat_id else ""
        if community_id:
            sighting_counts[community_id] += 1
        cat = ensure_cat(community_id, cat_id) if community_id and cat_id else None
        if cat:
            cat["sightingCount"] += 1
            cat["lastSeenAt"] = _latest(
                cat["lastSeenAt"], document.get("reviewedAt"), document.get("submittedAt")
            )
        coarse = document.get("coarseLocation") if isinstance(document.get("coarseLocation"), dict) else {}
        longitude = coarse.get("longitude")
        latitude = coarse.get("latitude")
        has_point = (
            isinstance(longitude, (int, float))
            and not isinstance(longitude, bool)
            and math.isfinite(float(longitude))
            and -180 <= float(longitude) <= 180
            and isinstance(latitude, (int, float))
            and not isinstance(latitude, bool)
            and math.isfinite(float(latitude))
            and -90 <= float(latitude) <= 90
        )
        safe_coarse = None
        if coarse:
            safe_coarse = {
                "cellId": _text(coarse.get("cellId"), 80),
                "precisionKm": _number(coarse.get("precisionKm"), 2) or 2,
                "coordinateSystem": _text(coarse.get("coordinateSystem"), 16) or "gcj02",
                "longitude": round(float(longitude), 4) if has_point else None,
                "latitude": round(float(latitude), 4) if has_point else None,
            }
        sighting = {
            "id": sighting_id,
            "communityId": community_id,
            "catId": cat_id or None,
            "catName": cat["displayName"] if cat else "未关联猫咪",
            "state": _text(document.get("state"), 32) or "APPROVED",
            "caption": _text(document.get("caption"), 160),
            "observedTimeBucket": _timestamp(document.get("observedTimeBucket")),
            "submittedAt": _timestamp(document.get("submittedAt")),
            "reviewedAt": _timestamp(document.get("reviewedAt")),
            "identityTemplateReady": bool(document.get("identityTemplateReady")),
            "coarseLocation": safe_coarse,
        }
        sightings.append(sighting)
        if safe_coarse and safe_coarse["cellId"] and has_point:
            key = (community_id, safe_coarse["cellId"])
            cell = map_cells.setdefault(key, {
                **safe_coarse,
                "communityId": community_id,
                "sightingCount": 0,
                "catIds": set(),
                "catNames": set(),
                "latestTimeBucket": "",
            })
            cell["sightingCount"] += 1
            if cat_id:
                cell["catIds"].add(cat_id)
            if cat:
                cell["catNames"].add(cat["displayName"])
            cell["latestTimeBucket"] = _latest(
                cell["latestTimeBucket"], document.get("observedTimeBucket")
            )

    relationships: list[dict[str, Any]] = []
    relation_counts: Counter[str] = Counter()
    for edge in data.get("ci_relationship_edges", []):
        edge_id = _doc_id(edge)
        community_id = _text(edge.get("communityId"), 120)
        version = _number(edge.get("directionVersion"), 1) or 1
        contract_id = _text(edge.get("relationshipContractId"), 120)
        contract_version = _number(edge.get("relationshipContractVersion"))
        source_direction_state = _text(edge.get("directionState"), 32)
        direction_key = _text(edge.get("directionKey"), 192)
        raw_directed_from = _text(edge.get("fromCatId"), 160)
        raw_directed_to = _text(edge.get("toCatId"), 160)
        compatibility_from = _text(edge.get("catAId"), 160)
        compatibility_to = _text(edge.get("catBId"), 160)
        v2_signaled = bool(
            version == RELATION_DIRECTION_VERSION
            or contract_id
            or contract_version
            or source_direction_state == RELATION_DIRECTION_STATE
            or direction_key
            or raw_directed_from
            or raw_directed_to
        )
        directed = (
            version == RELATION_DIRECTION_VERSION
            and bool(raw_directed_from)
            and bool(raw_directed_to)
        )
        expected_direction_key = (
            f"{raw_directed_from}::{raw_directed_to}"
            if raw_directed_from and raw_directed_to
            else ""
        )
        contract_valid = False
        compatibility_valid = False
        if v2_signaled:
            missing_fields = []
            if not contract_id:
                missing_fields.append("relationshipContractId")
            if not contract_version:
                missing_fields.append("relationshipContractVersion")
            if not source_direction_state:
                missing_fields.append("directionState")
            if not direction_key:
                missing_fields.append("directionKey")
            if not raw_directed_from:
                missing_fields.append("fromCatId")
            if not raw_directed_to:
                missing_fields.append("toCatId")
            if missing_fields:
                add_issue(
                    "relationship_contract_incomplete",
                    f"有向关系 v2 缺少字段：{'、'.join(missing_fields)}",
                    community_id,
                    edge_id,
                )

            mismatched_fields = []
            if contract_id and contract_id != RELATION_CONTRACT_ID:
                mismatched_fields.append("relationshipContractId")
            if contract_version and contract_version != RELATION_CONTRACT_VERSION:
                mismatched_fields.append("relationshipContractVersion")
            if version != RELATION_DIRECTION_VERSION:
                mismatched_fields.append("directionVersion")
            if source_direction_state and source_direction_state != RELATION_DIRECTION_STATE:
                mismatched_fields.append("directionState")
            if mismatched_fields:
                add_issue(
                    "relationship_contract_mismatch",
                    f"有向关系 v2 契约值不匹配：{'、'.join(mismatched_fields)}",
                    community_id,
                    edge_id,
                )

            if direction_key and expected_direction_key and direction_key != expected_direction_key:
                add_issue(
                    "relationship_direction_key_mismatch",
                    "关系 directionKey 与 fromCatId/toCatId 不一致",
                    community_id,
                    edge_id,
                )

            compatibility_valid = bool(
                raw_directed_from
                and raw_directed_to
                and compatibility_from == raw_directed_from
                and compatibility_to == raw_directed_to
            )
            if not compatibility_valid:
                add_issue(
                    "relationship_compatibility_mismatch",
                    "关系兼容字段必须满足 catAId=fromCatId 且 catBId=toCatId",
                    community_id,
                    edge_id,
                )

            contract_valid = bool(
                not missing_fields
                and not mismatched_fields
                and direction_key == expected_direction_key
                and compatibility_valid
            )

        raw_from = raw_directed_from if directed else compatibility_from
        raw_to = raw_directed_to if directed else compatibility_to
        from_id = resolve_cat_id(raw_from, community_id)
        to_id = resolve_cat_id(raw_to, community_id)
        if not community_id or not from_id or not to_id:
            add_issue("invalid_relationship", "关系边缺少小屋或端点猫咪", community_id, edge_id)
            continue
        from_cat = ensure_cat(community_id, from_id)
        to_cat = ensure_cat(community_id, to_id)
        if from_cat["source"] == "reference_only":
            from_cat["warnings"].add("仅被关系边引用")
            add_issue("missing_relation_endpoint", "关系起点没有猫咪身份文档", community_id, from_id)
        if to_cat["source"] == "reference_only":
            to_cat["warnings"].add("仅被关系边引用")
            add_issue("missing_relation_endpoint", "关系终点没有猫咪身份文档", community_id, to_id)
        counts_raw = edge.get("voteCounts") if isinstance(edge.get("voteCounts"), dict) else {}
        vote_counts = {key: _number(counts_raw.get(key)) for key in CHOICE_LABELS}
        calculated_total = sum(vote_counts.values())
        stored_total = _number(edge.get("totalVotes"))
        if stored_total != calculated_total:
            add_issue("vote_count_mismatch", "关系票数与分项合计不一致", community_id, edge_id)
        max_votes = max(vote_counts.values(), default=0)
        leaders = [choice for choice, count in vote_counts.items() if max_votes and count == max_votes]
        dominant_choice = leaders[0] if len(leaders) == 1 else ""
        if len(leaders) > 1:
            label, from_role, to_role = ("意见并列", "关系主体", "关系对象")
        else:
            label, from_role, to_role = CHOICE_LABELS.get(
                dominant_choice, ("尚无投票", "关系主体", "关系对象")
            )
        self_loop = from_id == to_id
        if self_loop:
            add_issue(
                "relationship_self_loop",
                "猫咪身份合并后，关系的起点与终点变成同一只猫",
                community_id,
                edge_id,
            )
        elif directed and contract_valid:
            from_cat["outgoingRelationCount"] += 1
            to_cat["incomingRelationCount"] += 1
        elif not v2_signaled:
            from_cat["legacyRelationCount"] += 1
            to_cat["legacyRelationCount"] += 1
        relation_counts[community_id] += 1
        relation_valid = not self_loop and (contract_valid if v2_signaled else True)
        relationships.append({
            "id": edge_id,
            "communityId": community_id,
            "relationshipContractId": contract_id,
            "relationshipContractVersion": contract_version,
            "directionVersion": version,
            "directionState": (
                "self_loop_needs_review"
                if self_loop
                else (
                    "directed"
                    if directed and contract_valid
                    else ("directed_contract_invalid" if v2_signaled else "legacy_pending")
                )
            ),
            "sourceDirectionState": source_direction_state,
            "directionKey": direction_key,
            "expectedDirectionKey": expected_direction_key,
            "fromCatId": from_id,
            "toCatId": to_id,
            "fromCatName": from_cat["displayName"],
            "toCatName": to_cat["displayName"],
            "fromRole": from_role if directed else "旧版关系端点",
            "toRole": to_role if directed else "旧版关系端点",
            "arrow": "→" if directed else "↔?",
            "dominantChoice": dominant_choice,
            "dominantLabel": label if directed else "旧版方向待确认",
            "voteCounts": vote_counts if directed else {},
            "totalVotes": stored_total,
            "calculatedVoteTotal": calculated_total,
            "state": "needs_review" if self_loop else (_text(edge.get("state"), 32) or "active"),
            "sourceState": _text(edge.get("state"), 32) or "active",
            "updatedAt": _timestamp(edge.get("updatedAt")),
            "legacy": not v2_signaled,
            "selfLoop": self_loop,
            "contractValid": contract_valid if v2_signaled else None,
            "compatibilityValid": compatibility_valid if v2_signaled else None,
            "valid": relation_valid,
        })

    members_by_community: dict[str, Counter[str]] = defaultdict(Counter)
    members: list[dict[str, Any]] = []
    for member in data.get("ci_members", []):
        community_id = _text(member.get("communityId"), 120)
        if not community_id:
            continue
        if community_id not in communities_raw:
            add_issue("orphan_member", "成员引用的小屋不存在", community_id, _doc_id(member))
        state = _text(member.get("status"), 32) or "active"
        role = _text(member.get("role"), 32) or "member"
        members_by_community[community_id][f"{state}:{role}"] += 1
        members.append({
            "id": _doc_id(member),
            "communityId": community_id,
            "role": role,
            "roleLabel": ROLE_LABELS.get(role, role),
            "status": state,
            "createdAt": _timestamp(member.get("createdAt")),
            "updatedAt": _timestamp(member.get("updatedAt")),
        })

    cats_list: list[dict[str, Any]] = []
    cat_counts: Counter[str] = Counter()
    for cat in cats.values():
        cat_counts[cat["communityId"]] += 1
        cats_list.append({
            "id": cat["id"],
            "canonicalCatId": cat["canonicalCatId"],
            "communityId": cat["communityId"],
            "displayName": cat["displayName"],
            "breed": cat["breed"],
            "gender": cat["gender"],
            "coatColor": cat["coatColor"],
            "estimatedAge": cat["estimatedAge"],
            "state": cat["state"],
            "source": cat["source"],
            "identityVersion": cat["identityVersion"],
            "aliasIds": sorted(cat["aliasIds"]),
            "remotePetIds": sorted(cat["remotePetIds"]),
            "linkedProfileCount": len(cat["remotePetIds"]),
            "linkStates": sorted(cat["linkStates"]),
            "templateCount": cat["templateCount"],
            "activeTemplateCount": cat["activeTemplateCount"],
            "assignmentCount": cat["assignmentCount"],
            "activeAssignmentCount": cat["activeAssignmentCount"],
            "identityTaskCount": cat["identityTaskCount"],
            "sightingCount": cat["sightingCount"],
            "incomingRelationCount": cat["incomingRelationCount"],
            "outgoingRelationCount": cat["outgoingRelationCount"],
            "legacyRelationCount": cat["legacyRelationCount"],
            "lastSeenAt": cat["lastSeenAt"],
            "lastSyncedAt": cat["lastSyncedAt"],
            "createdAt": cat["createdAt"],
            "updatedAt": cat["updatedAt"],
            "warnings": sorted(cat["warnings"]),
        })

    map_cells_list = []
    for cell in map_cells.values():
        map_cells_list.append({
            **{key: value for key, value in cell.items() if key not in {"catIds", "catNames"}},
            "catIds": sorted(cell["catIds"]),
            "catNames": sorted(cell["catNames"]),
        })

    communities = []
    known_community_ids = set(communities_raw)
    referenced_ids = set(cat_counts) | set(relation_counts) | set(sighting_counts) | set(members_by_community)
    for missing_id in sorted(referenced_ids - known_community_ids):
        add_issue("missing_community", "数据引用的小屋文档不存在", missing_id, missing_id)
    for community_id, community in communities_raw.items():
        roles = Counter()
        active_members = 0
        for key, count in members_by_community[community_id].items():
            status, role = key.split(":", 1)
            if status == "active":
                active_members += count
                roles[role] += count
        communities.append({
            "id": community_id,
            "name": _text(community.get("name"), 60) or "未命名小屋",
            "scope": _text(community.get("scope"), 32) or "invite",
            "status": _text(community.get("status"), 32) or "active",
            "version": _number(community.get("version")),
            "ownerPending": community.get("ownerPending") is True,
            "managedByLocalAdmin": community.get("managedByLocalAdmin") is True,
            "memberCount": active_members,
            "roleCounts": {
                ROLE_LABELS.get(role, role): count for role, count in sorted(roles.items())
            },
            "catCount": cat_counts[community_id],
            "relationshipCount": relation_counts[community_id],
            "sightingCount": sighting_counts[community_id],
            "identityTaskCount": job_counts[community_id],
            "createdAt": _timestamp(community.get("createdAt")),
            "updatedAt": _timestamp(community.get("updatedAt")),
            "disabledAt": _timestamp(community.get("disabledAt")),
            "deletedAt": _timestamp(community.get("deletedAt")),
        })

    communities.sort(key=lambda item: (item["status"] != "active", item["name"], item["id"]))
    cats_list.sort(key=lambda item: (item["communityId"], item["displayName"], item["id"]))
    relationships.sort(key=lambda item: (item["communityId"], item["fromCatName"], item["toCatName"]))
    sightings.sort(key=lambda item: item["reviewedAt"] or item["submittedAt"], reverse=True)
    map_cells_list.sort(key=lambda item: (-item["sightingCount"], item["communityId"], item["cellId"]))

    feedback = []
    for document in data.get("ci_feedback", []):
        client = document.get("client") if isinstance(document.get("client"), dict) else {}
        feedback.append({
            "id": _doc_id(document),
            "category": _text(document.get("category"), 24) or "other",
            "title": _redacted_text(document.get("title"), 60),
            "content": _redacted_text(document.get("content"), 1000),
            "steps": _redacted_text(document.get("steps"), 500),
            "client": {
                "version": _text(client.get("version"), 40),
                "platform": _text(client.get("platform"), 24),
                "sdkVersion": _text(client.get("sdkVersion"), 32),
                "sourcePage": _text(client.get("sourcePage"), 80),
            },
            "status": _text(document.get("status"), 40) or "OPEN",
            "version": max(_number(document.get("version"), 1), 1),
            "proposalId": _text(document.get("proposalId"), 160),
            "createdAt": _timestamp(document.get("createdAt")),
            "updatedAt": _timestamp(document.get("updatedAt")),
        })
    feedback.sort(key=lambda item: item["createdAt"], reverse=True)

    change_proposals = []
    for document in data.get("ci_change_proposals", []):
        feasibility = document.get("feasibility") if isinstance(document.get("feasibility"), dict) else {}
        risks = document.get("risks") if isinstance(document.get("risks"), list) else []
        draft_changes = document.get("draftChanges") if isinstance(document.get("draftChanges"), list) else []
        change_proposals.append({
            "id": _doc_id(document),
            "title": _text(document.get("title"), 80),
            "summary": _text(document.get("summary"), 1200),
            "recommendation": _text(document.get("recommendation"), 32),
            "feasibility": {
                "level": _text(feasibility.get("level"), 16),
                "score": min(_number(feasibility.get("score")), 100),
                "reason": _text(feasibility.get("reason"), 800),
            },
            "affectedAreas": [
                _text(value, 80) for value in _list(document.get("affectedAreas"))
                if _text(value, 80)
            ][:12],
            "risks": [{
                "level": _text(value.get("level"), 16),
                "description": _text(value.get("description"), 240),
                "mitigation": _text(value.get("mitigation"), 240),
            } for value in risks[:10] if isinstance(value, dict)],
            "draftChanges": [{
                "area": _text(value.get("area"), 80),
                "currentProblem": _text(value.get("currentProblem"), 300),
                "proposedChange": _text(value.get("proposedChange"), 400),
                "acceptanceCriteria": [
                    _text(item, 200) for item in _list(value.get("acceptanceCriteria"))
                    if _text(item, 200)
                ][:8],
            } for value in draft_changes[:12] if isinstance(value, dict)],
            "testPlan": [
                _text(value, 240) for value in _list(document.get("testPlan"))
                if _text(value, 240)
            ][:16],
            "feedbackCount": _number(document.get("feedbackCount")),
            "status": _text(document.get("status"), 48),
            "version": max(_number(document.get("version"), 1), 1),
            "generatedAt": _timestamp(document.get("generatedAt")),
            "decidedAt": _timestamp(document.get("decidedAt")),
            "decisionNote": _text(document.get("decisionNote"), 240),
            "executionSummary": _text(document.get("executionSummary"), 1000),
            "updatedAt": _timestamp(document.get("updatedAt")),
        })
    change_proposals.sort(key=lambda item: item["generatedAt"], reverse=True)

    audit_logs = []
    for document in data.get("ci_admin_audit_logs", []):
        before = document.get("before") if isinstance(document.get("before"), dict) else None
        after = document.get("after") if isinstance(document.get("after"), dict) else None
        audit_logs.append({
            "id": _doc_id(document),
            "entityType": _text(document.get("entityType"), 40),
            "entityId": _text(document.get("entityId"), 160),
            "operation": _text(document.get("operation"), 32),
            "operator": _text(document.get("operator"), 80),
            "reason": _text(document.get("reason"), 200),
            "before": before,
            "after": after,
            "result": _text(document.get("result"), 32),
            "createdAt": _timestamp(document.get("createdAt")),
        })
    audit_logs.sort(key=lambda item: item["createdAt"], reverse=True)

    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "envId": env_id,
        "source": source.source_name,
        "readOnly": False,
        "primaryDataReadOnly": False,
        "stats": {
            "communityCount": len(communities),
            "activeCommunityCount": sum(item["status"] == "active" for item in communities),
            "catCount": len(cats_list),
            "activeCatCount": sum(item["state"] == "active" for item in cats_list),
            "relationshipCount": len(relationships),
            "directedRelationshipCount": sum(
                not item["legacy"] and item["valid"] for item in relationships
            ),
            "legacyRelationshipCount": sum(item["legacy"] for item in relationships),
            "invalidRelationshipCount": sum(not item["valid"] for item in relationships),
            "sightingCount": len(sightings),
            "locatedSightingCount": sum(bool(item["coarseLocation"] and item["coarseLocation"].get("longitude") is not None) for item in sightings),
            "identityTaskCount": len(data.get("ci_identity_jobs", [])),
            "activeTemplateCount": sum(item["activeTemplateCount"] for item in cats_list),
            "issueCount": len(issues),
            "feedbackCount": len(feedback),
            "openFeedbackCount": sum(item["status"] == "OPEN" for item in feedback),
            "proposalCount": len(change_proposals),
            "awaitingProposalCount": sum(
                item["status"] in {
                    "READY_FOR_LOCAL_REVIEW",
                    "AWAITING_ADMIN_APPROVAL",
                    "APPROVED_FOR_LOCAL_EXECUTION",
                }
                for item in change_proposals
            ),
        },
        "communities": communities,
        "members": members,
        "cats": cats_list,
        "relationships": relationships,
        "sightings": sightings,
        "mapCells": map_cells_list,
        "issues": issues,
        "feedback": feedback,
        "changeProposals": change_proposals,
        "auditLogs": audit_logs,
        "truncatedCollections": list(source.truncated_collections),
    }
