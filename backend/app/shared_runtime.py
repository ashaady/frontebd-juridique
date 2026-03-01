from __future__ import annotations

import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from openai import AsyncOpenAI

from .config import get_settings
from .workspace_rag import WorkspaceRagIndex

settings = get_settings()
client = AsyncOpenAI(
    base_url=settings.llm_base_url,
    api_key=settings.llm_api_key,
)


@lru_cache(maxsize=1)
def get_retriever() -> Any:
    try:
        from backend.retrieval import FaissRetriever
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Retrieval backend unavailable: {type(exc).__name__}: {exc}") from exc

    return FaissRetriever(
        index_dir=Path(settings.rag_index_dir),
        model_name=settings.rag_embedding_model,
        device=settings.rag_embedding_device,
        normalize_query_embeddings=True,
        reranker_model_name=settings.rag_reranker_model if settings.rag_reranker_enabled else None,
        reranker_device=settings.rag_reranker_device,
        reranker_batch_size=settings.rag_reranker_batch_size,
        reranker_cpu_max_candidates=settings.rag_reranker_cpu_max_candidates,
        reranker_snippet_chars=settings.rag_reranker_snippet_chars,
        reranker_cpu_snippet_chars=settings.rag_reranker_cpu_snippet_chars,
    )


@lru_cache(maxsize=1)
def get_workspace_rag_index() -> WorkspaceRagIndex:
    return WorkspaceRagIndex(
        model_name=settings.rag_embedding_model,
        device=settings.rag_embedding_device,
    )


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_upload_name(filename: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", filename).strip("._")
    if not cleaned:
        cleaned = "document"
    return cleaned[:180]
