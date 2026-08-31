from __future__ import annotations

import numpy as np
import pytest

from app.contracts import GalleryTemplate
from app.search import exact_search

from conftest import embedding_base64


def _template(template_id: str, cat_id: str, session_id: str, vector: np.ndarray) -> GalleryTemplate:
    return GalleryTemplate(
        templateId=template_id,
        catId=cat_id,
        sessionId=session_id,
        embeddingBase64=embedding_base64(vector),
    )


def _unit(values: list[float]) -> np.ndarray:
    vector = np.zeros(512, dtype=np.float32)
    vector[: len(values)] = values
    return vector / np.linalg.norm(vector)


def test_exact_cosine_ordering() -> None:
    query = _unit([1.0, 0.0])
    gallery = [
        _template("tpl-neg", "cat-neg", "s1", _unit([-1.0, 0.0])),
        _template("tpl-mid", "cat-mid", "s1", _unit([0.8, 0.6])),
        _template("tpl-one", "cat-one", "s1", _unit([1.0, 0.0])),
    ]
    candidates, templates = exact_search(query, gallery, top_k=2)
    assert [item.cat_id for item in candidates] == ["cat-one", "cat-mid"]
    assert [item.template_id for item in templates] == ["tpl-one", "tpl-mid"]
    assert candidates[0].best_similarity == pytest.approx(1.0)
    assert candidates[1].best_similarity == pytest.approx(0.8, abs=1e-6)


def test_identity_aggregation_uses_one_representative_per_session() -> None:
    query = _unit([1.0, 0.0])
    gallery = [
        _template("tpl-a1-best", "cat-a", "session-a", _unit([1.0, 0.0])),
        _template("tpl-a1-worse", "cat-a", "session-a", _unit([0.6, 0.8])),
        _template("tpl-a2", "cat-a", "session-b", _unit([0.8, 0.6])),
        _template("tpl-b", "cat-b", "session-a", _unit([0.7, np.sqrt(0.51)])),
    ]
    candidates, _ = exact_search(query, gallery, top_k=2)
    cat_a = candidates[0]
    assert cat_a.cat_id == "cat-a"
    assert cat_a.independent_sessions == 2
    assert cat_a.templates_compared == 3
    assert cat_a.best_template_id == "tpl-a1-best"
    assert cat_a.mean_top_sessions == pytest.approx(0.9, abs=1e-6)
    assert cat_a.retrieval_score == pytest.approx(0.96, abs=1e-6)


def test_ties_have_stable_id_order() -> None:
    query = _unit([1.0])
    gallery = [
        _template("tpl-z", "cat-z", "session-1", query),
        _template("tpl-a", "cat-a", "session-1", query),
    ]
    candidates, templates = exact_search(query, gallery, top_k=2)
    assert [item.cat_id for item in candidates] == ["cat-a", "cat-z"]
    assert [item.template_id for item in templates] == ["tpl-a", "tpl-z"]

