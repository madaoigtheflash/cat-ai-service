"""Evaluate pet re-identification on identity-labelled folders."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

from poc_validate import MODEL_SHA256, cosine, describe, embed, sha256, validate_contract


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def collect_dataset(root: Path) -> dict[str, list[Path]]:
    identities: dict[str, list[Path]] = {}
    for identity_dir in sorted(path for path in root.iterdir() if path.is_dir()):
        images = sorted(
            path
            for path in identity_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        )
        if images:
            identities[identity_dir.name] = images
    return identities


def auc_from_scores(positive: list[float], negative: list[float]) -> float:
    """Mann-Whitney AUC with average ranks for ties."""
    labelled = [(score, 1) for score in positive] + [(score, 0) for score in negative]
    labelled.sort(key=lambda item: item[0])
    positive_rank_sum = 0.0
    rank = 1
    index = 0
    while index < len(labelled):
        end = index + 1
        while end < len(labelled) and labelled[end][0] == labelled[index][0]:
            end += 1
        average_rank = (rank + (rank + end - index - 1)) / 2
        positive_rank_sum += average_rank * sum(label for _, label in labelled[index:end])
        rank += end - index
        index = end
    positive_count = len(positive)
    negative_count = len(negative)
    return (
        positive_rank_sum - positive_count * (positive_count + 1) / 2
    ) / (positive_count * negative_count)


def threshold_metrics(
    positive: list[float], negative: list[float], target_far: float
) -> dict[str, object]:
    candidates = sorted(set(positive + negative), reverse=True)
    candidates = [math.nextafter(candidates[0], math.inf)] + candidates
    rows: list[dict[str, float]] = []
    for threshold in candidates:
        far = sum(score >= threshold for score in negative) / len(negative)
        frr = sum(score < threshold for score in positive) / len(positive)
        rows.append({"threshold": threshold, "far": far, "frr": frr, "tar": 1 - frr})
    eer_row = min(rows, key=lambda row: abs(row["far"] - row["frr"]))
    allowed = [row for row in rows if row["far"] <= target_far]
    operating = max(allowed, key=lambda row: (row["tar"], -row["threshold"]))
    return {
        "auc": round(auc_from_scores(positive, negative), 6),
        "eer": round((eer_row["far"] + eer_row["frr"]) / 2, 6),
        "eer_threshold": round(eer_row["threshold"], 6),
        "target_far": target_far,
        "operating_threshold": round(operating["threshold"], 6),
        "far_at_operating_threshold": round(operating["far"], 6),
        "tar_at_operating_threshold": round(operating["tar"], 6),
    }


def identity_score(query: np.ndarray, templates: list[np.ndarray]) -> float:
    similarities = sorted((cosine(query, template) for template in templates), reverse=True)
    top = similarities[:3]
    return 0.6 * top[0] + 0.4 * statistics.fmean(top)


def identification_metrics(
    samples: list[tuple[str, Path, np.ndarray]],
) -> dict[str, object]:
    ranks: list[int] = []
    margins: list[float] = []
    for query_index, (query_identity, _, query_vector) in enumerate(samples):
        candidates: dict[str, list[np.ndarray]] = defaultdict(list)
        for template_index, (template_identity, _, template_vector) in enumerate(samples):
            if query_index != template_index:
                candidates[template_identity].append(template_vector)
        scored = sorted(
            (
                (identity_score(query_vector, templates), identity)
                for identity, templates in candidates.items()
                if templates
            ),
            reverse=True,
        )
        rank = next(index for index, (_, identity) in enumerate(scored, 1) if identity == query_identity)
        ranks.append(rank)
        correct_score = next(score for score, identity in scored if identity == query_identity)
        impostor_scores = [score for score, identity in scored if identity != query_identity]
        if impostor_scores:
            margins.append(correct_score - max(impostor_scores))
    count = len(ranks)
    return {
        "protocol": "leave-one-image-out; identity score = 0.6*best + 0.4*mean(top3)",
        "queries": count,
        "top1": round(sum(rank <= 1 for rank in ranks) / count, 6),
        "top3": round(sum(rank <= 3 for rank in ranks) / count, 6),
        "mean_rank": round(statistics.fmean(ranks), 6),
        "correct_vs_best_impostor_margin": describe(margins),
    }


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="Folder containing one subfolder per cat")
    parser.add_argument(
        "--model",
        type=Path,
        default=root / "tools/pet_reid/models/pet-recognition-small.onnx",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=root / "tools/pet_reid/reports/dataset-latest.json",
    )
    parser.add_argument("--target-far", type=float, default=0.01)
    parser.add_argument("--skip-hash-check", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dataset_root = args.dataset.resolve()
    model = args.model.resolve()
    if not dataset_root.is_dir():
        raise FileNotFoundError(f"Dataset not found: {dataset_root}")
    if not model.is_file():
        raise FileNotFoundError(f"Model not found: {model}")
    if not 0 <= args.target_far < 1:
        raise ValueError("--target-far must be in [0, 1)")

    identities = collect_dataset(dataset_root)
    invalid = {identity: len(paths) for identity, paths in identities.items() if len(paths) < 2}
    if len(identities) < 2:
        raise ValueError("At least two identity folders are required")
    if invalid:
        details = ", ".join(f"{identity}={count}" for identity, count in invalid.items())
        raise ValueError(f"Every identity needs at least two images: {details}")

    model_hash = sha256(model)
    if not args.skip_hash_check and model_hash != MODEL_SHA256:
        raise RuntimeError(f"Model SHA-256 mismatch: {model_hash}")

    load_started = time.perf_counter()
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    load_ms = (time.perf_counter() - load_started) * 1000
    input_name, output_name, contract = validate_contract(session)

    samples: list[tuple[str, Path, np.ndarray]] = []
    inference_ms: list[float] = []
    for identity, paths in identities.items():
        for path in paths:
            with Image.open(path) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGB")
            vector, elapsed_ms = embed(session, input_name, output_name, image)
            samples.append((identity, path, vector))
            inference_ms.append(elapsed_ms)

    positive: list[float] = []
    negative: list[float] = []
    for left_index, (left_identity, _, left_vector) in enumerate(samples):
        for right_identity, _, right_vector in samples[left_index + 1 :]:
            score = cosine(left_vector, right_vector)
            (positive if left_identity == right_identity else negative).append(score)
    if not positive or not negative:
        raise RuntimeError("Dataset does not contain both positive and negative pairs")

    report = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_warning": (
            "Results are valid only when photos span sessions, angles and lighting; "
            "duplicates or burst shots cause leakage."
        ),
        "dataset": {
            "root": str(dataset_root),
            "identity_count": len(identities),
            "image_count": len(samples),
            "images_per_identity": {identity: len(paths) for identity, paths in identities.items()},
            "positive_pair_count": len(positive),
            "negative_pair_count": len(negative),
        },
        "model": {
            "path": str(model),
            "size_bytes": model.stat().st_size,
            "sha256": model_hash,
            "contract": contract,
        },
        "runtime": {
            "onnxruntime_version": ort.__version__,
            "providers": session.get_providers(),
            "session_load_ms": round(load_ms, 3),
            "inference_ms": describe(inference_ms),
        },
        "verification": {
            "positive_scores": describe(positive),
            "negative_scores": describe(negative),
            **threshold_metrics(positive, negative, args.target_far),
        },
        "identification": identification_metrics(samples),
    }

    report_path = args.report.resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nReport written to: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
