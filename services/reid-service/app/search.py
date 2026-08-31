"""Exact cosine template search and deterministic identity aggregation."""

from __future__ import annotations

from collections import defaultdict

import numpy as np

from .contracts import GalleryTemplate, IdentityCandidate, TemplateMatch, decode_embedding


def exact_search(
    query_embedding: np.ndarray,
    gallery: list[GalleryTemplate],
    top_k: int,
) -> tuple[list[IdentityCandidate], list[TemplateMatch]]:
    if not gallery:
        return [], []

    query = np.asarray(query_embedding, dtype=np.float32).reshape(-1)
    vectors = np.vstack([decode_embedding(item.embedding_base64) for item in gallery])
    similarities = np.clip(vectors @ query, -1.0, 1.0)

    ordered_template_indices = sorted(
        range(len(gallery)),
        key=lambda index: (
            -float(similarities[index]),
            gallery[index].cat_id,
            gallery[index].template_id,
        ),
    )
    template_matches = [
        TemplateMatch(
            rank=rank,
            templateId=gallery[index].template_id,
            catId=gallery[index].cat_id,
            sessionId=gallery[index].session_id,
            cosineSimilarity=float(similarities[index]),
        )
        for rank, index in enumerate(ordered_template_indices[:top_k], start=1)
    ]

    cat_indices: dict[str, list[int]] = defaultdict(list)
    for index, template in enumerate(gallery):
        cat_indices[template.cat_id].append(index)

    unranked: list[IdentityCandidate] = []
    for cat_id, indices in cat_indices.items():
        best_by_session: dict[str, int] = {}
        for index in indices:
            session_id = gallery[index].session_id
            previous = best_by_session.get(session_id)
            if previous is None or _is_better(index, previous, similarities, gallery):
                best_by_session[session_id] = index
        session_indices = sorted(
            best_by_session.values(),
            key=lambda index: (-float(similarities[index]), gallery[index].template_id),
        )
        session_scores = np.asarray([float(similarities[index]) for index in session_indices], dtype=np.float64)
        top_session_scores = session_scores[:3]
        best_index = session_indices[0]
        best = float(session_scores[0])
        mean_top = float(np.mean(top_session_scores))
        retrieval_score = 0.6 * best + 0.4 * mean_top
        unranked.append(
            IdentityCandidate(
                rank=0,
                catId=cat_id,
                retrievalScore=retrieval_score,
                bestSimilarity=best,
                meanTopSessions=mean_top,
                medianSessionSimilarity=float(np.median(session_scores)),
                sessionStddev=float(np.std(session_scores)),
                independentSessions=len(session_indices),
                templatesCompared=len(indices),
                bestTemplateId=gallery[best_index].template_id,
            )
        )

    unranked.sort(key=lambda candidate: (-candidate.retrieval_score, candidate.cat_id))
    candidates: list[IdentityCandidate] = []
    for rank, candidate in enumerate(unranked[:top_k], start=1):
        candidates.append(candidate.model_copy(update={"rank": rank}))
    return candidates, template_matches


def _is_better(
    candidate_index: int,
    previous_index: int,
    similarities: np.ndarray,
    gallery: list[GalleryTemplate],
) -> bool:
    candidate_score = float(similarities[candidate_index])
    previous_score = float(similarities[previous_index])
    if candidate_score != previous_score:
        return candidate_score > previous_score
    return gallery[candidate_index].template_id < gallery[previous_index].template_id

