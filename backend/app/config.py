from __future__ import annotations

import os
import warnings
from dataclasses import dataclass
from functools import lru_cache

from dotenv import load_dotenv

from .paths import resolve_from_project_root

load_dotenv()


@dataclass(frozen=True)
class Settings:
    app_env: str
    llm_provider: str
    llm_api_key: str
    llm_base_url: str
    llm_model: str
    allowed_origins: list[str]
    allowed_origin_regex: str | None
    trusted_hosts: list[str]
    api_docs_enabled: bool
    request_max_body_mb: int
    gzip_enabled: bool
    gzip_min_size: int
    rate_limit_enabled: bool
    rate_limit_requests_per_minute: int
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
    rag_query_rewrite_enabled: bool
    rag_query_rewrite_model: str | None
    rag_query_rewrite_max_tokens: int
    rag_query_rewrite_temperature: float
    rag_query_rewrite_timeout_sec: float
    rag_query_rewrite_skip_tokens: int
    rag_reranker_cpu_max_candidates: int
    rag_reranker_snippet_chars: int
    rag_reranker_cpu_snippet_chars: int
    rag_preload_on_startup: bool
    rag_preload_blocking: bool
    speech_enabled: bool
    whisper_model_size: str
    whisper_device: str
    whisper_compute_type: str
    whisper_language: str | None
    whisper_beam_size: int
    whisper_vad_filter: bool


def _parse_origins(value: str) -> list[str]:
    origins = [item.strip() for item in value.split(",") if item.strip()]
    return origins or ["http://localhost:3000"]


def _parse_csv(value: str) -> list[str]:
    items = [item.strip() for item in value.split(",") if item.strip()]
    # Preserve order while removing duplicates.
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        lowered = item.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        result.append(item)
    return result


def _merge_required_hosts(hosts: list[str], required: list[str]) -> list[str]:
    seen = {item.lower() for item in hosts}
    merged = list(hosts)
    for item in required:
        lowered = item.lower()
        if lowered in seen:
            continue
        merged.append(item)
        seen.add(lowered)
    return merged


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
    app_env = os.getenv("APP_ENV", "development").strip().lower() or "development"
    if app_env not in {"development", "staging", "production"}:
        raise RuntimeError("APP_ENV must be one of: development, staging, production.")

    llm_provider = os.getenv("LLM_PROVIDER", "nvidia").strip().lower() or "nvidia"
    if llm_provider not in {"nvidia", "ollama", "deepseek"}:
        raise RuntimeError("LLM_PROVIDER must be 'nvidia', 'ollama' or 'deepseek'.")

    if llm_provider == "ollama":
        api_key = os.getenv("OLLAMA_API_KEY", "ollama").strip() or "ollama"
        base_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1").strip()
        model = os.getenv("OLLAMA_MODEL", "deepseek-v3.1:671b-cloud").strip()
    elif llm_provider == "deepseek":
        api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
        if not api_key:
            warnings.warn(
                "DEEPSEEK_API_KEY is missing. Backend will start for healthchecks, "
                "but DeepSeek chat calls will fail until the key is configured.",
                RuntimeWarning,
                stacklevel=2,
            )
            api_key = "missing_deepseek_api_key"
        base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").strip()
        model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat").strip()
    else:
        api_key = os.getenv("NVIDIA_API_KEY", "").strip()
        if not api_key:
            warnings.warn(
                "NVIDIA_API_KEY is missing. Backend will start for healthchecks, "
                "but NVIDIA chat calls will fail until the key is configured.",
                RuntimeWarning,
                stacklevel=2,
            )
            api_key = "missing_nvidia_api_key"
        base_url = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1").strip()
        model = os.getenv("NVIDIA_MODEL", "deepseek-ai/deepseek-v3.2").strip()

    if not model:
        raise RuntimeError("Missing model name in .env.")

    default_allowed_origins = (
        "http://localhost:3000,"
        "http://127.0.0.1:3000,"
        "http://localhost:7410,"
        "http://127.0.0.1:7410"
    )
    origins = _parse_origins(os.getenv("ALLOWED_ORIGINS", default_allowed_origins))
    allowed_origin_regex = _parse_optional_str(os.getenv("ALLOWED_ORIGIN_REGEX", ""))
    if not allowed_origin_regex and app_env != "production":
        allowed_origin_regex = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
    trusted_hosts = _parse_csv(
        os.getenv(
            "TRUSTED_HOSTS",
            "localhost,127.0.0.1,testserver,*.railway.app,*.railway.internal",
        )
    )
    if not trusted_hosts:
        trusted_hosts = ["localhost", "127.0.0.1"]
    trusted_hosts = _merge_required_hosts(
        trusted_hosts,
        [
            "localhost",
            "127.0.0.1",
            "testserver",
            "healthcheck.railway.app",
            "*.railway.app",
            "*.railway.internal",
        ],
    )
    api_docs_enabled = _parse_bool(
        os.getenv("API_DOCS_ENABLED", "false" if app_env == "production" else "true"),
        default=(app_env != "production"),
    )
    request_max_body_mb = _parse_int(
        os.getenv("REQUEST_MAX_BODY_MB", "25"),
        default=25,
        minimum=1,
    )
    gzip_enabled = _parse_bool(
        os.getenv("GZIP_ENABLED", "true"),
        default=True,
    )
    gzip_min_size = _parse_int(
        os.getenv("GZIP_MIN_SIZE", "500"),
        default=500,
        minimum=128,
    )
    rate_limit_enabled = _parse_bool(
        os.getenv("RATE_LIMIT_ENABLED", "true" if app_env == "production" else "false"),
        default=(app_env == "production"),
    )
    rate_limit_requests_per_minute = _parse_int(
        os.getenv("RATE_LIMIT_REQUESTS_PER_MINUTE", "120"),
        default=120,
        minimum=10,
    )
    rag_enabled = _parse_bool(os.getenv("RAG_ENABLED", "true"), default=True)
    rag_index_dir = str(
        resolve_from_project_root(
            os.getenv("RAG_INDEX_DIR", "data/index"),
            default_relative="data/index",
        )
    )
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
    rag_query_rewrite_enabled = _parse_bool(
        os.getenv("RAG_QUERY_REWRITE_ENABLED", "true"),
        default=True,
    )
    rag_query_rewrite_model = _parse_optional_str(os.getenv("RAG_QUERY_REWRITE_MODEL", ""))
    rag_query_rewrite_max_tokens = _parse_int(
        os.getenv("RAG_QUERY_REWRITE_MAX_TOKENS", "96"),
        default=96,
        minimum=32,
    )
    rag_query_rewrite_temperature = _parse_float(
        os.getenv("RAG_QUERY_REWRITE_TEMPERATURE", "0.0"),
        default=0.0,
        minimum=0.0,
    )
    rag_query_rewrite_timeout_sec = _parse_float(
        os.getenv("RAG_QUERY_REWRITE_TIMEOUT_SEC", "4.0"),
        default=4.0,
        minimum=0.5,
    )
    rag_query_rewrite_skip_tokens = _parse_int(
        os.getenv("RAG_QUERY_REWRITE_SKIP_TOKENS", "8"),
        default=8,
        minimum=0,
    )
    rag_reranker_cpu_max_candidates = _parse_int(
        os.getenv("RAG_RERANKER_CPU_MAX_CANDIDATES", "20"),
        default=20,
        minimum=1,
    )
    rag_reranker_snippet_chars = _parse_int(
        os.getenv("RAG_RERANKER_SNIPPET_CHARS", "1600"),
        default=1600,
        minimum=200,
    )
    rag_reranker_cpu_snippet_chars = _parse_int(
        os.getenv("RAG_RERANKER_CPU_SNIPPET_CHARS", "900"),
        default=900,
        minimum=200,
    )
    rag_preload_on_startup = _parse_bool(
        os.getenv("RAG_PRELOAD_ON_STARTUP", "true"),
        default=True,
    )
    rag_preload_blocking = _parse_bool(
        os.getenv("RAG_PRELOAD_BLOCKING", "false"),
        default=False,
    )
    speech_enabled = _parse_bool(
        os.getenv("SPEECH_ENABLED", "true"),
        default=True,
    )
    whisper_model_size = os.getenv("WHISPER_MODEL_SIZE", "small").strip() or "small"
    whisper_device = os.getenv("WHISPER_DEVICE", "auto").strip().lower() or "auto"
    whisper_compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "int8").strip() or "int8"
    whisper_language = _parse_optional_str(os.getenv("WHISPER_LANGUAGE", "fr"))
    whisper_beam_size = _parse_int(
        os.getenv("WHISPER_BEAM_SIZE", "5"),
        default=5,
        minimum=1,
    )
    whisper_vad_filter = _parse_bool(
        os.getenv("WHISPER_VAD_FILTER", "true"),
        default=True,
    )

    return Settings(
        app_env=app_env,
        llm_provider=llm_provider,
        llm_api_key=api_key,
        llm_base_url=base_url,
        llm_model=model,
        allowed_origins=origins,
        allowed_origin_regex=allowed_origin_regex,
        trusted_hosts=trusted_hosts,
        api_docs_enabled=api_docs_enabled,
        request_max_body_mb=request_max_body_mb,
        gzip_enabled=gzip_enabled,
        gzip_min_size=gzip_min_size,
        rate_limit_enabled=rate_limit_enabled,
        rate_limit_requests_per_minute=rate_limit_requests_per_minute,
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
        rag_query_rewrite_enabled=rag_query_rewrite_enabled,
        rag_query_rewrite_model=rag_query_rewrite_model,
        rag_query_rewrite_max_tokens=rag_query_rewrite_max_tokens,
        rag_query_rewrite_temperature=rag_query_rewrite_temperature,
        rag_query_rewrite_timeout_sec=rag_query_rewrite_timeout_sec,
        rag_query_rewrite_skip_tokens=rag_query_rewrite_skip_tokens,
        rag_reranker_cpu_max_candidates=rag_reranker_cpu_max_candidates,
        rag_reranker_snippet_chars=rag_reranker_snippet_chars,
        rag_reranker_cpu_snippet_chars=rag_reranker_cpu_snippet_chars,
        rag_preload_on_startup=rag_preload_on_startup,
        rag_preload_blocking=rag_preload_blocking,
        speech_enabled=speech_enabled,
        whisper_model_size=whisper_model_size,
        whisper_device=whisper_device,
        whisper_compute_type=whisper_compute_type,
        whisper_language=whisper_language,
        whisper_beam_size=whisper_beam_size,
        whisper_vad_filter=whisper_vad_filter,
    )
