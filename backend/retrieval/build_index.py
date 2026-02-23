from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

try:
    import faiss
except Exception as exc:  # noqa: BLE001
    raise RuntimeError(
        "faiss is required to build the vector index. "
        "Install dependencies with `pip install -r requirements.txt`."
    ) from exc


@dataclass
class BuildIndexArgs:
    embeddings_path: Path
    chunks_path: Path
    index_dir: Path
    normalize_vectors: bool
    metric: str


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_args() -> BuildIndexArgs:
    parser = argparse.ArgumentParser(description="Build a local vector index from embeddings JSONL.")
    parser.add_argument("--embeddings-path", default="data/embeddings/embeddings.jsonl")
    parser.add_argument("--chunks-path", default="data/chunks/chunks.jsonl")
    parser.add_argument("--index-dir", default="data/index")
    parser.add_argument(
        "--metric",
        choices=["cosine", "ip", "l2"],
        default="cosine",
        help="Similarity metric for FAISS index.",
    )
    parser.add_argument(
        "--no-normalize-vectors",
        action="store_true",
        help="Disable L2 normalization of vectors before saving.",
    )
    ns = parser.parse_args()
    return BuildIndexArgs(
        embeddings_path=Path(ns.embeddings_path),
        chunks_path=Path(ns.chunks_path),
        index_dir=Path(ns.index_dir),
        normalize_vectors=not bool(ns.no_normalize_vectors),
        metric=str(ns.metric),
    )


def _load_chunks(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
    if not path.exists():
        raise FileNotFoundError(f"chunks file not found: {path}")

    chunks_by_id: dict[str, dict[str, Any]] = {}
    stats = {
        "rows_valid_json": 0,
        "bad_lines": 0,
        "missing_required_fields": 0,
        "empty_text_skipped": 0,
        "duplicate_chunk_id_skipped": 0,
    }

    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s or not s.startswith("{"):
                stats["bad_lines"] += 1
                continue
            try:
                row = json.loads(s)
            except json.JSONDecodeError:
                stats["bad_lines"] += 1
                continue

            stats["rows_valid_json"] += 1
            chunk_id = row.get("chunk_id")
            text = row.get("text")
            if not isinstance(chunk_id, str) or not chunk_id or not isinstance(text, str):
                stats["missing_required_fields"] += 1
                continue
            if not text.strip():
                stats["empty_text_skipped"] += 1
                continue
            if chunk_id in chunks_by_id:
                stats["duplicate_chunk_id_skipped"] += 1
                continue

            chunks_by_id[chunk_id] = {
                "chunk_id": chunk_id,
                "doc_id": row.get("doc_id"),
                "relative_path": row.get("relative_path"),
                "source_path": row.get("source_path"),
                "page_start": row.get("page_start"),
                "page_end": row.get("page_end"),
                "page_numbers": row.get("page_numbers"),
                "article_hint": row.get("article_hint"),
                "heading_livre": row.get("heading_livre"),
                "heading_titre": row.get("heading_titre"),
                "heading_chapitre": row.get("heading_chapitre"),
                "heading_section": row.get("heading_section"),
                "token_count_est": row.get("token_count_est"),
                "text": text,
            }

    return chunks_by_id, stats


def _as_float32_vector(value: Any) -> np.ndarray | None:
    if not isinstance(value, list) or not value:
        return None
    try:
        vec = np.asarray(value, dtype=np.float32)
    except Exception:  # noqa: BLE001
        return None
    if vec.ndim != 1 or vec.size == 0:
        return None
    return vec


def _load_embeddings_with_metadata(
    embeddings_path: Path,
    chunks_by_id: dict[str, dict[str, Any]],
) -> tuple[np.ndarray, list[dict[str, Any]], dict[str, Any]]:
    if not embeddings_path.exists():
        raise FileNotFoundError(f"embeddings file not found: {embeddings_path}")

    stats: dict[str, Any] = {
        "rows_valid_json": 0,
        "bad_lines": 0,
        "missing_required_fields": 0,
        "invalid_vector_skipped": 0,
        "dimension_mismatch_skipped": 0,
        "duplicate_chunk_id_skipped": 0,
        "missing_chunk_text_skipped": 0,
        "rows_indexed": 0,
        "embedding_dim": 0,
        "embedding_models_detected": [],
        "embedding_providers_detected": [],
    }

    models: set[str] = set()
    providers: set[str] = set()
    seen_ids: set[str] = set()
    vectors: list[np.ndarray] = []
    meta_rows: list[dict[str, Any]] = []
    embedding_dim = 0

    with embeddings_path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s or not s.startswith("{"):
                stats["bad_lines"] += 1
                continue
            try:
                row = json.loads(s)
            except json.JSONDecodeError:
                stats["bad_lines"] += 1
                continue

            stats["rows_valid_json"] += 1
            chunk_id = row.get("chunk_id")
            vector = _as_float32_vector(row.get("embedding"))

            if not isinstance(chunk_id, str) or not chunk_id:
                stats["missing_required_fields"] += 1
                continue
            if vector is None:
                stats["invalid_vector_skipped"] += 1
                continue
            if embedding_dim == 0:
                embedding_dim = int(vector.size)
            elif int(vector.size) != embedding_dim:
                stats["dimension_mismatch_skipped"] += 1
                continue
            if chunk_id in seen_ids:
                stats["duplicate_chunk_id_skipped"] += 1
                continue

            chunk = chunks_by_id.get(chunk_id)
            if chunk is None:
                stats["missing_chunk_text_skipped"] += 1
                continue

            seen_ids.add(chunk_id)
            model = row.get("embedding_model")
            provider = row.get("embedding_provider")
            if isinstance(model, str) and model:
                models.add(model)
            if isinstance(provider, str) and provider:
                providers.add(provider)

            vectors.append(vector)
            meta_rows.append(
                {
                    "chunk_id": chunk_id,
                    "doc_id": row.get("doc_id") or chunk.get("doc_id"),
                    "relative_path": row.get("relative_path") or chunk.get("relative_path"),
                    "source_path": row.get("source_path") or chunk.get("source_path"),
                    "page_start": row.get("page_start")
                    if row.get("page_start") is not None
                    else chunk.get("page_start"),
                    "page_end": row.get("page_end")
                    if row.get("page_end") is not None
                    else chunk.get("page_end"),
                    "page_numbers": row.get("page_numbers") or chunk.get("page_numbers"),
                    "article_hint": row.get("article_hint") or chunk.get("article_hint"),
                    "heading_livre": chunk.get("heading_livre"),
                    "heading_titre": chunk.get("heading_titre"),
                    "heading_chapitre": chunk.get("heading_chapitre"),
                    "heading_section": chunk.get("heading_section"),
                    "token_count_est": chunk.get("token_count_est"),
                    "text": chunk.get("text", ""),
                }
            )

    if vectors:
        matrix = np.vstack(vectors).astype(np.float32, copy=False)
    else:
        matrix = np.zeros((0, embedding_dim), dtype=np.float32)

    stats["rows_indexed"] = int(matrix.shape[0])
    stats["embedding_dim"] = int(matrix.shape[1]) if matrix.ndim == 2 else 0
    stats["embedding_models_detected"] = sorted(models)
    stats["embedding_providers_detected"] = sorted(providers)
    return matrix, meta_rows, stats


def _normalize_rows(vectors: np.ndarray) -> np.ndarray:
    if vectors.size == 0:
        return vectors
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    return vectors / norms


def _build_faiss_index(vectors: np.ndarray, metric: str) -> tuple[Any, str]:
    if vectors.ndim != 2:
        raise RuntimeError("vectors must be a 2D matrix")
    dim = int(vectors.shape[1]) if vectors.shape[0] else 0
    if dim <= 0:
        raise RuntimeError("cannot build FAISS index with zero-dimension vectors")

    metric = metric.lower()
    if metric in {"cosine", "ip"}:
        index = faiss.IndexFlatIP(dim)
        metric_name = "IP"
    elif metric == "l2":
        index = faiss.IndexFlatL2(dim)
        metric_name = "L2"
    else:
        raise RuntimeError(f"unsupported metric: {metric}")

    index.add(vectors)
    return index, metric_name


def run(args: BuildIndexArgs) -> dict[str, Any]:
    started_at = utc_now_iso()
    chunks_by_id, chunk_stats = _load_chunks(args.chunks_path)
    vectors, meta_rows, embedding_stats = _load_embeddings_with_metadata(
        embeddings_path=args.embeddings_path,
        chunks_by_id=chunks_by_id,
    )

    should_normalize = bool(args.normalize_vectors or args.metric in {"cosine"})
    if should_normalize:
        vectors = _normalize_rows(vectors).astype(np.float32, copy=False)

    args.index_dir.mkdir(parents=True, exist_ok=True)
    index_path = args.index_dir / "index.faiss"
    meta_path = args.index_dir / "meta.jsonl"
    report_path = args.index_dir / "index_report.json"

    index, metric_name = _build_faiss_index(vectors, metric=args.metric)
    faiss.write_index(index, str(index_path))
    with meta_path.open("w", encoding="utf-8") as f:
        for row in meta_rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    report = {
        "started_at_utc": started_at,
        "finished_at_utc": utc_now_iso(),
        "config": {
            "embeddings_path": str(args.embeddings_path),
            "chunks_path": str(args.chunks_path),
            "index_dir": str(args.index_dir),
            "metric": args.metric,
            "normalize_vectors": should_normalize,
            "index_path": str(index_path),
            "meta_path": str(meta_path),
        },
        "stats": {
            "chunks": chunk_stats,
            "embeddings": embedding_stats,
            "index": {
                "faiss_index_type": type(index).__name__,
                "faiss_metric": metric_name,
                "index_ntotal": int(index.ntotal),
            },
        },
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main() -> None:
    args = parse_args()
    report = run(args)
    chunk_stats = report["stats"]["chunks"]
    emb_stats = report["stats"]["embeddings"]
    index_stats = report["stats"]["index"]
    print("[index] completed")
    print(f"index_dir={report['config']['index_dir']}")
    print(f"rows_indexed={emb_stats['rows_indexed']} embedding_dim={emb_stats['embedding_dim']}")
    print(
        "faiss_index="
        f"{index_stats['faiss_index_type']} metric={index_stats['faiss_metric']} "
        f"ntotal={index_stats['index_ntotal']}"
    )
    print(
        "chunks_unique_usable="
        f"{chunk_stats['rows_valid_json'] - chunk_stats['missing_required_fields'] - chunk_stats['empty_text_skipped'] - chunk_stats['duplicate_chunk_id_skipped']}"
    )
    print(
        "embedding_rows_valid_json="
        f"{emb_stats['rows_valid_json']} bad_lines={emb_stats['bad_lines']} "
        f"missing_chunk_text_skipped={emb_stats['missing_chunk_text_skipped']}"
    )
    print(f"index_file={Path(report['config']['index_path'])}")
    print(f"meta_file={Path(report['config']['meta_path'])}")
    print(f"report_file={Path(report['config']['index_dir']) / 'index_report.json'}")


if __name__ == "__main__":
    main()
