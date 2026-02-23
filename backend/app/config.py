from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    llm_provider: str
    llm_api_key: str
    llm_base_url: str
    llm_model: str
    allowed_origins: list[str]
    rag_enabled: bool
    rag_index_dir: str
    rag_top_k: int
    rag_max_context_chars: int
    rag_embedding_model: str
    rag_embedding_device: str | None
    rag_reranker_enabled: bool
    rag_reranker_model: str
    rag_reranker_device: str | None
    rag_reranker_batch_size: int
    rag_reranker_pool_size: int
    rag_domain_filter_enabled: bool
    rag_target_min_chunks: int
    rag_target_max_chunks: int
    rag_adaptive_threshold_enabled: bool
    rag_adaptive_threshold_floor: float
    rag_adaptive_threshold_step: float
    rag_min_source_citations: int
    rag_neutral_fallback_max: int
    rag_min_score_threshold: float
    rag_min_chunks_required: int
    rag_relevance_check_enabled: bool


def _parse_origins(value: str) -> list[str]:
    origins = [item.strip() for item in value.split(",") if item.strip()]
    return origins or ["http://localhost:3000"]


def _parse_bool(value: str, default: bool) -> bool:
    raw = value.strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return default


def _parse_int(value: str, default: int, *, minimum: int) -> int:
    raw = value.strip()
    if not raw:
        return default
    try:
        parsed = int(raw)
    except ValueError:
        return default
    return max(minimum, parsed)


def _parse_float(value: str, default: float, *, minimum: float) -> float:
    raw = value.strip()
    if not raw:
        return default
    try:
        parsed = float(raw)
    except ValueError:
        return default
    if parsed < minimum:
        return minimum
    return parsed


def _parse_optional_str(value: str) -> str | None:
    trimmed = value.strip()
    return trimmed or None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    llm_provider = os.getenv("LLM_PROVIDER", "nvidia").strip().lower() or "nvidia"
    if llm_provider not in {"nvidia", "ollama"}:
        raise RuntimeError(
            "LLM_PROVIDER must be 'nvidia' or 'ollama'."
        )

    if llm_provider == "ollama":
        api_key = os.getenv("OLLAMA_API_KEY", "ollama").strip() or "ollama"
        base_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1").strip()
        model = os.getenv("OLLAMA_MODEL", "deepseek-v3.1:671b-cloud").strip()
    else:
        api_key = os.getenv("NVIDIA_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError(
                "NVIDIA_API_KEY is missing. Add it to your .env before starting the backend."
            )
        base_url = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1").strip()
        model = os.getenv("NVIDIA_MODEL", "deepseek-ai/deepseek-v3.2").strip()

    if not model:
        raise RuntimeError("Missing model name in .env.")

    origins = _parse_origins(os.getenv("ALLOWED_ORIGINS", "http://localhost:3000"))
    rag_enabled = _parse_bool(os.getenv("RAG_ENABLED", "true"), default=True)
    rag_index_dir = os.getenv("RAG_INDEX_DIR", "data/index").strip() or "data/index"
    rag_top_k = _parse_int(os.getenv("RAG_TOP_K", "5"), default=5, minimum=1)
    rag_max_context_chars = _parse_int(
        os.getenv("RAG_MAX_CONTEXT_CHARS", "12000"),
        default=12000,
        minimum=500,
    )
    rag_embedding_model = (
        os.getenv("RAG_EMBEDDING_MODEL", "Snowflake/snowflake-arctic-embed-l-v2.0").strip()
        or "Snowflake/snowflake-arctic-embed-l-v2.0"
    )
    rag_embedding_device = _parse_optional_str(os.getenv("RAG_EMBEDDING_DEVICE", ""))
    rag_reranker_enabled = _parse_bool(
        os.getenv("RAG_RERANKER_ENABLED", "false"),
        default=False,
    )
    rag_reranker_model = (
        os.getenv("RAG_RERANKER_MODEL", "BAAI/bge-reranker-v2-m3").strip()
        or "BAAI/bge-reranker-v2-m3"
    )
    rag_reranker_device = _parse_optional_str(os.getenv("RAG_RERANKER_DEVICE", ""))
    rag_reranker_batch_size = _parse_int(
        os.getenv("RAG_RERANKER_BATCH_SIZE", "16"),
        default=16,
        minimum=1,
    )
    rag_reranker_pool_size = _parse_int(
        os.getenv("RAG_RERANKER_POOL_SIZE", "50"),
        default=50,
        minimum=1,
    )
    rag_domain_filter_enabled = _parse_bool(
        os.getenv("RAG_DOMAIN_FILTER_ENABLED", "true"),
        default=True,
    )
    rag_target_min_chunks = _parse_int(
        os.getenv("RAG_TARGET_MIN_CHUNKS", "8"),
        default=8,
        minimum=1,
    )
    rag_target_max_chunks = _parse_int(
        os.getenv("RAG_TARGET_MAX_CHUNKS", "10"),
        default=10,
        minimum=1,
    )
    if rag_target_max_chunks < rag_target_min_chunks:
        rag_target_max_chunks = rag_target_min_chunks
    rag_adaptive_threshold_enabled = _parse_bool(
        os.getenv("RAG_ADAPTIVE_THRESHOLD_ENABLED", "true"),
        default=True,
    )
    rag_adaptive_threshold_floor = _parse_float(
        os.getenv("RAG_ADAPTIVE_THRESHOLD_FLOOR", "0.22"),
        default=0.22,
        minimum=0.0,
    )
    rag_adaptive_threshold_step = _parse_float(
        os.getenv("RAG_ADAPTIVE_THRESHOLD_STEP", "0.03"),
        default=0.03,
        minimum=0.001,
    )
    rag_min_source_citations = _parse_int(
        os.getenv("RAG_MIN_SOURCE_CITATIONS", "3"),
        default=3,
        minimum=1,
    )
    rag_neutral_fallback_max = _parse_int(
        os.getenv("RAG_NEUTRAL_FALLBACK_MAX", "2"),
        default=2,
        minimum=0,
    )
    rag_min_score_threshold = _parse_float(
        os.getenv("RAG_MIN_SCORE_THRESHOLD", "0.35"),
        default=0.35,
        minimum=0.0,
    )
    rag_min_chunks_required = _parse_int(
        os.getenv("RAG_MIN_CHUNKS_REQUIRED", "2"),
        default=2,
        minimum=1,
    )
    rag_relevance_check_enabled = _parse_bool(
        os.getenv("RAG_RELEVANCE_CHECK_ENABLED", "true"),
        default=True,
    )

    return Settings(
        llm_provider=llm_provider,
        llm_api_key=api_key,
        llm_base_url=base_url,
        llm_model=model,
        allowed_origins=origins,
        rag_enabled=rag_enabled,
        rag_index_dir=rag_index_dir,
        rag_top_k=rag_top_k,
        rag_max_context_chars=rag_max_context_chars,
        rag_embedding_model=rag_embedding_model,
        rag_embedding_device=rag_embedding_device,
        rag_reranker_enabled=rag_reranker_enabled,
        rag_reranker_model=rag_reranker_model,
        rag_reranker_device=rag_reranker_device,
        rag_reranker_batch_size=rag_reranker_batch_size,
        rag_reranker_pool_size=rag_reranker_pool_size,
        rag_domain_filter_enabled=rag_domain_filter_enabled,
        rag_target_min_chunks=rag_target_min_chunks,
        rag_target_max_chunks=rag_target_max_chunks,
        rag_adaptive_threshold_enabled=rag_adaptive_threshold_enabled,
        rag_adaptive_threshold_floor=rag_adaptive_threshold_floor,
        rag_adaptive_threshold_step=rag_adaptive_threshold_step,
        rag_min_source_citations=rag_min_source_citations,
        rag_neutral_fallback_max=rag_neutral_fallback_max,
        rag_min_score_threshold=rag_min_score_threshold,
        rag_min_chunks_required=rag_min_chunks_required,
        rag_relevance_check_enabled=rag_relevance_check_enabled,
    )
