"""Pet re-identification desktop POC.

The script deliberately stays outside the application runtime. It validates the
ONNX contract, preprocessing, embedding stability and CPU latency before an
Android integration is attempted.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import statistics
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageEnhance, ImageOps


MODEL_SHA256 = "6a5e2373ab348bed588cef4072f3914ca9c8bacde3e8d0651019e8dad86b24ba"
IMAGE_SIZE = 224
IMAGENET_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)


@dataclass(frozen=True)
class Variant:
    name: str
    transform: Callable[[Image.Image], Image.Image]


VARIANTS = (
    Variant("original", lambda image: image.copy()),
    Variant("mirror", ImageOps.mirror),
    Variant("brightness_085", lambda image: ImageEnhance.Brightness(image).enhance(0.85)),
    Variant("brightness_115", lambda image: ImageEnhance.Brightness(image).enhance(1.15)),
    Variant("center_crop_90", lambda image: _center_crop(image, 0.90)),
    Variant("jpeg_q55", lambda image: _jpeg_roundtrip(image, 55)),
)


def _center_crop(image: Image.Image, ratio: float) -> Image.Image:
    width, height = image.size
    crop_width = max(1, round(width * ratio))
    crop_height = max(1, round(height * ratio))
    left = (width - crop_width) // 2
    top = (height - crop_height) // 2
    return image.crop((left, top, left + crop_width, top + crop_height))


def _jpeg_roundtrip(image: Image.Image, quality: int) -> Image.Image:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    buffer.seek(0)
    with Image.open(buffer) as reopened:
        return reopened.convert("RGB")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def preprocess(image: Image.Image) -> np.ndarray:
    image = ImageOps.exif_transpose(image).convert("RGB")
    image = ImageOps.fit(
        image,
        (IMAGE_SIZE, IMAGE_SIZE),
        method=Image.Resampling.BICUBIC,
        centering=(0.5, 0.5),
    )
    array = np.asarray(image, dtype=np.float32) / 255.0
    array = (array - IMAGENET_MEAN) / IMAGENET_STD
    return np.transpose(array, (2, 0, 1))[None, ...].astype(np.float32)


def cosine(left: np.ndarray, right: np.ndarray) -> float:
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denominator == 0:
        raise ValueError("Cannot compare a zero-length embedding")
    return float(np.dot(left, right) / denominator)


def describe(values: list[float]) -> dict[str, float]:
    if not values:
        return {}
    return {
        "min": round(min(values), 6),
        "max": round(max(values), 6),
        "mean": round(statistics.fmean(values), 6),
        "median": round(statistics.median(values), 6),
    }


def validate_contract(session: ort.InferenceSession) -> tuple[str, str, dict[str, object]]:
    model_inputs = session.get_inputs()
    model_outputs = session.get_outputs()
    if len(model_inputs) != 1 or len(model_outputs) != 1:
        raise RuntimeError("Expected exactly one model input and one model output")
    input_meta = model_inputs[0]
    output_meta = model_outputs[0]
    if input_meta.name != "input" or output_meta.name != "embedding":
        raise RuntimeError(
            f"Unexpected I/O names: {input_meta.name!r} -> {output_meta.name!r}"
        )
    contract = {
        "input": {"name": input_meta.name, "shape": input_meta.shape, "type": input_meta.type},
        "output": {"name": output_meta.name, "shape": output_meta.shape, "type": output_meta.type},
    }
    return input_meta.name, output_meta.name, contract


def embed(
    session: ort.InferenceSession,
    input_name: str,
    output_name: str,
    image: Image.Image,
) -> tuple[np.ndarray, float]:
    tensor = preprocess(image)
    started = time.perf_counter()
    result = session.run([output_name], {input_name: tensor})[0]
    elapsed_ms = (time.perf_counter() - started) * 1000
    vector = np.asarray(result[0], dtype=np.float32)
    if vector.shape != (512,):
        raise RuntimeError(f"Expected a 512D embedding, got {vector.shape}")
    return vector, elapsed_ms


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images", nargs="+", type=Path, help="One or more cat images")
    parser.add_argument(
        "--model",
        type=Path,
        default=root / "tools/pet_reid/models/pet-recognition-small.onnx",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=root / "tools/pet_reid/reports/latest.json",
    )
    parser.add_argument("--benchmark-runs", type=int, default=5)
    parser.add_argument("--skip-hash-check", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    model = args.model.resolve()
    image_paths = [path.resolve() for path in args.images]
    if not model.is_file():
        raise FileNotFoundError(f"Model not found: {model}")
    missing = [str(path) for path in image_paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Images not found: {', '.join(missing)}")
    if args.benchmark_runs < 1:
        raise ValueError("--benchmark-runs must be at least 1")

    model_hash = sha256(model)
    if not args.skip_hash_check and model_hash != MODEL_SHA256:
        raise RuntimeError(f"Model SHA-256 mismatch: {model_hash}")

    session_started = time.perf_counter()
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    session_load_ms = (time.perf_counter() - session_started) * 1000
    input_name, output_name, contract = validate_contract(session)

    embeddings: dict[str, dict[str, np.ndarray]] = {}
    timings: list[float] = []
    image_metadata: list[dict[str, object]] = []

    for path in image_paths:
        with Image.open(path) as opened:
            source = ImageOps.exif_transpose(opened).convert("RGB")
        image_metadata.append(
            {
                "path": str(path),
                "sha256": sha256(path),
                "width": source.width,
                "height": source.height,
            }
        )
        per_variant: dict[str, np.ndarray] = {}
        for variant in VARIANTS:
            vector, elapsed_ms = embed(
                session, input_name, output_name, variant.transform(source)
            )
            per_variant[variant.name] = vector
            timings.append(elapsed_ms)
        embeddings[str(path)] = per_variant

    # Warm model memory and measure original input repeatedly for a less noisy latency sample.
    benchmark_image_path = image_paths[0]
    with Image.open(benchmark_image_path) as opened:
        benchmark_image = ImageOps.exif_transpose(opened).convert("RGB")
    embed(session, input_name, output_name, benchmark_image)
    benchmark_timings = [
        embed(session, input_name, output_name, benchmark_image)[1]
        for _ in range(args.benchmark_runs)
    ]

    stability: dict[str, dict[str, object]] = {}
    positive_scores: list[float] = []
    for path, variants in embeddings.items():
        original = variants["original"]
        scores = {
            name: round(cosine(original, vector), 6)
            for name, vector in variants.items()
            if name != "original"
        }
        positive_scores.extend(scores.values())
        stability[path] = {
            "embedding_norm": round(float(np.linalg.norm(original)), 6),
            "similarity_to_original": scores,
            "summary": describe(list(scores.values())),
        }

    cross_image: list[dict[str, object]] = []
    negative_scores: list[float] = []
    for left_index, left_path in enumerate(image_paths):
        for right_path in image_paths[left_index + 1 :]:
            pair_scores = [
                cosine(left_vector, right_vector)
                for left_vector in embeddings[str(left_path)].values()
                for right_vector in embeddings[str(right_path)].values()
            ]
            negative_scores.extend(pair_scores)
            cross_image.append(
                {
                    "left": str(left_path),
                    "right": str(right_path),
                    "original_similarity": round(
                        cosine(
                            embeddings[str(left_path)]["original"],
                            embeddings[str(right_path)]["original"],
                        ),
                        6,
                    ),
                    "all_variant_pairs": describe(pair_scores),
                }
            )

    positive_min = min(positive_scores) if positive_scores else None
    negative_max = max(negative_scores) if negative_scores else None
    separable = (
        positive_min is not None
        and negative_max is not None
        and positive_min > negative_max
    )
    demo_threshold = (
        round((positive_min + negative_max) / 2, 6) if separable else None
    )

    report = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scope_warning": (
            "Synthetic variants validate the pipeline, not real cross-session identity accuracy. "
            "Do not use the demo threshold in production."
        ),
        "runtime": {
            "onnxruntime_version": ort.__version__,
            "providers": session.get_providers(),
            "session_load_ms": round(session_load_ms, 3),
            "all_inference_ms": describe(timings),
            "warm_benchmark_ms": describe(benchmark_timings),
        },
        "model": {
            "path": str(model),
            "size_bytes": model.stat().st_size,
            "sha256": model_hash,
            "contract": contract,
        },
        "images": image_metadata,
        "stability": stability,
        "cross_image_comparison": cross_image,
        "sample_separation": {
            "synthetic_positive_scores": describe(positive_scores),
            "cross_image_negative_scores": describe(negative_scores),
            "positive_min_above_negative_max": separable,
            "margin": (
                round(positive_min - negative_max, 6)
                if positive_min is not None and negative_max is not None
                else None
            ),
            "suggested_demo_threshold": demo_threshold,
        },
    }

    report_path = args.report.resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nReport written to: {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
