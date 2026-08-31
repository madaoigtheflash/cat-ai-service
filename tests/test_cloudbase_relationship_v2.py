from __future__ import annotations

import json

import pytest

from tools.cloudbase_relationship_v2 import (
    EDGES_COLLECTION,
    NEW_EDGE_INDEXES,
    OLD_UNIQUE_INDEX,
    RELATIONSHIP_CONTRACT_ID,
    VOTES_COLLECTION,
    IndexSpec,
    apply_migration,
    build_migration_plan,
    index_matches_spec,
    make_create_indexes_command,
    make_drop_old_index_command,
    make_update_command,
    parse_args,
)


def _mixed_documents():
    edges = [
        {
            "_id": "edge_directed",
            "communityId": "community_a",
            "directionVersion": 2,
            "fromCatId": "cat_a",
            "toCatId": "cat_b",
        },
        {
            "_id": "edge_legacy",
            "communityId": "community_a",
            "catAId": "cat_a",
            "catBId": "cat_c",
            "directionVersion": 1,
        },
    ]
    votes = [
        {
            "_id": "vote_directed",
            "edgeId": "edge_directed",
            "communityId": "community_a",
            "ownerKey": "must-never-appear",
        },
        {
            "_id": "vote_legacy",
            "edgeId": "edge_legacy",
            "communityId": "community_a",
            "ownerKey": "must-never-appear",
        },
    ]
    return edges, votes


def test_plan_backfills_directed_legacy_and_vote_contracts_without_secrets():
    edges, votes = _mixed_documents()
    plan = build_migration_plan(edges, votes)

    assert plan.ready
    assert plan.directed_edge_count == 1
    assert plan.legacy_edge_count == 1
    assert len(plan.edge_patches) == 2
    assert len(plan.vote_patches) == 2

    edge_patches = {item.document_id: item.set_fields for item in plan.edge_patches}
    assert edge_patches["edge_directed"] == {
        "relationshipContractId": RELATIONSHIP_CONTRACT_ID,
        "relationshipContractVersion": 2,
        "directionState": "directed",
        "directionKey": "cat_a::cat_b",
        "catAId": "cat_a",
        "catBId": "cat_b",
    }
    assert edge_patches["edge_legacy"] == {
        "relationshipContractId": RELATIONSHIP_CONTRACT_ID,
        "relationshipContractVersion": 1,
        "directionState": "legacy_pending",
        "directionKey": "legacy::edge_legacy",
    }

    vote_patches = {item.document_id: item.set_fields for item in plan.vote_patches}
    assert vote_patches["vote_directed"]["directionKey"] == "cat_a::cat_b"
    assert vote_patches["vote_directed"]["fromCatId"] == "cat_a"
    assert vote_patches["vote_directed"]["toCatId"] == "cat_b"
    assert vote_patches["vote_directed"]["relationshipContractVersion"] == 2
    assert vote_patches["vote_legacy"]["directionKey"] == "legacy::edge_legacy"
    assert vote_patches["vote_legacy"]["directionState"] == "legacy_pending"
    assert vote_patches["vote_legacy"]["relationshipContractVersion"] == 1
    assert "fromCatId" not in vote_patches["vote_legacy"]
    assert "toCatId" not in vote_patches["vote_legacy"]

    serialized = json.dumps(
        [make_update_command(EDGES_COLLECTION, plan.edge_patches),
         make_update_command(VOTES_COLLECTION, plan.vote_patches)],
        ensure_ascii=False,
    )
    assert "ownerKey" not in serialized
    assert "must-never-appear" not in serialized


def test_plan_is_idempotent_after_patches_are_applied_in_memory():
    edges, votes = _mixed_documents()
    plan = build_migration_plan(edges, votes)
    edges_by_id = {item["_id"]: item for item in edges}
    votes_by_id = {item["_id"]: item for item in votes}
    for patch in plan.edge_patches:
        edges_by_id[patch.document_id].update(patch.set_fields)
    for patch in plan.vote_patches:
        votes_by_id[patch.document_id].update(patch.set_fields)

    verified = build_migration_plan(list(edges_by_id.values()), list(votes_by_id.values()))
    assert verified.ready
    assert verified.patch_count == 0


def test_plan_blocks_duplicate_direction_self_loop_and_orphan_vote():
    edges = [
        {
            "_id": "edge_a",
            "communityId": "community_a",
            "directionVersion": 2,
            "fromCatId": "cat_a",
            "toCatId": "cat_b",
        },
        {
            "_id": "edge_duplicate",
            "communityId": "community_a",
            "directionVersion": 2,
            "fromCatId": "cat_a",
            "toCatId": "cat_b",
        },
        {
            "_id": "edge_self",
            "communityId": "community_a",
            "directionVersion": 2,
            "fromCatId": "cat_a",
            "toCatId": "cat_a",
        },
    ]
    votes = [{"_id": "vote_orphan", "edgeId": "missing", "communityId": "community_a"}]

    plan = build_migration_plan(edges, votes)
    codes = {item.code for item in plan.issues}
    assert not plan.ready
    assert codes == {"duplicate_direction_key", "invalid_v2_endpoints", "orphan_vote"}


def test_empty_collections_still_produce_a_ready_index_migration_plan():
    plan = build_migration_plan([], [])
    assert plan.ready
    assert plan.edge_count == 0
    assert plan.vote_count == 0
    assert plan.patch_count == 0

    create = json.loads(make_create_indexes_command(NEW_EDGE_INDEXES)["Command"])
    assert create["createIndexes"] == EDGES_COLLECTION
    assert [item["name"] for item in create["indexes"]] == [
        "uniq_relationship_direction_key",
        "idx_relationship_active_from",
        "idx_relationship_active_to",
    ]
    assert create["indexes"][0]["unique"] is True
    assert create["indexes"][0]["key"] == {"communityId": 1, "directionKey": 1}

    drop = json.loads(make_drop_old_index_command()["Command"])
    assert drop == {"dropIndexes": EDGES_COLLECTION, "index": OLD_UNIQUE_INDEX}


def test_index_matching_requires_key_order_and_uniqueness():
    spec = IndexSpec("example", (("communityId", 1), ("directionKey", 1)), unique=True)
    assert index_matches_spec(
        {"name": "example", "key": {"communityId": 1, "directionKey": 1}, "unique": True},
        spec,
    )
    assert not index_matches_spec(
        {"name": "example", "key": {"directionKey": 1, "communityId": 1}, "unique": True},
        spec,
    )
    assert not index_matches_spec(
        {"name": "example", "key": {"communityId": 1, "directionKey": 1}},
        spec,
    )


def test_apply_requires_an_explicit_environment_id():
    assert parse_args([]).apply is False
    with pytest.raises(SystemExit):
        parse_args(["--apply"])
    parsed = parse_args(["--apply", "--env-id", "cloud-test"])
    assert parsed.apply is True
    assert parsed.env_id == "cloud-test"


class _EmptyCollectionRunner:
    def __init__(self):
        self.indexes = [
            {
                "name": OLD_UNIQUE_INDEX,
                "key": {"communityId": 1, "catAId": 1, "catBId": 1},
                "unique": True,
            }
        ]
        self.events: list[str] = []

    def query_all(self, collection, fields):
        self.events.append(f"query:{collection}")
        return []

    def list_indexes(self):
        self.events.append("list_indexes")
        return list(self.indexes)

    def execute(self, commands):
        assert len(commands) == 1
        payload = json.loads(commands[0]["Command"])
        if "createIndexes" in payload:
            self.events.append("create_indexes")
            self.indexes.extend(payload["indexes"])
        elif "dropIndexes" in payload:
            assert all(
                any(item.get("name") == spec.name for item in self.indexes)
                for spec in NEW_EDGE_INDEXES
            ), "old index must not be dropped before every new index is visible"
            self.events.append("drop_old_index")
            self.indexes = [item for item in self.indexes if item.get("name") != OLD_UNIQUE_INDEX]
        else:
            raise AssertionError(f"unexpected command: {payload}")
        return [{"ok": 1}]


def test_empty_apply_confirms_new_indexes_before_dropping_old_unique_index():
    runner = _EmptyCollectionRunner()
    plan = build_migration_plan([], [])

    apply_migration(runner, plan)

    assert "create_indexes" in runner.events
    assert "drop_old_index" in runner.events
    assert runner.events.index("create_indexes") < runner.events.index("drop_old_index")
    assert OLD_UNIQUE_INDEX not in {item.get("name") for item in runner.indexes}
    assert {spec.name for spec in NEW_EDGE_INDEXES}.issubset(
        {item.get("name") for item in runner.indexes}
    )
