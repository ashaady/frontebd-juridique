from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm


TOKEN_LIMIT_ERROR_RE = re.compile(
    r"Input length\s+\d+\s+exceeds maximum allowed token size\s+(\d+)",
    re.IGNORECASE,
)


@dataclass
class EmbeddingArgs:
    provider: str
    chunks_path: Path
    output_path: Path
    report_path: Path
    model: str
    batch_size: int
    max_retries: int
    retry_base_seconds: float
    timeout_seconds: float
    input_type: str
    truncate_chars: int
    max_input_tokens: int
    local_device: str | None
    normalize_embeddings: bool
    limit_chunks: int | None
    resume: bool


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_args() -> EmbeddingArgs:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Generate embeddings from chunks JSONL.")
    parser.add_argument(
        "--provider",
        choices=["nvidia", "sentence-transformers"],
        default=(os.getenv("EMBEDDING_PROVIDER", "").strip() or ""),
        help="Embedding provider. If omitted, inferred from model name.",
    )
    parser.add_argument("--chunks-path", default="data/chunks/chunks.jsonl")
    parser.add_argument("--output-path", default="data/embeddings/embeddings.jsonl")
    parser.add_argument("--report-path", default="data/embeddings/embedding_report.json")
    parser.add_argument(
        "--model",
        default=(
            os.getenv("NVIDIA_EMBEDDING_MODEL", "").strip()
            or os.getenv("EMBEDDING_MODEL", "").strip()
        ),
        help="Embedding model name (or set NVIDIA_EMBEDDING_MODEL / EMBEDDING_MODEL).",
    )
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--retry-base-seconds", type=float, default=1.0)
    parser.add_argument("--timeout-seconds", type=float, default=120.0)
    parser.add_argument(
        "--input-type",
        default="passage",
        choices=["passage", "query"],
        help="Embedding input type for asymmetric embedding models.",
    )
    parser.add_argument("--truncate-chars", type=int, default=20000)
    parser.add_argument(
        "--max-input-tokens",
        type=int,
        default=4096,
        help="Approximate max tokens per embedding input (len(text)/4 heuristic).",
    )
    parser.add_argument(
        "--local-device",
        default=None,
        help="Sentence-transformers device override (cpu, cuda, mps).",
    )
    parser.add_argument(
        "--no-normalize-embeddings",
        action="store_true",
        help="Disable L2 normalization for sentence-transformers embeddings.",
    )
    parser.add_argument("--limit-chunks", type=int, default=None)
    parser.add_argument("--no-resume", action="store_true")

    ns = parser.parse_args()
    model = (ns.model or "").strip()
    if not model:
        raise RuntimeError(
            "Missing embedding model. Pass --model or set NVIDIA_EMBEDDING_MODEL in your environment."
        )

    provider = (ns.provider or "").strip().lower()
    if not provider:
        if model.startswith("Snowflake/") or model.startswith("sentence-transformers/"):
            provider = "sentence-transformers"
        else:
            provider = "nvidia"

    return EmbeddingArgs(
        provider=provider,
        chunks_path=Path(ns.chunks_path),
        output_path=Path(ns.output_path),
        report_path=Path(ns.report_path),
        model=model,
        batch_size=max(1, int(ns.batch_size)),
        max_retries=max(0, int(ns.max_retries)),
        retry_base_seconds=max(0.1, float(ns.retry_base_seconds)),
        timeout_seconds=max(1.0, float(ns.timeout_seconds)),
        input_type=str(ns.input_type),
        truncate_chars=max(100, int(ns.truncate_chars)),
        max_input_tokens=max(1, int(ns.max_input_tokens)),
        local_device=(str(ns.local_device).strip() or None) if ns.local_device else None,
        normalize_embeddings=not bool(ns.no_normalize_embeddings),
        limit_chunks=ns.limit_chunks if ns.limit_chunks is None else max(1, int(ns.limit_chunks)),
        resume=not bool(ns.no_resume),
    )


def build_nvidia_client(timeout_seconds: float) -> OpenAI:
    api_key = os.getenv("NVIDIA_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY is missing. Add it to your .env before embedding.")
    base_url = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1").strip()
    return OpenAI(base_url=base_url, api_key=api_key, timeout=timeout_seconds)


def build_sentence_transformer(model_name: str, device: str | None) -> Any:
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "sentence-transformers is not installed. Install it with `pip install sentence-transformers`."
        ) from exc
    kwargs: dict[str, Any] = {}
    if device:
        kwargs["device"] = device
    return SentenceTransformer(model_name, **kwargs)


def load_existing_embedded_ids(path: Path) -> set[str]:
    ids: set[str] = set()
    if not path.exists():
        return ids
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s or not s.startswith("{"):
                continue
            try:
                row = json.loads(s)
            except json.JSONDecodeError:
                continue
            chunk_id = row.get("chunk_id")
            if isinstance(chunk_id, str) and chunk_id:
                ids.add(chunk_id)
    return ids


def load_chunks(path: Path) -> tuple[list[dict[str, Any]], int]:
    if not path.exists():
        raise FileNotFoundError(f"chunks file not found: {path}")

    rows: list[dict[str, Any]] = []
    bad_lines = 0
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s or not s.startswith("{"):
                bad_lines += 1
                continue
            try:
                row = json.loads(s)
            except json.JSONDecodeError:
                bad_lines += 1
                continue
            rows.append(row)
    return rows, bad_lines


def chunk_batches(items: list[dict[str, Any]], batch_size: int) -> list[list[dict[str, Any]]]:
    return [items[i : i + batch_size] for i in range(0, len(items), batch_size)]


def clamp_input_text(text: str, truncate_chars: int, max_input_tokens: int) -> tuple[str, bool]:
    # Rough token estimate used elsewhere in the project.
    char_cap_from_tokens = max_input_tokens * 4
    hard_cap = min(truncate_chars, char_cap_from_tokens)
    if len(text) <= hard_cap:
        return text, False
    return text[:hard_cap], True


def embed_batch_with_retry(
    client: OpenAI,
    model: str,
    texts: list[str],
    input_type: str,
    max_retries: int,
    retry_base_seconds: float,
) -> tuple[list[list[float]], list[str]]:
    current_texts = list(texts)
    include_input_type = True
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            if include_input_type:
                response = client.embeddings.create(
                    model=model,
                    input=current_texts,
                    extra_body={"input_type": input_type},
                )
            else:
                response = client.embeddings.create(model=model, input=current_texts)
            vectors = [item.embedding for item in response.data]
            if len(vectors) != len(current_texts):
                raise RuntimeError(
                    "embedding response size mismatch: "
                    f"got={len(vectors)} expected={len(current_texts)}"
                )
            return vectors, current_texts
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            message = str(exc)
            lowered = message.lower()
            if "input_type" in lowered and ("unknown" in lowered or "unexpected" in lowered):
                include_input_type = False
                continue
            match = TOKEN_LIMIT_ERROR_RE.search(message)
            if match:
                max_tokens = max(1, int(match.group(1)))
                # Conservative fallback: ~2 chars/token to avoid repeated 400s.
                safe_char_cap = max(200, max_tokens * 2)
                shrunk = [t[:safe_char_cap] for t in current_texts]
                if shrunk != current_texts:
                    current_texts = shrunk
                    continue
            if attempt >= max_retries:
                break
            sleep_s = retry_base_seconds * (2**attempt)
            time.sleep(sleep_s)
    if last_exc is None:
        raise RuntimeError("embedding request failed with unknown error")
    raise last_exc


def embed_batch_sentence_transformers(
    st_model: Any,
    texts: list[str],
    normalize_embeddings: bool,
) -> tuple[list[list[float]], list[str]]:
    vectors = st_model.encode(
        texts,
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=normalize_embeddings,
    )
    vectors_list = [vec.tolist() for vec in vectors]
    if len(vectors_list) != len(texts):
        raise RuntimeError(
            f"embedding response size mismatch: got={len(vectors_list)} expected={len(texts)}"
        )
    return vectors_list, texts


def run(args: EmbeddingArgs) -> dict[str, Any]:
    started_at = utc_now_iso()
    args.output_path.parent.mkdir(parents=True, exist_ok=True)
    args.report_path.parent.mkdir(parents=True, exist_ok=True)

    nvidia_client: OpenAI | None = None
    st_model: Any | None = None
    if args.provider == "nvidia":
        nvidia_client = build_nvidia_client(timeout_seconds=args.timeout_seconds)
    elif args.provider == "sentence-transformers":
        st_model = build_sentence_transformer(args.model, device=args.local_device)
    else:
        raise RuntimeError(f"Unsupported provider: {args.provider}")

    chunk_rows, bad_chunk_lines = load_chunks(args.chunks_path)

    existing_ids = load_existing_embedded_ids(args.output_path) if args.resume else set()
    seen_chunk_ids: set[str] = set()
    queue: list[dict[str, Any]] = []

    stats = {
        "chunks_total_input": len(chunk_rows),
        "bad_chunk_lines": bad_chunk_lines,
        "missing_required_fields": 0,
        "empty_text_skipped": 0,
        "duplicate_chunk_id_skipped": 0,
        "already_embedded_skipped": 0,
        "truncated_inputs": 0,
        "auto_token_shrinks": 0,
        "batches_total": 0,
        "batches_failed": 0,
        "embedded_new": 0,
        "embedded_total_after_run": 0,
        "embedding_dim": 0,
    }

    for row in chunk_rows:
        chunk_id = row.get("chunk_id")
        text = row.get("text")
        if not isinstance(chunk_id, str) or not chunk_id or not isinstance(text, str):
            stats["missing_required_fields"] += 1
            continue
        if not text.strip():
            stats["empty_text_skipped"] += 1
            continue
        if chunk_id in seen_chunk_ids:
            stats["duplicate_chunk_id_skipped"] += 1
            continue
        seen_chunk_ids.add(chunk_id)
        if chunk_id in existing_ids:
            stats["already_embedded_skipped"] += 1
            continue
        queue.append(row)

    if args.limit_chunks is not None:
        queue = queue[: args.limit_chunks]

    mode = "a" if args.resume and args.output_path.exists() else "w"
    batches = chunk_batches(queue, args.batch_size)
    stats["batches_total"] = len(batches)

    with args.output_path.open(mode, encoding="utf-8") as out_f:
        for batch in tqdm(batches, desc="Embedding", unit="batch"):
            prepared_texts: list[str] = []
            for row in batch:
                text = row["text"]
                text, _ = clamp_input_text(
                    text=text,
                    truncate_chars=args.truncate_chars,
                    max_input_tokens=args.max_input_tokens,
                )
                prepared_texts.append(text)

            try:
                if args.provider == "nvidia":
                    vectors, used_texts = embed_batch_with_retry(
                        client=nvidia_client,  # type: ignore[arg-type]
                        model=args.model,
                        texts=prepared_texts,
                        input_type=args.input_type,
                        max_retries=args.max_retries,
                        retry_base_seconds=args.retry_base_seconds,
                    )
                else:
                    vectors, used_texts = embed_batch_sentence_transformers(
                        st_model=st_model,
                        texts=prepared_texts,
                        normalize_embeddings=args.normalize_embeddings,
                    )
            except Exception:  # noqa: BLE001
                stats["batches_failed"] += 1
                raise

            for row, prepared_text, input_text, vector in zip(
                batch,
                prepared_texts,
                used_texts,
                vectors,
                strict=True,
            ):
                if len(row["text"]) > len(prepared_text):
                    stats["truncated_inputs"] += 1
                if len(prepared_text) > len(input_text):
                    stats["auto_token_shrinks"] += 1
                if stats["embedding_dim"] == 0:
                    stats["embedding_dim"] = len(vector)
                payload = {
                    "chunk_id": row["chunk_id"],
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
                    "text_sha1": hashlib.sha1(input_text.encode("utf-8", errors="ignore")).hexdigest(),
                    "text_char_count_used": len(input_text),
                    "embedding_model": args.model,
                    "embedding_provider": args.provider,
                    "embedding_dim": len(vector),
                    "embedding": vector,
                }
                out_f.write(json.dumps(payload, ensure_ascii=False) + "\n")
                stats["embedded_new"] += 1

    stats["embedded_total_after_run"] = (
        len(existing_ids) + stats["embedded_new"] if args.resume else stats["embedded_new"]
    )

    report = {
        "started_at_utc": started_at,
        "finished_at_utc": utc_now_iso(),
        "config": {
            "provider": args.provider,
            "chunks_path": str(args.chunks_path),
            "output_path": str(args.output_path),
            "report_path": str(args.report_path),
            "model": args.model,
            "batch_size": args.batch_size,
            "max_retries": args.max_retries,
            "retry_base_seconds": args.retry_base_seconds,
            "timeout_seconds": args.timeout_seconds,
            "input_type": args.input_type,
            "truncate_chars": args.truncate_chars,
            "max_input_tokens": args.max_input_tokens,
            "local_device": args.local_device,
            "normalize_embeddings": args.normalize_embeddings,
            "limit_chunks": args.limit_chunks,
            "resume": args.resume,
        },
        "stats": stats,
    }

    args.report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main() -> None:
    args = parse_args()
    report = run(args)
    stats = report["stats"]
    print("[embeddings] completed")
    print(f"provider={args.provider} model={args.model}")
    print(
        "chunks_total_input="
        f"{stats['chunks_total_input']} embedded_new={stats['embedded_new']} "
        f"already_embedded_skipped={stats['already_embedded_skipped']}"
    )
    print(
        "missing_required_fields="
        f"{stats['missing_required_fields']} empty_text_skipped={stats['empty_text_skipped']} "
        f"duplicate_chunk_id_skipped={stats['duplicate_chunk_id_skipped']}"
    )
    print(
        "batches_total="
        f"{stats['batches_total']} batches_failed={stats['batches_failed']} "
        f"truncated_inputs={stats['truncated_inputs']}"
    )
    print(f"embedding_dim={stats['embedding_dim']}")
    print(f"embeddings_file={args.output_path}")
    print(f"report_file={args.report_path}")


if __name__ == "__main__":
    main()
