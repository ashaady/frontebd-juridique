from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import unicodedata
from pathlib import Path
from time import monotonic
from typing import Any, AsyncGenerator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .api import library_router, speech_router, workspace_router
from .schemas import ChatRequest
from .shared_runtime import client, get_retriever, get_workspace_rag_index, settings
from .workspace_rag import SUPPORTED_UPLOAD_EXTENSIONS, WORKSPACE_UPLOAD_DIR
from .workspace_store import append_guest_qa_log, register_user_context, workspace_storage_summary

logger = logging.getLogger("backend.app.main")

_RATE_LIMIT_LOCK = threading.Lock()
_RATE_LIMIT_STATE: dict[str, tuple[float, int]] = {}

_CHAT_USER_HEADER_CANDIDATES = (
    "x-user-id",
    "x-clerk-user-id",
    "x-client-user-id",
)

_CHAT_CAPTURE_MODES = {
    "guest",
    "anonymous",
    "signed-out",
    "signed-in",
    "authenticated",
}


def _chat_user_id(request: Request) -> str:
    for header in _CHAT_USER_HEADER_CANDIDATES:
        raw = request.headers.get(header)
        if raw and raw.strip():
            return raw.strip()
    return ""


def _chat_has_identity(request: Request) -> bool:
    if _chat_user_id(request):
        return True
    for header in ("x-user-email", "x-user-name", "x-user-username"):
        raw = request.headers.get(header)
        if raw and raw.strip():
            return True
    return False


def _chat_auth_mode(request: Request) -> str:
    mode = (request.headers.get("x-client-auth-mode") or "").strip().lower()
    if _chat_has_identity(request):
        if mode in {"signed-in", "authenticated"}:
            return mode
        return "signed-in"
    if mode in _CHAT_CAPTURE_MODES:
        return mode
    return "guest"


def _sse(event: str, data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def _should_capture_chat_sample(request: Request) -> bool:
    auth_mode = _chat_auth_mode(request)
    return auth_mode in _CHAT_CAPTURE_MODES


def _persist_chat_qa_sample(
    *,
    request: Request,
    question: str,
    answer: str,
    rag_note: str | None,
    finish_reason: str | None,
    rag_source_count: int,
) -> None:
    question_clean = (question or "").strip()
    answer_clean = (answer or "").strip()
    if not question_clean or not answer_clean:
        return

    auth_mode = _chat_auth_mode(request)
    user_id = _chat_user_id(request)
    user_email = (request.headers.get("x-user-email") or "").strip()
    user_name = (request.headers.get("x-user-name") or "").strip()
    user_username = (request.headers.get("x-user-username") or "").strip()

    record: dict[str, Any] = {
        "created_at": None,
        "auth_mode": auth_mode,
        "user_id": user_id,
        "user_email": user_email,
        "user_name": user_name,
        "user_username": user_username,
        "client_ip": request.client.host if request.client else "",
        "question": question_clean,
        "answer": answer_clean,
        "rag_note": rag_note or "",
        "finish_reason": finish_reason or "",
        "rag_source_count": int(max(0, rag_source_count)),
        "provider": settings.llm_provider,
        "model": settings.llm_model,
        "metadata": {
            "path": str(request.url.path),
            "method": str(request.method),
            "auth_mode": auth_mode,
            "origin": (request.headers.get("origin") or "").strip(),
            "referer": (request.headers.get("referer") or "").strip(),
            "user_agent": (request.headers.get("user-agent") or "").strip(),
        },
    }

    try:
        if user_id:
            register_user_context(
                user_id=user_id,
                email=user_email or None,
                username=user_username or None,
                display_name=user_name or None,
            )
        append_guest_qa_log(record)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Chat QA log write failed: %s: %s", type(exc).__name__, exc)


def _clip_for_log(value: str, max_len: int = 260) -> str:
    text = re.sub(r"\s+", " ", (value or "")).strip()
    if len(text) <= max_len:
        return text
    return f"{text[:max_len].rstrip()}..."


def _emit_rewrite_trace(status: str, original_query: str, rewritten_query: str) -> None:
    line = (
        f"[RAG-REWRITE] status={status} | "
        f'original="{_clip_for_log(original_query)}" | '
        f'rewritten="{_clip_for_log(rewritten_query)}"'
    )
    # Affichage terminal garanti (uvicorn / powershell)
    print(line, flush=True)
    # Conserver aussi le logger applicatif pour les collecteurs de logs.
    logger.info(line)


def _extract_completion_text(message: Any) -> str:
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
            continue
        if isinstance(item, dict):
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
            continue
        text = getattr(item, "text", None)
        if isinstance(text, str):
            parts.append(text)
    return "".join(parts).strip()


_SOURCE_CITATION_RE = re.compile(
    r"(?:\[\s*source\s+(\d+)\s*\]|\bsource\s+(\d+)\b)",
    re.IGNORECASE,
)
_DIRECT_SOURCE_MENTION_RE = re.compile(r"\bsource\s*:\s*([^\n]{8,220})", re.IGNORECASE)
_ARTICLE_MENTION_RE = re.compile(
    r"\b(?:l['’]\s*)?(?:article|art\.?)\s*(?:[a-z]\s*)?\d+[a-z]?(?:-\d+)?\b",
    re.IGNORECASE,
)
_CODE_FENCE_BLOCK_RE = re.compile(r"```[\s\S]*?```", re.MULTILINE)
_CODE_FENCE_CAPTURE_RE = re.compile(r"```(?:\s*([a-zA-Z0-9_+-]+))?\s*\n?([\s\S]*?)\n?```", re.MULTILINE)
_PROGRAMMING_LINE_RE = re.compile(
    r"^\s*(?:def|class|import|from|for|while|if|elif|else|try|except|return|print|async|await)\b",
    re.IGNORECASE,
)
_RAG_NOTE_LIKE_RE = re.compile(
    r"(?:query-rewrite-|domains=|confidence=|threshold_start=|selected_chunks=|citation_target=|act-generation-mode|citation-underuse)",
    re.IGNORECASE,
)
_MARKDOWN_EMPHASIS_RE = re.compile(r"(\*\*|__|\*|_)([^*_]+?)\1")


def _distinct_source_citations(answer: str) -> set[int]:
    citations: set[int] = set()
    for match in _SOURCE_CITATION_RE.finditer(answer):
        value = match.group(1) or match.group(2)
        try:
            citations.add(int(value))
        except (TypeError, ValueError):
            continue
    return citations


def _append_rag_note(base_note: str | None, suffix: str) -> str:
    if not base_note:
        return suffix
    if suffix in base_note:
        return base_note
    return f"{base_note} | {suffix}"


def _check_citation_underuse(
    answer: str,
    rag_source_count: int,
    rag_note: str | None,
) -> tuple[str | None, bool]:
    if rag_source_count < settings.rag_min_source_citations:
        return rag_note, False
    distinct_citations = _distinct_source_citations(answer)
    direct_mentions = {
        re.sub(r"\s+", " ", match.group(1).strip().lower())
        for match in _DIRECT_SOURCE_MENTION_RE.finditer(answer or "")
        if isinstance(match.group(1), str) and match.group(1).strip()
    }
    if (len(distinct_citations) + len(direct_mentions)) >= settings.rag_min_source_citations:
        return rag_note, False
    updated_note = _append_rag_note(rag_note, "citation-underuse")
    return updated_note, True


def _public_rag_sources(rag_sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    public_sources: list[dict[str, Any]] = []
    for source in rag_sources:
        if not isinstance(source, dict):
            continue
        public_source = dict(source)
        # Internal field used only for backend citation checks.
        public_source.pop("excerpt", None)
        public_sources.append(public_source)
    return public_sources


_CITATION_MATCH_STOPWORDS = {
    "les",
    "des",
    "une",
    "dans",
    "avec",
    "pour",
    "par",
    "sur",
    "aux",
    "est",
    "sont",
    "que",
    "qui",
    "pas",
    "plus",
    "moins",
    "dans",
    "leur",
    "leurs",
    "cette",
    "cet",
    "celles",
    "ceux",
    "vous",
    "nous",
    "elle",
    "elles",
    "ils",
    "ainsi",
    "donc",
    "selon",
    "article",
    "articles",
    "source",
}


def _normalize_for_citation_match(text: str) -> str:
    lowered = unicodedata.normalize("NFKD", text.lower())
    ascii_like = "".join(ch for ch in lowered if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", ascii_like).strip()


def _tokenize_for_citation_match(text: str) -> set[str]:
    normalized = _normalize_for_citation_match(text)
    if not normalized:
        return set()
    tokens = {token for token in normalized.split(" ") if len(token) >= 3}
    return {token for token in tokens if token not in _CITATION_MATCH_STOPWORDS}


def _extract_numeric_tokens_for_citation(text: str) -> set[str]:
    values: set[str] = set()
    for raw in re.findall(r"\b\d[\d\s\.,]*\b", text):
        digits = re.sub(r"\D+", "", raw)
        if not digits:
            continue
        values.add(digits)
    return values


def _source_rank_citation_map(rag_sources: list[dict[str, Any]]) -> dict[int, str]:
    rank_map: dict[int, str] = {}
    for source in rag_sources:
        if not isinstance(source, dict):
            continue
        try:
            rank = int(source.get("rank"))
        except (TypeError, ValueError):
            continue
        label = str(
            source.get("citation")
            or source.get("relative_path")
            or source.get("source_path")
            or f"source {rank}"
        ).strip()
        if not label:
            continue
        label = re.sub(r"\s+", " ", label).strip()
        rank_map[rank] = label
    return rank_map


def _replace_source_markers_with_direct_citations(
    answer: str,
    rank_to_citation: dict[int, str],
) -> tuple[str, bool]:
    updated = answer
    changed = False

    for rank, citation in sorted(rank_to_citation.items(), key=lambda item: item[0], reverse=True):
        marker_re = re.compile(
            rf"(?:\[\s*source\s+{rank}\s*\]|\bsource\s+{rank}\b)",
            re.IGNORECASE,
        )
        replacement = f"Source: {citation}"
        new_updated = marker_re.sub(replacement, updated)
        if new_updated != updated:
            updated = new_updated
            changed = True

    # Remove unresolved source placeholders.
    new_updated = re.sub(r"\[\s*source\s+\d+\s*\]", "", updated, flags=re.IGNORECASE)
    new_updated = re.sub(r"\bsource\s+\d+\b", "", new_updated, flags=re.IGNORECASE)
    if new_updated != updated:
        updated = new_updated
        changed = True
    return updated, changed


_ARTICLE_REFERENCE_CAPTURE_RE = re.compile(
    r"\b(?:article|art\.?)\s*([0-9]+(?:\s*(?:bis|ter|quater))?)\b",
    re.IGNORECASE,
)
_NUMERIC_RANGE_RE = re.compile(
    r"\b(\d[\d\s\.,]*)\s*(?:a|à|-|au)\s*(\d[\d\s\.,]*)\b",
    re.IGNORECASE,
)
_SANCTION_NUMERIC_LINE_RE = re.compile(
    r"\b(?:peine|peines|amende|amendes|emprisonnement|puni|punie|punis)\b",
    re.IGNORECASE,
)


def _normalize_numeric_token(token: str) -> str:
    return re.sub(r"\D+", "", token or "")


def _extract_article_keys(text: str) -> set[str]:
    keys: set[str] = set()
    for match in _ARTICLE_REFERENCE_CAPTURE_RE.finditer(text or ""):
        key = re.sub(r"\s+", " ", (match.group(1) or "").strip().lower())
        if key:
            keys.add(key)
    return keys


def _extract_numeric_ranges(text: str) -> set[tuple[str, str]]:
    ranges: set[tuple[str, str]] = set()
    for match in _NUMERIC_RANGE_RE.finditer(text or ""):
        left = _normalize_numeric_token(match.group(1))
        right = _normalize_numeric_token(match.group(2))
        if left and right:
            ranges.add((left, right))
    return ranges


def _sanitize_conflicting_article_ranges(
    answer: str,
    rag_sources: list[dict[str, Any]],
) -> tuple[str, bool]:
    if not answer.strip():
        return answer, False

    source_meta: list[tuple[set[str], set[tuple[str, str]]]] = []
    for source in rag_sources:
        if not isinstance(source, dict):
            continue
        excerpt = str(source.get("excerpt") or "").strip()
        if not excerpt:
            excerpt = str(source.get("citation") or "").strip()
        if not excerpt:
            continue
        article_keys = _extract_article_keys(excerpt)
        range_pairs = _extract_numeric_ranges(excerpt)
        if not article_keys or not range_pairs:
            continue
        source_meta.append((article_keys, range_pairs))

    if not source_meta:
        return answer, False

    changed = False
    sanitized_lines: list[str] = []
    for raw_line in answer.splitlines():
        line = raw_line.strip()
        if not line:
            sanitized_lines.append(raw_line)
            continue
        if not _SANCTION_NUMERIC_LINE_RE.search(line):
            sanitized_lines.append(raw_line)
            continue

        line_article_keys = _extract_article_keys(line)
        line_ranges = _extract_numeric_ranges(line)
        if not line_article_keys or not line_ranges:
            sanitized_lines.append(raw_line)
            continue

        candidate_sources = [
            ranges
            for article_keys, ranges in source_meta
            if line_article_keys.intersection(article_keys)
        ]
        if not candidate_sources:
            sanitized_lines.append(raw_line)
            continue
        if any(line_ranges.issubset(ranges) for ranges in candidate_sources):
            sanitized_lines.append(raw_line)
            continue

        article_label = sorted(line_article_keys)[0]
        replacement = (
            f"Pour l'article {article_label}, les peines chiffrees varient selon la version du texte "
            "presente dans les sources; verifier le document applicable cite."
        )
        sanitized_lines.append(replacement)
        changed = True

    sanitized = "\n".join(sanitized_lines).strip()
    return sanitized if sanitized else answer, changed


def _sanitize_citations_against_sources(
    answer: str,
    rag_sources: list[dict[str, Any]],
    *,
    min_overlap_ratio: float = 0.12,
) -> tuple[str, list[dict[str, Any]], bool]:
    if not answer.strip():
        return answer, rag_sources, False

    source_text_by_rank: dict[int, str] = {}
    filtered_sources: list[dict[str, Any]] = []
    for source in rag_sources:
        if not isinstance(source, dict):
            continue
        rank_raw = source.get("rank")
        try:
            rank = int(rank_raw)
        except (TypeError, ValueError):
            continue
        excerpt = str(source.get("excerpt") or "").strip()
        if not excerpt:
            excerpt = str(source.get("citation") or "").strip()
        if excerpt:
            source_text_by_rank[rank] = excerpt
        filtered_sources.append(source)

    if not source_text_by_rank:
        return answer, rag_sources, False

    updated_answer = answer
    changed = False

    # Drop citations that reference unknown source ranks.
    known_ranks = set(source_text_by_rank.keys())
    for cited_rank in _distinct_source_citations(updated_answer):
        if cited_rank in known_ranks:
            continue
        updated_answer = re.sub(
            rf"\[source\s+{cited_rank}\]",
            "",
            updated_answer,
            flags=re.IGNORECASE,
        )
        changed = True

    # Validate each cited source against the local sentence/line claim text.
    segments = [seg.strip() for seg in re.split(r"[\n\.!\?;:]+", updated_answer) if seg.strip()]
    bad_ranks: set[int] = set()
    for segment in segments:
        cited_in_segment = _distinct_source_citations(segment)
        if not cited_in_segment:
            continue
        claim_text = _SOURCE_CITATION_RE.sub(" ", segment)
        claim_tokens = _tokenize_for_citation_match(claim_text)
        if not claim_tokens:
            continue
        for rank in cited_in_segment:
            source_tokens = _tokenize_for_citation_match(source_text_by_rank.get(rank, ""))
            if not source_tokens:
                bad_ranks.add(rank)
                continue
            overlap = len(claim_tokens.intersection(source_tokens)) / max(1, len(claim_tokens))
            if overlap < min_overlap_ratio:
                bad_ranks.add(rank)
                continue
            claim_numbers = _extract_numeric_tokens_for_citation(claim_text)
            if claim_numbers:
                source_numbers = _extract_numeric_tokens_for_citation(
                    source_text_by_rank.get(rank, "")
                )
                if source_numbers and claim_numbers.isdisjoint(source_numbers):
                    bad_ranks.add(rank)

    for rank in sorted(bad_ranks):
        before = updated_answer
        updated_answer = re.sub(
            rf"(?:\[\s*source\s+{rank}\s*\]|\bsource\s+{rank}\b)",
            "",
            updated_answer,
            flags=re.IGNORECASE,
        )
        if updated_answer != before:
            changed = True

    rank_to_citation = _source_rank_citation_map(filtered_sources)
    updated_answer, replaced_markers = _replace_source_markers_with_direct_citations(
        updated_answer,
        rank_to_citation,
    )
    changed = changed or replaced_markers

    normalized_lines: list[str] = []
    previous_empty = False
    for raw_line in updated_answer.splitlines():
        line = re.sub(r"[ \t]{2,}", " ", raw_line).replace(" .", ".").strip()
        if not line:
            if previous_empty:
                continue
            normalized_lines.append("")
            previous_empty = True
            continue
        previous_empty = False
        normalized_lines.append(line)
    updated_answer = "\n".join(normalized_lines).strip()
    if updated_answer != answer:
        changed = True

    # Preserve retrieved sources to keep RAG observability even when inline
    # citation markers are converted/removed.
    kept_sources = filtered_sources

    if len(kept_sources) != len(rag_sources):
        changed = True
    return updated_answer, kept_sources, changed


def _sanitize_unbacked_article_mentions(answer: str) -> tuple[str, bool]:
    # Keep article mentions exactly as generated by the model.
    return answer, False


def _strip_programming_artifacts(text: str) -> tuple[str, bool]:
    changed = False

    def _replace_code_fence(match: re.Match[str]) -> str:
        nonlocal changed
        language = (match.group(1) or "").strip().lower()
        body = (match.group(2) or "").strip()
        # Preserve JSON payloads (used by act-generation workflow) while stripping wrappers.
        if body and (
            language in {"json", ""}
            and (body.startswith("{") or body.startswith("["))
        ):
            changed = True
            return body
        changed = True
        return ""

    cleaned = _CODE_FENCE_CAPTURE_RE.sub(_replace_code_fence, text)
    if cleaned != text:
        changed = True

    kept_lines: list[str] = []
    for raw_line in cleaned.splitlines():
        line = raw_line.rstrip()
        if _PROGRAMMING_LINE_RE.match(line):
            changed = True
            continue
        kept_lines.append(line)
    return "\n".join(kept_lines), changed


def _strip_markdown_artifacts(text: str) -> tuple[str, bool]:
    changed = False
    cleaned = text

    def _replace_emphasis(match: re.Match[str]) -> str:
        nonlocal changed
        changed = True
        return (match.group(2) or "").strip()

    cleaned = _MARKDOWN_EMPHASIS_RE.sub(_replace_emphasis, cleaned)

    normalized_lines: list[str] = []
    for raw_line in cleaned.splitlines():
        line = raw_line
        new_line = re.sub(r"^\s{0,3}#{1,6}\s*", "", line)
        if new_line != line:
            changed = True
            line = new_line
        new_line = re.sub(r"^\s*[-*+]\s+", "", line)
        if new_line != line:
            changed = True
            line = new_line
        normalized_lines.append(line)
    cleaned = "\n".join(normalized_lines)
    return cleaned, changed


def _compress_repeated_lines(text: str, max_occurrences: int = 2) -> tuple[str, bool]:
    changed = False
    counts: dict[str, int] = {}
    output_lines: list[str] = []
    previous_empty = False
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            if previous_empty:
                changed = True
                continue
            output_lines.append("")
            previous_empty = True
            continue

        previous_empty = False
        key = re.sub(r"\s+", " ", line).lower()
        count = counts.get(key, 0) + 1
        counts[key] = count
        if count > max_occurrences:
            changed = True
            continue
        output_lines.append(line)
    return "\n".join(output_lines).strip(), changed


def _trim_tail_block_repetition(text: str) -> tuple[str, bool]:
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) < 8:
        return text, False

    lowered = [re.sub(r"\s+", " ", line.strip()).lower() for line in lines]
    changed = False

    for block_size in (1, 2, 3):
        if len(lowered) < block_size * 4:
            continue
        tail_block = lowered[-block_size:]
        repeats = 1
        cursor = len(lowered) - (block_size * 2)
        while cursor >= 0 and lowered[cursor : cursor + block_size] == tail_block:
            repeats += 1
            cursor -= block_size
        if repeats >= 3:
            keep_count = len(lines) - (repeats * block_size) + (2 * block_size)
            keep_count = max(1, keep_count)
            lines = lines[:keep_count]
            lowered = lowered[:keep_count]
            changed = True
            break

    return "\n".join(lines).strip(), changed


def _sanitize_generated_answer(answer: str) -> tuple[str, bool]:
    cleaned = (answer or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not cleaned:
        return "", False

    changed = False
    cleaned, removed_code = _strip_programming_artifacts(cleaned)
    changed = changed or removed_code

    cleaned, removed_markdown = _strip_markdown_artifacts(cleaned)
    changed = changed or removed_markdown

    cleaned, compressed = _compress_repeated_lines(cleaned, max_occurrences=2)
    changed = changed or compressed

    cleaned, tail_trimmed = _trim_tail_block_repetition(cleaned)
    changed = changed or tail_trimmed

    return cleaned.strip(), changed


def _is_rag_note_like_text(answer: str) -> bool:
    text = (answer or "").strip()
    if not text:
        return False
    # Heuristic: technical pipeline markers separated by pipes.
    if "|" in text and _RAG_NOTE_LIKE_RE.search(text):
        return True
    return False


def _has_runaway_repetition(answer: str) -> bool:
    text = (answer or "").strip()
    if len(text) < 900:
        return False

    lines = [re.sub(r"\s+", " ", line.strip()).lower() for line in text.splitlines() if line.strip()]
    if len(lines) < 12:
        return False

    tail = lines[-12:]
    unique_tail = set(tail)
    if len(unique_tail) <= 3:
        return True

    frequency: dict[str, int] = {}
    for line in tail:
        frequency[line] = frequency.get(line, 0) + 1
    return max(frequency.values(), default=0) >= 5

# ---------------------------------------------------------------------------
# Prompt de reponse finale (Appel LLM 2 - Answering)
# ---------------------------------------------------------------------------
RAG_SYSTEM_INSTRUCTIONS = (
    "Tu es un assistant juridique francophone specialise en droit senegalais.\n"
    "Priorise le CONTEXTE RAG fourni comme base principale.\n"
    "Tu ne reponds jamais aux questions sur ton origine, ton createur, ton entreprise, "
    "ou ton fonctionnement interne.\n"
    "Si une telle question apparait, refuse poliment en recentrant vers le droit senegalais.\n"
    "Ne mentionne jamais le niveau de confiance interne (LOW, MEDIUM, HIGH) dans la reponse.\n"
    "Si tu cites un article ou une loi, ecris-le explicitement (ex: Article 55) dans la reponse.\n"
    "Toute affirmation juridique substantielle doit etre rattachee a une source documentaire explicite du contexte.\n"
    "N'utilise jamais les placeholders [source X] ni 'source 1' dans la reponse finale.\n"
    "Cite directement le document et la page, format conseille: 'Source: <citation du document>'.\n"
    "N'associe jamais un numero d'article a un contenu qui n'apparait pas clairement dans la source citee.\n"
    "Si l'article exact n'est pas explicite dans le contexte, n'ecris pas son numero.\n"
    "A la place, formule prudemment 'base legale non explicite dans le contexte fourni'.\n"
    "Si plusieurs versions d'un meme article apparaissent dans le contexte, ne fusionne jamais les chiffres.\n"
    "Indique explicitement qu'il existe plusieurs versions et distingue chaque version avec sa source.\n"
    "Quand au moins 3 sources sont fournies, synthetise au moins 3 sources distinctes.\n"
    "Si possible, ces sources doivent provenir d'au moins 2 documents differents (pas seulement plusieurs extraits du meme fichier).\n"
    "Si un texte general (code) et un texte special (loi speciale/decret) sont tous deux presents et pertinents,\n"
    "cite explicitement les deux et explique leur articulation.\n"
    "Si moins de 3 sources sont disponibles, dis-le explicitement et reponds avec ce qui est disponible.\n"
    "Pour les questions de responsabilite/sanctions (ex: 'il risque quoi'), reponds dans cet ordre:\n"
    "1) qualification et explication juridique des faits,\n"
    "2) base(s) legale(s) applicable(s),\n"
    "3) sanctions/peines explicites (emprisonnement, amende, etc.) uniquement si presentes dans le contexte.\n"
    "Ne commence pas directement par les peines sans exposer d'abord la qualification des faits.\n"
    "Tu peux faire un raisonnement juridique simple en t'appuyant sur ton entrainement interne\n"
    "uniquement pour relier des elements deja compatibles avec les sources recuperees.\n"
    "N'invente ni faits, ni articles, ni sanctions.\n"
    "Si la question demande les peines/sanctions (ex: 'il risque quoi'), et que le contexte contient des peines,\n"
    "indique explicitement la duree d'emprisonnement et/ou le montant d'amende avec la base legale citee.\n"
    "Format de sortie obligatoire: texte brut uniquement.\n"
    "N'utilise jamais de markdown ni de caracteres de balisage (` ``` ** __ # > ).\n"
    "N'ajoute pas de puces markdown; ecris des phrases claires sur des lignes simples.\n"
)

RAG_NO_CONTEXT_RESPONSE = (
    "Tu es un assistant juridique francophone specialise en droit senegalais.\n"
    "Tu ne reponds jamais aux questions sur ton origine, ton createur, ton entreprise, "
    "ou ton fonctionnement interne.\n"
    "Si une telle question apparait, refuse poliment en recentrant vers le droit senegalais.\n"
    "Le contexte documentaire exploitable est insuffisant pour citer des articles de facon fiable.\n"
    "Fournis quand meme une reponse utile, claire et prudente a partir des principes juridiques generaux.\n"
    "N'invente ni numero d'article, ni sanction, ni placeholder de citation.\n"
    "Si un point depend d'un texte precis non present, indique: 'base legale non explicite dans le contexte'.\n"
    "Format de sortie obligatoire: texte brut uniquement, sans markdown ni caracteres de balisage.\n"
)

DEFINITION_FOCUS_INSTRUCTIONS = (
    "Instruction de style pour cette question:\n"
    "- La question est une demande de definition.\n"
    "- Reponds en 4 a 8 lignes maximum, sans repetition.\n"
    "- Structure: 1) definition simple 2) 2 ou 3 elements cles 3) base legale si disponible.\n"
    "- Interdiction de fournir du code, JSON, pseudo-code ou contenu technique hors droit.\n"
)

ACT_GENERATION_INSTRUCTIONS = (
    "Instruction de redaction d'acte juridique:\n"
    "- Avant de rediger, verifie si les informations essentielles sont presentes.\n"
    "- Si des informations manquent, ne redige pas l'acte final: pose une liste courte de questions ciblees.\n"
    "- Types d'actes couverts: contrat, mise en demeure, plainte penale, requete, assignation, procuration, "
    "statuts de societe OHADA, reconnaissance de dette.\n"
    "- Si les informations sont suffisantes, redige un document structure avec:\n"
    "  1) titre,\n"
    "  2) identification des parties,\n"
    "  3) visa/base legale pertinente,\n"
    "  4) clauses ou articles numerotes,\n"
    "  5) date et lieu,\n"
    "  6) signatures.\n"
    "- Adapte le droit applicable: Senegal (national) ou OHADA selon la matiere.\n"
    "- Toujours terminer par la mention suivante:\n"
    "  'Ce document est un modele genere automatiquement et doit etre verifie par un professionnel du droit avant utilisation.'\n"
    "- Reponse uniquement en francais.\n"
    "- Format de sortie obligatoire: texte brut uniquement, sans markdown ni caracteres de balisage.\n"
)

RAG_RETRIEVAL_OVERFETCH_FACTOR = 8

RAG_QUERY_REWRITE_SYSTEM_INSTRUCTIONS = (
    "Tu es un expert de reformulation pour la recherche documentaire juridique "
    "(droit senegalais et OHADA).\n"
    "Mission: transformer la question utilisateur en requete RAG juridiquement exploitable, "
    "plus precise, plus complete et plus discriminante, sans changer l'intention.\n"
    "Contraintes absolues:\n"
    "- La sortie finale doit etre STRICTEMENT en francais (sauf sigles officiels / noms propres).\n"
    "- Ne reponds pas a la question de fond: tu ne fais QUE reformuler pour la recherche.\n"
    "- Ne fabrique jamais un numero d'article ou une reference legale absente de la question.\n"
    "- Ne rajoute pas de domaine hors sujet.\n"
    "Strategie de reformulation:\n"
    "- Identifier le domaine principal (penal, travail, famille, fiscal, commercial, procedure, OHADA, etc.).\n"
    "- Ajouter une ancre de domaine explicite pertinente "
    "(ex: 'code penal senegal', 'code du travail senegal', 'code de la famille senegal', "
    "'code de procedure penale senegal', 'code de procedure civile senegal', "
    "'code general des impots senegal', 'ohada acte uniforme').\n"
    "- Conserver tous les faits utiles de la question (qualificatifs, circonstances, acteurs, temporalite, contexte).\n"
    "- Corriger les fautes evidentes et normaliser les variantes lexicales "
    "(ex: 'code penal' <-> 'droit penal').\n"
    "- Enrichir avec synonymes juridiques strictement utiles a la recherche documentaire.\n"
    "- Si la question vise les peines/sanctions, inclure explicitement les axes de recherche: "
    "'sanctions penales', 'peines', 'amende', 'emprisonnement', "
    "'circonstances aggravantes', 'elements constitutifs' quand pertinent.\n"
    "- Si une infraction precise est citee (ex: vol aggrave, escroquerie, harcelement sexuel), "
    "la conserver telle quelle et la placer au debut de la requete.\n"
    "- Si la question est une definition simple, produire une requete juridique claire de type "
    "'definition + notion + base legale potentielle', sans bruit inutile.\n"
    "Style attendu pour `query`:\n"
    "- Rediger `query` comme UNE phrase juridique complete et naturelle (pas une liste).\n"
    "- La phrase doit conserver les faits utiles et expliciter clairement l'objet juridique de la recherche.\n"
    "- Interdit: enchainement brut de mots-cles separes par virgules, points-virgules, slashs ou tags.\n"
    "- AUCUNE limite stricte de mots: tu peux produire une reformulation juridique complete si necessaire.\n"
    "- La requete doit rester utile a la recherche (pas de bavardage, pas de meta-commentaire).\n"
    "Format de sortie (obligatoire):\n"
    "- Retourner UNIQUEMENT un JSON valide sur une seule ligne.\n"
    "- Format exact: {\"query\":\"...\"}\n"
    "- Aucune explication, aucun markdown, aucun commentaire avant/apres le JSON.\n"
)

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
_DEFINITION_PREFIX_RE = re.compile(
    r"^\s*(?:c[' ]?est\s+quoi|c\s+quoi|que\s+signifie|qu[' ]?est(?:-|\s)?ce\s+qu(?:e|['’])?|definition(?:\s+de)?|definir|explique(?:\s+moi)?|exemple|example)\b[\s:,-]*",
    re.IGNORECASE,
)
_ARTICLE_LIKE_QUERY_RE = re.compile(r"\b(?:article|art\.?)\s*\d+", re.IGNORECASE)
_LEADING_FOLLOWUP_RE = re.compile(r"^(?:et|alors|sinon|donc|du coup)\s+", re.IGNORECASE)
_LEADING_DETERMINER_RE = re.compile(r"^(?:l'|le|la|les|du|de la|de l')\s+", re.IGNORECASE)
_LEGAL_INTENT_HINT_RE = re.compile(
    r"\b(?:droit|code|loi|article|infraction|crime|delit|contravention|contrat|licenciement|travail|bail|succession|ohada|juridique|penal|civil|fiscal)\b",
    re.IGNORECASE,
)
_REFERENCE_LOOKUP_QUERY_RE = re.compile(
    r"\b(?:quel(?:le)?\s+(?:article|texte|loi|code|disposition)|lequel|laquelle|cet?\s+article|ce\s+texte)\b",
    re.IGNORECASE,
)
_SMALL_TALK_EXACT = {
    "bonjour",
    "bonsoir",
    "salut",
    "coucou",
    "hello",
    "hi",
    "hey",
    "merci",
    "merci beaucoup",
    "ca va",
    "comment ca va",
}

_REWRITE_MEMORY_MAX_MESSAGES = 6
_REWRITE_MEMORY_MAX_LINE_CHARS = 160
_REWRITE_KEYWORD_LIST_SEPARATORS = (",", ";", "/", "|")
_REWRITE_SENTENCE_VERB_RE = re.compile(
    r"\b(?:est|sont|etre|constitue|constituent|concerne|concernent|prevoit|prevoient|"
    r"definit|definissent|qualifie|qualifient|regit|regissent|sanctionne|sanctionnent|"
    r"puni|punie|punis|punies|encourt|encourent|peut|peuvent|doit|doivent|vise|visent)\b",
    re.IGNORECASE,
)
_REWRITE_FOLLOWUP_PREFIXES = (
    "et ",
    "et pour",
    "et si",
    "et concernant",
    "dans ce cas",
    "pour ca",
    "pour ça",
    "a ce sujet",
    "a ce propos",
    "aussi",
    "encore",
    "idem",
)
_REWRITE_FOLLOWUP_MARKERS = {
    "et",
    "aussi",
    "encore",
    "cela",
    "ceci",
    "ca",
    "ça",
    "idem",
    "pareil",
    "meme",
    "même",
}

_REWRITE_SANCTION_GUARD_PHRASES = (
    "sanctions penales",
    "sanction penale",
    "peines applicables",
    "peine applicable",
    "peines encourues",
    "peine encourue",
    "amendes",
    "amende",
    "emprisonnement",
    "sanctions",
    "sanction",
    "peines",
    "peine",
)


def _strip_accents(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch))


def _definition_rewrite_candidate(original_query: str) -> str | None:
    query = _normalize_spaces(original_query)
    if not query:
        return None

    lowered = _strip_accents(query).lower()
    has_definition_prefix = _DEFINITION_PREFIX_RE.match(lowered) is not None

    # Protect explicit article/legal reference questions from definition shortcut.
    if _ARTICLE_LIKE_QUERY_RE.search(query):
        return None
    if _REFERENCE_LOOKUP_QUERY_RE.search(query):
        return None

    if has_definition_prefix:
        subject = _DEFINITION_PREFIX_RE.sub("", query).strip(" .,:;?!-")
        subject = _LEADING_FOLLOWUP_RE.sub("", subject).strip()
        subject = _LEADING_DETERMINER_RE.sub("", subject).strip()
        if not subject:
            subject = query
        # Keep definition shortcut only for concise concept queries.
        subject_tokens = [token for token in re.split(r"\s+", _strip_accents(subject).lower()) if token]
        if len(subject_tokens) > 8:
            return None
        return _normalize_spaces(f"definition {subject}")

    # Short concept queries (e.g. "contrat de travail") should remain concise.
    tokens = [token for token in re.split(r"\s+", lowered) if token]
    if 1 <= len(tokens) <= 4 and not any(char.isdigit() for char in lowered):
        compact_query = _normalize_spaces(_LEADING_FOLLOWUP_RE.sub("", query))
        compact_query = _LEADING_DETERMINER_RE.sub("", compact_query).strip()
        if not compact_query:
            compact_query = query
        return _normalize_spaces(f"definition {compact_query}")

    return None


def _is_definition_question(query: str) -> bool:
    return _definition_rewrite_candidate(query) is not None


_REWRITE_DOMAIN_ANCHORS: list[tuple[tuple[str, ...], str]] = [
    (
        (
            "viande",
            "aliment",
            "alimentaire",
            "denree",
            "boucher",
            "hygiene",
            "consommation",
            "insalubre",
            "impropre",
        ),
        "code de l hygiene senegal protection du consommateur code penal senegal",
    ),
    (
        (
            "travail",
            "licenciement",
            "salaire",
            "conge",
            "conges",
            "conges payes",
            "preavis",
            "employeur",
            "employe",
            "contrat de travail",
        ),
        "code du travail senegal",
    ),
    (
        ("famille", "mariage", "divorce", "filiation", "succession"),
        "code de la famille senegal",
    ),
    (
        ("penal", "crime", "delit", "contravention", "infraction", "peine"),
        "code penal senegal",
    ),
    (
        ("procedure penale", "garde a vue", "opj", "mandat de depot"),
        "code de procedure penale senegal",
    ),
    (
        ("procedure civile", "cpc", "execution", "saisie"),
        "code de procedure civile senegal",
    ),
    (
        ("impot", "fiscal", "taxe", "douane", "cgi"),
        "code general des impots senegal",
    ),
    (
        ("ohada", "acte uniforme", "societes commerciales", "suretes"),
        "ohada acte uniforme",
    ),
]

_REWRITE_ANCHOR_BY_DETECTED_DOMAIN: dict[str, str] = {
    "travail": "code du travail senegal",
    "famille": "code de la famille senegal",
    "penal": "code penal senegal",
    "procedure_penale": "code de procedure penale senegal",
    "fiscal": "code general des impots senegal",
    "civil_commercial": "code des obligations civiles et commerciales senegal",
    "ohada": "ohada acte uniforme",
    "foncier": "regime foncier senegal",
    "route": "code de la route senegal",
    "presse": "code de la presse senegal",
    "environnement": "code de l environnement senegal",
    "hygiene_consommation": "code de l hygiene senegal protection du consommateur",
    "notariat": "deontologie notariat senegal",
    "electoral": "code electoral senegal",
}

_REWRITE_TOPIC_HINTS: list[tuple[tuple[str, ...], str]] = []


def _infer_rewrite_domain_anchor(query: str) -> str | None:
    normalized = _strip_accents(query).lower()
    for keywords, anchor in _REWRITE_DOMAIN_ANCHORS:
        if any(keyword in normalized for keyword in keywords):
            return anchor
    try:
        from backend.retrieval.retriever import detect_query_domains

        for domain in detect_query_domains(query):
            anchor = _REWRITE_ANCHOR_BY_DETECTED_DOMAIN.get(domain)
            if anchor:
                return anchor
    except Exception:
        return None
    return None


def _infer_rewrite_topic_hint(query: str) -> str | None:
    # Keep the rewrite pipeline generic (no subject-specific lock).
    # Domain anchoring remains active via _infer_rewrite_domain_anchor.
    return None


def _enforce_rewrite_anchor(original_query: str, rewritten_query: str) -> str:
    return _enforce_rewrite_anchor_with_lock(
        original_query,
        rewritten_query,
        forced_anchor=None,
        forced_topic_hint=None,
    )


def _enforce_rewrite_anchor_with_lock(
    original_query: str,
    rewritten_query: str,
    *,
    forced_anchor: str | None,
    forced_topic_hint: str | None,
) -> str:
    rewritten = _normalize_spaces(rewritten_query)
    if not rewritten:
        return rewritten

    original_norm = _strip_accents(original_query).lower()
    rewritten_norm = _strip_accents(rewritten).lower()

    anchor = forced_anchor or _infer_rewrite_domain_anchor(original_query)
    if anchor:
        anchor_norm = _strip_accents(anchor).lower()
        if anchor_norm not in rewritten_norm:
            rewritten = _normalize_spaces(f"{rewritten} {anchor}")
            rewritten_norm = _strip_accents(rewritten).lower()
        # Remove obvious cross-domain drift when user did not ask it.
        if "ohada" in rewritten_norm and "ohada" not in original_norm and "travail" in anchor_norm:
            rewritten = _normalize_spaces(re.sub(r"\bohada\b", " ", rewritten, flags=re.IGNORECASE))
            rewritten_norm = _strip_accents(rewritten).lower()

    topic_hint = forced_topic_hint or _infer_rewrite_topic_hint(original_query)
    if topic_hint:
        topic_norm = _strip_accents(topic_hint).lower()
        if topic_norm not in rewritten_norm:
            rewritten = _normalize_spaces(f"{rewritten} {topic_hint}")
    return rewritten


def _strip_unrequested_sanction_terms_from_rewrite(
    original_query: str,
    rewritten_query: str,
) -> tuple[str, bool]:
    rewritten = _normalize_spaces(rewritten_query)
    if not rewritten:
        return rewritten_query, False
    if _query_has_sanction_intent(original_query):
        return rewritten, False

    original_norm = _normalize_for_query_coverage(original_query)
    sanitized = rewritten
    changed = False
    for phrase in _REWRITE_SANCTION_GUARD_PHRASES:
        phrase_norm = _normalize_for_query_coverage(phrase)
        if phrase_norm and phrase_norm in original_norm:
            continue
        pattern = r"\b" + re.escape(phrase).replace(r"\ ", r"\s+") + r"\b"
        updated = re.sub(pattern, " ", sanitized, flags=re.IGNORECASE)
        if updated != sanitized:
            sanitized = updated
            changed = True

    sanitized = _normalize_spaces(sanitized)
    if not sanitized:
        return rewritten, False
    return sanitized, changed


def _looks_like_keyword_rewrite(text: str) -> bool:
    normalized = _normalize_spaces(text)
    if not normalized:
        return False

    tokens = [token for token in normalized.split(" ") if token]
    if len(tokens) < 6:
        return False

    separator_count = sum(normalized.count(sep) for sep in _REWRITE_KEYWORD_LIST_SEPARATORS)
    has_sentence_punct = any(punct in normalized for punct in (".", "?", "!"))
    lowered = _strip_accents(normalized).lower()
    has_verb = bool(_REWRITE_SENTENCE_VERB_RE.search(lowered))

    if separator_count >= 2 and not has_sentence_punct:
        return True
    if separator_count >= 1 and not has_verb:
        return True
    if not has_verb and not has_sentence_punct and len(tokens) >= 6:
        return True
    return False


def _ensure_rewrite_sentence_style(original_query: str, rewritten_query: str) -> tuple[str, bool]:
    rewritten = _normalize_spaces(rewritten_query)
    if not rewritten:
        return rewritten_query, False
    if not _looks_like_keyword_rewrite(rewritten):
        return rewritten, False

    core = rewritten.strip(" \t\r\n,;:/|")
    if not core:
        return rewritten, False

    phrased = _normalize_spaces(
        f"Rechercher les regles juridiques applicables au Senegal et en OHADA concernant {core}."
    )
    if not phrased:
        return rewritten, False
    return phrased, True


def _is_small_talk_query(query: str) -> bool:
    normalized = _normalize_spaces(_strip_accents(query).lower())
    if not normalized:
        return False
    simplified = re.sub(r"[^\w\s']", " ", normalized)
    simplified = _normalize_spaces(simplified)
    if not simplified:
        return False
    if _LEGAL_INTENT_HINT_RE.search(simplified):
        return False
    if simplified in _SMALL_TALK_EXACT:
        return True
    tokens = [token for token in simplified.split(" ") if token]
    if len(tokens) <= 4 and any(
        simplified.startswith(prefix)
        for prefix in ("bonjour", "bonsoir", "salut", "hello", "merci")
    ):
        return True
    return False


def _should_skip_query_rewrite(query: str) -> bool:
    # Skip extra LLM rewrite call when the question is already explicit enough.
    # This removes avoidable provider round-trips on long factual prompts.
    threshold = settings.rag_query_rewrite_skip_tokens
    if threshold <= 0:
        return False
    normalized = _normalize_spaces(query)
    if not normalized:
        return False
    if _definition_rewrite_candidate(normalized):
        return False
    if _ARTICLE_LIKE_QUERY_RE.search(normalized):
        return False
    token_count = len([token for token in normalized.split(" ") if token])
    return token_count >= threshold


def _is_act_generation_question(query: str) -> bool:
    lowered = _strip_accents(query).lower()
    patterns = [
        r"\b(genere|generer|generation|redige|rediger|modele|brouillon|template)\b.{0,40}\b(acte|contrat|plainte|requete|assignation|procuration|statuts|reconnaissance de dette|mise en demeure)\b",
        r"\b(acte|contrat|plainte|requete|assignation|procuration|statuts|reconnaissance de dette|mise en demeure)\b.{0,40}\b(genere|generer|redige|rediger|modele|brouillon)\b",
    ]
    return any(re.search(pattern, lowered) for pattern in patterns)


def _normalize_spaces(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _normalize_chat_messages_for_rewrite(messages: list[dict[str, Any]]) -> list[tuple[str, str]]:
    normalized: list[tuple[str, str]] = []
    for message in messages:
        role_raw = message.get("role")
        role = role_raw.strip().lower() if isinstance(role_raw, str) else ""
        if role not in {"user", "assistant"}:
            continue
        content_raw = message.get("content")
        if not isinstance(content_raw, str):
            continue
        content = _normalize_spaces(content_raw)
        if not content:
            continue
        normalized.append((role, content))
    return normalized


def _is_ambiguous_followup_query(query: str) -> bool:
    normalized = _normalize_spaces(_strip_accents(query).lower())
    if not normalized:
        return False
    if _ARTICLE_LIKE_QUERY_RE.search(normalized):
        return False
    if _REFERENCE_LOOKUP_QUERY_RE.search(query):
        return True

    tokens = [token for token in re.split(r"\s+", normalized) if token]
    if not tokens:
        return False

    if len(tokens) <= 8 and any(normalized.startswith(prefix) for prefix in _REWRITE_FOLLOWUP_PREFIXES):
        return True

    marker_count = sum(1 for token in tokens if token in _REWRITE_FOLLOWUP_MARKERS)
    if marker_count == 0:
        return False

    if len(tokens) <= 5:
        return True
    if len(tokens) <= 7 and not _LEGAL_INTENT_HINT_RE.search(normalized):
        return True
    return False


def _build_rewrite_memory_context(
    messages: list[dict[str, Any]],
    original_query: str,
) -> tuple[str, str | None, str | None]:
    normalized_messages = _normalize_chat_messages_for_rewrite(messages)
    if not normalized_messages:
        return "", None, None

    current_query_norm = _normalize_spaces(original_query).lower()
    history_cutoff = len(normalized_messages)
    for idx in range(len(normalized_messages) - 1, -1, -1):
        role, text = normalized_messages[idx]
        if role != "user":
            continue
        if _normalize_spaces(text).lower() == current_query_norm:
            history_cutoff = idx
        break

    history = normalized_messages[:history_cutoff]
    if not history:
        return "", None, None

    recent_history = history[-_REWRITE_MEMORY_MAX_MESSAGES:]
    context_lines: list[str] = []
    for role, text in recent_history:
        label = "Utilisateur" if role == "user" else "Assistant"
        context_lines.append(f"{label}: {_clip_for_log(text, _REWRITE_MEMORY_MAX_LINE_CHARS)}")
    context_text = "\n".join(context_lines)

    history_anchor: str | None = None
    history_topic_hint: str | None = None
    for role, text in reversed(history):
        if role != "user":
            continue
        if history_anchor is None:
            candidate_anchor = _infer_rewrite_domain_anchor(text)
            if candidate_anchor:
                history_anchor = candidate_anchor
        if history_topic_hint is None:
            candidate_topic = _infer_rewrite_topic_hint(text)
            if candidate_topic:
                history_topic_hint = candidate_topic
        if history_anchor and history_topic_hint:
            break

    return context_text, history_anchor, history_topic_hint


def _extract_rewritten_query(content: str, fallback_query: str) -> tuple[str, str]:
    raw = _normalize_spaces(_CODE_FENCE_RE.sub("", content or ""))
    if not raw:
        return fallback_query, "query-rewrite-empty"

    parsed_query: str | None = None
    try:
        maybe_obj = json.loads(raw)
        if isinstance(maybe_obj, dict):
            maybe_query = maybe_obj.get("query")
            if isinstance(maybe_query, str):
                parsed_query = maybe_query
    except json.JSONDecodeError:
        parsed_query = None

    if not parsed_query:
        # Fallback tolerant: accepts "query: ..." or plain text output.
        if ":" in raw:
            _, candidate = raw.split(":", maxsplit=1)
            parsed_query = candidate
        else:
            parsed_query = raw

    rewritten = _normalize_spaces(parsed_query)
    if not rewritten:
        return fallback_query, "query-rewrite-empty"

    if rewritten.startswith('"') and rewritten.endswith('"') and len(rewritten) > 1:
        rewritten = _normalize_spaces(rewritten[1:-1])

    if not rewritten:
        return fallback_query, "query-rewrite-empty"

    if len(rewritten) > 500:
        rewritten = rewritten[:500].rstrip()

    if rewritten.lower() == fallback_query.lower():
        return fallback_query, "query-rewrite-noop"

    return rewritten, "query-rewrite-applied"


async def _rewrite_query_for_rag(
    original_query: str,
    messages: list[dict[str, Any]] | None = None,
    rewrite_enabled_override: bool | None = None,
) -> tuple[str, str | None]:
    if rewrite_enabled_override is None and not settings.rag_query_rewrite_enabled:
        return original_query, "query-rewrite-disabled"
    if rewrite_enabled_override is False:
        return original_query, "query-rewrite-request-disabled"

    rewrite_context_text = ""
    history_anchor = None
    history_topic_hint = None
    if messages:
        rewrite_context_text, history_anchor, history_topic_hint = _build_rewrite_memory_context(
            messages,
            original_query,
        )

    explicit_anchor = _infer_rewrite_domain_anchor(original_query)
    explicit_topic_hint = _infer_rewrite_topic_hint(original_query)
    should_lock_to_history = _is_ambiguous_followup_query(original_query)
    forced_anchor = history_anchor if should_lock_to_history and not explicit_anchor else None
    forced_topic_hint = (
        history_topic_hint if should_lock_to_history and not explicit_topic_hint else None
    )

    definition_query = _definition_rewrite_candidate(original_query)
    if definition_query:
        anchored_definition_query = _enforce_rewrite_anchor_with_lock(
            original_query,
            definition_query,
            forced_anchor=forced_anchor,
            forced_topic_hint=forced_topic_hint,
        )
        suffixes: list[str] = []
        if rewrite_context_text:
            suffixes.append("memory")
        if forced_anchor:
            suffixes.append("domain-lock")
        if forced_topic_hint:
            suffixes.append("topic-lock")
        if anchored_definition_query != definition_query:
            suffixes.append("anchor")
        status = "query-rewrite-definition-intent"
        if suffixes:
            status = f"{status}-{'-'.join(suffixes)}"
        final_definition_query = anchored_definition_query
        sentence_style_query, sentence_style_changed = _ensure_rewrite_sentence_style(
            original_query,
            final_definition_query,
        )
        if sentence_style_changed:
            final_definition_query = _enforce_rewrite_anchor_with_lock(
                original_query,
                sentence_style_query,
                forced_anchor=forced_anchor,
                forced_topic_hint=forced_topic_hint,
            )
            status = f"{status}-sentence-style"
        return final_definition_query, status

    rewrite_model = settings.rag_query_rewrite_model or settings.llm_model
    rewrite_messages: list[dict[str, str]] = [
        {"role": "system", "content": RAG_QUERY_REWRITE_SYSTEM_INSTRUCTIONS},
    ]
    if rewrite_context_text:
        rewrite_messages.append(
            {
                "role": "user",
                "content": (
                    "Contexte recent de la conversation (a utiliser pour conserver le sujet si la question est ambigue):\n"
                    f"{rewrite_context_text}"
                ),
            }
        )

    continuity_lock: list[str] = []
    if forced_anchor:
        continuity_lock.append(f"domaine a conserver: {forced_anchor}")
    if forced_topic_hint:
        continuity_lock.append(f"mot-cle thematique a conserver: {forced_topic_hint}")
    if continuity_lock:
        rewrite_messages.append(
            {
                "role": "user",
                "content": "Contrainte de continuite: " + " ; ".join(continuity_lock),
            }
        )

    rewrite_messages.append({"role": "user", "content": original_query})
    kwargs: dict[str, Any] = {
        "temperature": settings.rag_query_rewrite_temperature,
        "top_p": 1.0,
        "max_tokens": settings.rag_query_rewrite_max_tokens,
        "stream": False,
    }
    if settings.llm_provider == "nvidia":
        kwargs["extra_body"] = {"chat_template_kwargs": {"thinking": False}}

    completion = await client.chat.completions.create(
        model=rewrite_model,
        messages=rewrite_messages,
        **kwargs,
    )

    rewritten_content = ""
    if getattr(completion, "choices", None):
        rewritten_content = _extract_completion_text(getattr(completion.choices[0], "message", None))

    rewritten_query, status = _extract_rewritten_query(rewritten_content, original_query)
    anchored_query = _enforce_rewrite_anchor_with_lock(
        original_query,
        rewritten_query,
        forced_anchor=forced_anchor,
        forced_topic_hint=forced_topic_hint,
    )
    if anchored_query != rewritten_query:
        rewritten_query = anchored_query
        status = f"{status}-anchor"
    rewritten_query, sanction_pruned = _strip_unrequested_sanction_terms_from_rewrite(
        original_query,
        rewritten_query,
    )
    if sanction_pruned:
        rewritten_query = _enforce_rewrite_anchor_with_lock(
            original_query,
            rewritten_query,
            forced_anchor=forced_anchor,
            forced_topic_hint=forced_topic_hint,
        )
        status = f"{status}-sanction-pruned"
    sentence_style_query, sentence_style_changed = _ensure_rewrite_sentence_style(
        original_query,
        rewritten_query,
    )
    if sentence_style_changed:
        rewritten_query = _enforce_rewrite_anchor_with_lock(
            original_query,
            sentence_style_query,
            forced_anchor=forced_anchor,
            forced_topic_hint=forced_topic_hint,
        )
        status = f"{status}-sentence-style"
    if rewrite_context_text:
        status = f"{status}-memory"
    if forced_anchor:
        status = f"{status}-domain-lock"
    if forced_topic_hint:
        status = f"{status}-topic-lock"
    return rewritten_query, status


def _extract_query_for_rag(messages: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    normalized: list[tuple[str | None, str]] = []
    for message in messages:
        role_raw = message.get("role")
        role = role_raw.strip().lower() if isinstance(role_raw, str) else None
        content = message.get("content")
        if not isinstance(content, str):
            continue
        text = content.strip()
        if not text:
            continue
        normalized.append((role, text))

    if not normalized:
        return None, None

    for role, text in reversed(normalized):
        if role == "user":
            return text, "user"

    for role, text in reversed(normalized):
        if role != "assistant":
            return text, "non_assistant_fallback"

    return normalized[-1][1], "last_message_fallback"


def _normalize_messages_for_provider(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if settings.llm_provider != "deepseek":
        return messages
    system_messages: list[dict[str, Any]] = []
    other_messages: list[dict[str, Any]] = []
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "system":
            system_messages.append(message)
        else:
            other_messages.append(message)
    if not system_messages:
        return messages
    return [*system_messages, *other_messages]


def _merge_unique_chunks(chunks: list[Any]) -> list[Any]:
    merged: list[Any] = []
    seen_ids: set[str] = set()
    for chunk in chunks:
        chunk_id = getattr(chunk, "chunk_id", "")
        if not isinstance(chunk_id, str) or not chunk_id:
            continue
        if chunk_id in seen_ids:
            continue
        seen_ids.add(chunk_id)
        merged.append(chunk)
    return merged


_QUERY_COVERAGE_STOPWORDS = {
    "quel", "quels", "quelle", "quelles", "comment", "pourquoi", "parle", "moi",
    "sont", "est", "selon", "avec", "sans", "dans", "sur", "pour", "entre",
    "des", "les", "une", "un", "du", "de", "la", "le", "au", "aux", "en",
    "droit", "code", "senegal", "ohada", "juridique", "article", "articles",
    "sanction", "sanctions", "peine", "peines",
    "applicable", "applicables", "question", "definition",
    "conditions", "regles", "difference", "distinction",
    "elements", "constitutifs", "responsabilite",
}
_QUERY_SHORT_LEGAL_TOKENS = {
    "vol",
    "viol",
    "dol",
    "opj",
    "vih",
}
_QUERY_STRONG_TOKEN_STOPWORDS = {
    "question",
    "regles",
    "conditions",
    "difference",
    "distinction",
    "definition",
    "definit",
    "definir",
    "elements",
    "constitutifs",
    "applicable",
    "applicables",
    "responsabilite",
    "infractions",
    "sanctions",
    "penales",
    "penale",
    "peines",
}
_QUERY_MANDATORY_TOKEN_STOPWORDS = {
    "definition",
    "droit",
    "code",
    "senegal",
    "juridique",
    "article",
    "articles",
    "peine",
    "peines",
    "sanction",
    "sanctions",
    "penal",
    "penale",
    "penales",
    "applicable",
    "applicables",
    "conditions",
    "regles",
    "difference",
    "distinction",
    "elements",
    "constitutifs",
}
_SPECIALIZED_SOURCE_TAG_PATTERNS: dict[str, tuple[str, ...]] = {
    "penalty_execution_decree": (
        "amenagement des sanctions penales",
        "procedures d execution",
        "application des peines",
    ),
    "cyber_special": (
        "cybercriminalite",
        "donnees personnelles",
    ),
    "drug_code": (
        "code des drogues",
    ),
    "lbc_ft": (
        "financement du terrorisme",
        "blanchiment de capitaux",
        "proliferation des armes",
        "lbc ft",
    ),
    "regional_guidance": (
        "bceao/",
        "manuel",
        "guide",
    ),
}
_SPECIALIZED_QUERY_ALLOW_MARKERS: dict[str, tuple[str, ...]] = {
    "penalty_execution_decree": (
        "amenagement des peines",
        "amenagement de peine",
        "execution des peines",
        "application des peines",
        "juge de l application des peines",
        "detenu",
        "detenus",
        "penitentiaire",
        "liberation conditionnelle",
        "milieu ouvert",
        "sursis",
        "probation",
    ),
    "cyber_special": (
        "cyber",
        "numerique",
        "informatique",
        "internet",
        "reseau",
        "donnees",
        "donnees personnelles",
        "systeme d information",
    ),
    "drug_code": (
        "drogue",
        "drogues",
        "stupefiant",
        "stupefiants",
        "chanvre",
        "cannabis",
        "toxicomane",
        "toxicomanie",
    ),
    "lbc_ft": (
        "terrorisme",
        "financement du terrorisme",
        "blanchiment",
        "blanchiment de capitaux",
        "lbc",
        "ft",
        "proliferation",
    ),
    "regional_guidance": (
        "bceao",
        "uemoa",
        "cedeao",
        "union economique",
        "tarif exterieur commun",
        "libre circulation",
        "regulation bancaire",
        "reglementation bancaire",
        "politique monetaire",
    ),
}
_QUERY_FRAGMENT_STOPWORDS = {
    "ement",
    "ements",
    "ation",
    "ations",
    "ition",
    "itions",
    "tion",
    "tions",
    "ment",
    "ments",
    "ance",
    "ances",
    "ence",
    "ences",
    "lement",
}


def _normalize_for_query_coverage(value: str) -> str:
    lowered = _strip_accents(value or "").lower()
    return re.sub(r"[^a-z0-9]+", " ", lowered).strip()


def _light_stem_for_query_coverage(token: str) -> str:
    t = token
    for suffix in (
        "ements",
        "ement",
        "ations",
        "ation",
        "itions",
        "ition",
        "ments",
        "ment",
        "tions",
        "tion",
        "ences",
        "ence",
        "ances",
        "ance",
        "euses",
        "euse",
        "eaux",
        "eau",
        "aires",
        "aire",
        "elles",
        "elle",
        "eurs",
        "eur",
        "ives",
        "ive",
        "ifs",
        "if",
        "ees",
        "ee",
        "es",
        "e",
        "s",
    ):
        if len(t) - len(suffix) >= 4 and t.endswith(suffix):
            t = t[: -len(suffix)]
            break
    t = t.rstrip("aeiouy")
    if len(t) >= 4:
        return t
    return token


def _extract_query_focus_tokens(query: str) -> set[str]:
    normalized = _normalize_for_query_coverage(query)
    if not normalized:
        return set()
    tokens: set[str] = set()
    for token in normalized.split():
        if len(token) < 4 and token not in _QUERY_SHORT_LEGAL_TOKENS:
            continue
        if token in _QUERY_FRAGMENT_STOPWORDS:
            continue
        if token in _QUERY_COVERAGE_STOPWORDS:
            continue
        tokens.add(token)
        stem = _light_stem_for_query_coverage(token)
        if stem in _QUERY_FRAGMENT_STOPWORDS:
            stem = token
        tokens.add(stem)
        if len(token) >= 6:
            tokens.add(token[:6])
        if len(stem) >= 6:
            tokens.add(stem[:6])
    return tokens


def _extract_query_strong_tokens(query: str) -> set[str]:
    normalized = _normalize_for_query_coverage(query)
    if not normalized:
        return set()
    strong_tokens: set[str] = set()
    for token in normalized.split():
        if len(token) < 6:
            continue
        if token in _QUERY_COVERAGE_STOPWORDS or token in _QUERY_STRONG_TOKEN_STOPWORDS:
            continue
        strong_tokens.add(token)
        stem = _light_stem_for_query_coverage(token)
        if len(stem) >= 6:
            strong_tokens.add(stem)
    return strong_tokens


def _extract_query_mandatory_terms(query: str) -> list[str]:
    normalized = _normalize_for_query_coverage(query)
    if not normalized:
        return []
    terms: list[str] = []
    seen: set[str] = set()
    for token in normalized.split():
        if len(token) < 6:
            continue
        if token in _QUERY_FRAGMENT_STOPWORDS:
            continue
        if token in _QUERY_COVERAGE_STOPWORDS or token in _QUERY_MANDATORY_TOKEN_STOPWORDS:
            continue
        term = token
        if term in seen:
            continue
        seen.add(term)
        terms.append(term)
        if len(terms) >= 2:
            break
    return terms


def _chunk_overlap_with_query_tokens(chunk: Any, tokens: set[str]) -> int:
    if not tokens:
        return 0
    haystack = _normalize_for_query_coverage(
        " ".join(
            [
                str(getattr(chunk, "relative_path", "") or ""),
                str(getattr(chunk, "source_path", "") or ""),
                str(getattr(chunk, "article_hint", "") or ""),
                str(getattr(chunk, "text", "") or "")[:1800],
            ]
        )
    )
    if not haystack:
        return 0
    haystack_tokens: set[str] = set()
    for token in haystack.split():
        haystack_tokens.add(token)
        stem = _light_stem_for_query_coverage(token)
        haystack_tokens.add(stem)
        if len(token) >= 6:
            haystack_tokens.add(token[:6])
        if len(stem) >= 6:
            haystack_tokens.add(stem[:6])
    return len(tokens.intersection(haystack_tokens))


def _chunk_matches_mandatory_term(chunk: Any, term: str) -> bool:
    tokens = {term}
    stem = _light_stem_for_query_coverage(term)
    if stem:
        tokens.add(stem)
    if len(term) >= 6:
        tokens.add(term[:6])
    if len(stem) >= 6:
        tokens.add(stem[:6])
    return _chunk_overlap_with_query_tokens(chunk, tokens) >= 1


def _compose_query_coverage_input(original_query: str, retrieval_query: str) -> str:
    original = _normalize_spaces(original_query)
    rewritten = _normalize_spaces(retrieval_query)
    if not original:
        return rewritten
    if not rewritten or rewritten == original:
        return original
    return f"{original} {rewritten}"


def _infer_article_refs_from_candidates(
    candidates: list[Any],
    *,
    original_query: str,
    max_refs: int = 3,
    scan_limit: int = 80,
) -> list[tuple[str, bool]]:
    if not candidates or max_refs < 1:
        return []
    query_tokens = _extract_query_focus_tokens(original_query)
    if len(query_tokens) < 2:
        return []
    overlap_required = 2 if len(query_tokens) >= 3 else 1
    disallowed_tags = {
        tag
        for tag in _SPECIALIZED_SOURCE_TAG_PATTERNS
        if not _query_allows_specialized_tag(original_query, tag)
    }

    ref_scores: dict[str, float] = {}
    ref_hits: dict[str, int] = {}
    for chunk in candidates[:scan_limit]:
        if _chunk_specialization_tags(chunk).intersection(disallowed_tags):
            continue
        overlap = _chunk_overlap_with_query_tokens(chunk, query_tokens)
        if overlap < overlap_required:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        scan_text = " ".join(
            [
                str(getattr(chunk, "article_hint", "") or ""),
                str(getattr(chunk, "text", "") or "")[:1800],
            ]
        )
        if not scan_text:
            continue
        for match in _ARTICLE_REFERENCE_CAPTURE_RE.finditer(scan_text):
            raw_ref = re.sub(r"\s+", " ", (match.group(1) or "").strip().lower())
            if not raw_ref:
                continue
            number_match = re.match(r"^\d{1,3}", raw_ref)
            if not number_match:
                continue
            number_value = int(number_match.group(0))
            if number_value < 2 or number_value > 500:
                continue
            # For inferred refs (query has no explicit article), low article numbers are
            # frequently cross-code noise (Article 3, 23, 42, ...). Keep only stronger anchors.
            if number_value < 50:
                continue
            weight = 1.0 + min(2.0, float(overlap))
            weight += min(1.0, score)
            if _chunk_has_penal_core_signal(chunk):
                weight += 0.5
            ref_scores[raw_ref] = ref_scores.get(raw_ref, 0.0) + weight
            ref_hits[raw_ref] = ref_hits.get(raw_ref, 0) + 1

    if not ref_scores:
        return []
    sorted_refs = sorted(ref_scores.items(), key=lambda item: item[1], reverse=True)
    top_score = sorted_refs[0][1]
    selected: list[tuple[str, bool]] = []
    for ref, score in sorted_refs:
        if score < max(3.5, top_score * 0.55):
            continue
        if ref_hits.get(ref, 0) < 2:
            continue
        selected.append((ref, False))
        if len(selected) >= max_refs:
            break
    return selected


def _chunk_source_key(chunk: Any) -> str:
    source = (
        str(getattr(chunk, "relative_path", "") or "")
        or str(getattr(chunk, "source_path", "") or "")
        or str(getattr(chunk, "doc_id", "") or "")
        or str(getattr(chunk, "chunk_id", "") or "")
    )
    return _normalize_for_query_coverage(source)


def _chunk_specialization_tags(chunk: Any) -> set[str]:
    haystack = _normalize_for_query_coverage(
        " ".join(
            [
                str(getattr(chunk, "relative_path", "") or ""),
                str(getattr(chunk, "source_path", "") or ""),
                str(getattr(chunk, "doc_id", "") or ""),
            ]
        )
    )
    if not haystack:
        return set()
    tags: set[str] = set()
    for tag, markers in _SPECIALIZED_SOURCE_TAG_PATTERNS.items():
        if any(marker in haystack for marker in markers):
            tags.add(tag)
    return tags


def _query_allows_specialized_tag(query: str, tag: str) -> bool:
    markers = _SPECIALIZED_QUERY_ALLOW_MARKERS.get(tag, ())
    if not markers:
        return False
    normalized_query = _normalize_for_query_coverage(query)
    if not normalized_query:
        return False
    return any(marker in normalized_query for marker in markers)


def _extract_query_anchor_path_tokens(query: str) -> set[str]:
    normalized_query = _normalize_for_query_coverage(query)
    if not normalized_query:
        return set()
    anchor_candidates = {
        _normalize_for_query_coverage(anchor)
        for _, anchor in _REWRITE_DOMAIN_ANCHORS
    }
    anchor_candidates.update(
        _normalize_for_query_coverage(anchor)
        for anchor in _REWRITE_ANCHOR_BY_DETECTED_DOMAIN.values()
    )
    anchor_candidates.discard("")
    anchor_stopwords = {
        "code",
        "droit",
        "senegal",
        "ohada",
        "acte",
        "uniforme",
        "general",
        "protection",
        "consommateur",
        "hygiene",
    }
    tokens: set[str] = set()
    for anchor in anchor_candidates:
        if anchor not in normalized_query:
            continue
        for token in anchor.split():
            if len(token) < 5 or token in anchor_stopwords:
                continue
            tokens.add(token)
            stem = _light_stem_for_query_coverage(token)
            tokens.add(stem)
            if len(token) >= 6:
                tokens.add(token[:6])
            if len(stem) >= 6:
                tokens.add(stem[:6])
    return tokens


def _chunk_path_overlap_with_tokens(chunk: Any, tokens: set[str]) -> int:
    if not tokens:
        return 0
    path_text = _normalize_for_query_coverage(
        " ".join(
            [
                str(getattr(chunk, "relative_path", "") or ""),
                str(getattr(chunk, "source_path", "") or ""),
            ]
        )
    )
    if not path_text:
        return 0
    path_tokens: set[str] = set()
    for token in path_text.split():
        path_tokens.add(token)
        stem = _light_stem_for_query_coverage(token)
        path_tokens.add(stem)
        if len(token) >= 6:
            path_tokens.add(token[:6])
        if len(stem) >= 6:
            path_tokens.add(stem[:6])
    return len(tokens.intersection(path_tokens))


def _enforce_query_coverage_diversity(
    selected_chunks: list[Any],
    ranked_candidates: list[Any],
    *,
    original_query: str,
    retrieval_query: str,
    top_k: int,
    min_score_guard: float,
) -> tuple[list[Any], bool]:
    if not selected_chunks or not ranked_candidates or top_k < 1:
        return selected_chunks, False

    query_tokens = _extract_query_focus_tokens(original_query)
    if len(query_tokens) < 2:
        return selected_chunks, False

    source_counts: dict[str, int] = {}
    for chunk in selected_chunks:
        key = _chunk_source_key(chunk)
        source_counts[key] = source_counts.get(key, 0) + 1
    dominant_source, dominant_count = max(source_counts.items(), key=lambda item: item[1])
    if dominant_count < max(3, int(len(selected_chunks) * 0.55)):
        return selected_chunks, False

    selected_ids = {str(getattr(chunk, "chunk_id", "")) for chunk in selected_chunks}
    anchor_tokens = _extract_query_anchor_path_tokens(retrieval_query)
    overlap_min = 1 if len(query_tokens) <= 2 else 2

    def _best_replacement(require_anchor_path_overlap: bool) -> Any | None:
        replacement_local: Any | None = None
        replacement_overlap_local = 0
        replacement_path_overlap_local = 0
        replacement_score_local = float("-inf")
        for chunk in ranked_candidates:
            chunk_id = str(getattr(chunk, "chunk_id", ""))
            if not chunk_id or chunk_id in selected_ids:
                continue
            if _chunk_source_key(chunk) == dominant_source:
                continue
            overlap = _chunk_overlap_with_query_tokens(chunk, query_tokens)
            if overlap < overlap_min:
                continue
            score = float(getattr(chunk, "score", 0.0) or 0.0)
            if score < min_score_guard:
                continue
            path_overlap = (
                _chunk_path_overlap_with_tokens(chunk, anchor_tokens) if anchor_tokens else 0
            )
            if require_anchor_path_overlap and anchor_tokens and path_overlap <= 0:
                continue
            if (overlap, path_overlap, score) > (
                replacement_overlap_local,
                replacement_path_overlap_local,
                replacement_score_local,
            ):
                replacement_local = chunk
                replacement_overlap_local = overlap
                replacement_path_overlap_local = path_overlap
                replacement_score_local = score
        return replacement_local

    replacement: Any | None = _best_replacement(require_anchor_path_overlap=True)
    if replacement is None:
        replacement = _best_replacement(require_anchor_path_overlap=False)

    if replacement is None:
        return selected_chunks, False

    replace_idx: int | None = None
    replace_score = float("inf")
    for idx, chunk in enumerate(selected_chunks):
        if _chunk_source_key(chunk) != dominant_source:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < replace_score:
            replace_score = score
            replace_idx = idx
    if replace_idx is None:
        return selected_chunks, False

    updated = list(selected_chunks)
    updated[replace_idx] = replacement
    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _promote_anchor_path_chunk(
    selected_chunks: list[Any],
    *,
    retrieval_query: str,
    top_k: int,
) -> tuple[list[Any], bool]:
    if not selected_chunks or len(selected_chunks) < 2 or top_k < 1:
        return selected_chunks, False

    anchor_tokens = _extract_query_anchor_path_tokens(retrieval_query)
    if not anchor_tokens:
        return selected_chunks, False

    best_idx = -1
    best_key = (-1, float("-inf"))
    for idx, chunk in enumerate(selected_chunks):
        path_overlap = _chunk_path_overlap_with_tokens(chunk, anchor_tokens)
        if path_overlap <= 0:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        key = (path_overlap, score)
        if key > best_key:
            best_key = key
            best_idx = idx

    if best_idx <= 1:
        return selected_chunks, False

    updated = list(selected_chunks)
    promoted = updated.pop(best_idx)
    updated.insert(1, promoted)
    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _enforce_anchor_path_coverage(
    selected_chunks: list[Any],
    ranked_candidates: list[Any],
    *,
    original_query: str,
    retrieval_query: str,
    top_k: int,
    min_score_guard: float,
) -> tuple[list[Any], bool]:
    if not selected_chunks or not ranked_candidates or top_k < 1:
        return selected_chunks, False

    anchor_tokens = _extract_query_anchor_path_tokens(retrieval_query)
    if not anchor_tokens:
        return selected_chunks, False
    query_tokens = _extract_query_focus_tokens(original_query)

    for chunk in selected_chunks:
        if _chunk_path_overlap_with_tokens(chunk, anchor_tokens) <= 0:
            continue
        if not query_tokens:
            return selected_chunks, False
        if _chunk_overlap_with_query_tokens(chunk, query_tokens) >= 1:
            return selected_chunks, False

    selected_ids = {str(getattr(chunk, "chunk_id", "")) for chunk in selected_chunks}
    replacement: Any | None = None
    replacement_focus_overlap = -1
    replacement_path_overlap = -1
    replacement_score = float("-inf")
    for chunk in ranked_candidates:
        chunk_id = str(getattr(chunk, "chunk_id", ""))
        if not chunk_id or chunk_id in selected_ids:
            continue
        path_overlap = _chunk_path_overlap_with_tokens(chunk, anchor_tokens)
        if path_overlap <= 0:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < min_score_guard:
            continue
        focus_overlap = (
            _chunk_overlap_with_query_tokens(chunk, query_tokens) if query_tokens else 0
        )
        key = (focus_overlap, path_overlap, score)
        best_key = (replacement_focus_overlap, replacement_path_overlap, replacement_score)
        if key > best_key:
            replacement = chunk
            replacement_focus_overlap = focus_overlap
            replacement_path_overlap = path_overlap
            replacement_score = score

    if replacement is None:
        return selected_chunks, False

    replace_idx: int | None = None
    replace_score = float("inf")
    for idx, chunk in enumerate(selected_chunks):
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < replace_score:
            replace_score = score
            replace_idx = idx
    if replace_idx is None:
        return selected_chunks, False

    updated = list(selected_chunks)
    updated[replace_idx] = replacement
    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _enforce_query_focus_coverage(
    selected_chunks: list[Any],
    ranked_candidates: list[Any],
    *,
    original_query: str,
    top_k: int,
    min_score_guard: float,
) -> tuple[list[Any], bool]:
    if not selected_chunks or not ranked_candidates or top_k < 1:
        return selected_chunks, False

    query_tokens = _extract_query_focus_tokens(original_query)
    if len(query_tokens) < 2:
        return selected_chunks, False

    selected_best_overlap = 0
    for chunk in selected_chunks:
        selected_best_overlap = max(
            selected_best_overlap,
            _chunk_overlap_with_query_tokens(chunk, query_tokens),
        )
    if selected_best_overlap >= 2:
        return selected_chunks, False

    selected_ids = {str(getattr(chunk, "chunk_id", "")) for chunk in selected_chunks}
    candidate: Any | None = None
    candidate_overlap = 0
    candidate_score = float("-inf")
    for chunk in ranked_candidates:
        chunk_id = str(getattr(chunk, "chunk_id", ""))
        if not chunk_id or chunk_id in selected_ids:
            continue
        overlap = _chunk_overlap_with_query_tokens(chunk, query_tokens)
        if overlap < 2:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < min_score_guard:
            continue
        if (overlap, score) > (candidate_overlap, candidate_score):
            candidate = chunk
            candidate_overlap = overlap
            candidate_score = score

    if candidate is None:
        return selected_chunks, False

    replace_idx: int | None = None
    replace_score = float("inf")
    for idx, chunk in enumerate(selected_chunks):
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < replace_score:
            replace_score = score
            replace_idx = idx
    if replace_idx is None:
        return selected_chunks, False

    updated = list(selected_chunks)
    updated[replace_idx] = candidate
    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _enforce_query_focus_minimum_coverage(
    selected_chunks: list[Any],
    ranked_candidates: list[Any],
    *,
    original_query: str,
    top_k: int,
    min_score_guard: float,
) -> tuple[list[Any], bool]:
    if not selected_chunks or not ranked_candidates or top_k < 1:
        return selected_chunks, False

    query_tokens = _extract_query_focus_tokens(original_query)
    if len(query_tokens) < 2:
        return selected_chunks, False

    overlap_by_id: dict[str, int] = {}

    def _overlap(chunk: Any) -> int:
        chunk_id = str(getattr(chunk, "chunk_id", ""))
        if not chunk_id:
            return 0
        cached = overlap_by_id.get(chunk_id)
        if cached is not None:
            return cached
        value = _chunk_overlap_with_query_tokens(chunk, query_tokens)
        overlap_by_id[chunk_id] = value
        return value

    selected_with_meta: list[tuple[int, int, float, Any]] = []
    covered = 0
    coverage_required_overlap = 2 if len(query_tokens) >= 3 else 1
    for idx, chunk in enumerate(selected_chunks):
        ov = _overlap(chunk)
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        selected_with_meta.append((idx, ov, score, chunk))
        if ov >= coverage_required_overlap:
            covered += 1

    minimum_covered = max(3, int(round(len(selected_chunks) * 0.8)))
    minimum_covered = min(len(selected_chunks), minimum_covered)
    if covered >= minimum_covered:
        return selected_chunks, False

    selected_ids = {str(getattr(chunk, "chunk_id", "")) for chunk in selected_chunks}
    replacement_candidates: list[tuple[int, float, Any]] = []
    for chunk in ranked_candidates:
        chunk_id = str(getattr(chunk, "chunk_id", ""))
        if not chunk_id or chunk_id in selected_ids:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < min_score_guard:
            continue
        ov = _overlap(chunk)
        if ov < coverage_required_overlap:
            continue
        replacement_candidates.append((ov, score, chunk))
    if not replacement_candidates:
        return selected_chunks, False

    replacement_candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    replace_targets = [
        (idx, score, chunk)
        for idx, ov, score, chunk in selected_with_meta
        if ov < coverage_required_overlap
    ]
    replace_targets.sort(key=lambda item: item[1])
    if not replace_targets:
        return selected_chunks, False

    updated = list(selected_chunks)
    replaced = False
    used_candidate_ids: set[str] = set()
    target_cursor = 0
    for ov, score, candidate in replacement_candidates:
        if covered >= minimum_covered:
            break
        while target_cursor < len(replace_targets):
            replace_idx, _, replace_chunk = replace_targets[target_cursor]
            target_cursor += 1
            replace_chunk_id = str(getattr(replace_chunk, "chunk_id", ""))
            candidate_id = str(getattr(candidate, "chunk_id", ""))
            if not candidate_id or candidate_id in used_candidate_ids:
                continue
            if replace_chunk_id == candidate_id:
                continue
            updated[replace_idx] = candidate
            used_candidate_ids.add(candidate_id)
            covered += 1
            replaced = True
            break

    if not replaced:
        return selected_chunks, False

    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _enforce_strong_token_coverage(
    selected_chunks: list[Any],
    ranked_candidates: list[Any],
    *,
    original_query: str,
    top_k: int,
    min_score_guard: float,
) -> tuple[list[Any], bool]:
    if not selected_chunks or not ranked_candidates or top_k < 1:
        return selected_chunks, False

    strong_tokens = _extract_query_strong_tokens(original_query)
    if not strong_tokens:
        return selected_chunks, False

    selected_with_meta: list[tuple[int, int, float, Any]] = []
    covered = 0
    for idx, chunk in enumerate(selected_chunks):
        overlap = _chunk_overlap_with_query_tokens(chunk, strong_tokens)
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        selected_with_meta.append((idx, overlap, score, chunk))
        if overlap >= 1:
            covered += 1

    min_required = 1 if len(strong_tokens) <= 2 else 2
    min_required = min(len(selected_chunks), min_required)
    if covered >= min_required:
        return selected_chunks, False

    selected_ids = {str(getattr(chunk, "chunk_id", "")) for chunk in selected_chunks}
    candidates: list[tuple[int, float, Any]] = []
    for chunk in ranked_candidates:
        chunk_id = str(getattr(chunk, "chunk_id", ""))
        if not chunk_id or chunk_id in selected_ids:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < min_score_guard:
            continue
        overlap = _chunk_overlap_with_query_tokens(chunk, strong_tokens)
        if overlap < 1:
            continue
        candidates.append((overlap, score, chunk))
    if not candidates:
        return selected_chunks, False

    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    replace_targets = [
        (idx, score, chunk)
        for idx, overlap, score, chunk in selected_with_meta
        if overlap == 0
    ]
    replace_targets.sort(key=lambda item: item[1])
    if not replace_targets:
        return selected_chunks, False

    updated = list(selected_chunks)
    replaced = False
    target_cursor = 0
    for _, _, candidate in candidates:
        if covered >= min_required:
            break
        if target_cursor >= len(replace_targets):
            break
        replace_idx, _, _ = replace_targets[target_cursor]
        target_cursor += 1
        updated[replace_idx] = candidate
        covered += 1
        replaced = True

    if not replaced:
        return selected_chunks, False
    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _enforce_mandatory_term_coverage(
    selected_chunks: list[Any],
    ranked_candidates: list[Any],
    *,
    original_query: str,
    top_k: int,
    min_score_guard: float,
) -> tuple[list[Any], bool]:
    if not selected_chunks or not ranked_candidates or top_k < 1:
        return selected_chunks, False

    mandatory_terms = _extract_query_mandatory_terms(original_query)
    if not mandatory_terms:
        return selected_chunks, False

    missing_terms: list[str] = []
    for term in mandatory_terms:
        if any(_chunk_matches_mandatory_term(chunk, term) for chunk in selected_chunks):
            continue
        missing_terms.append(term)
    if not missing_terms:
        return selected_chunks, False

    selected_ids = {str(getattr(chunk, "chunk_id", "")) for chunk in selected_chunks}
    updated = list(selected_chunks)
    changed = False

    for term in missing_terms:
        candidate: Any | None = None
        candidate_score = float("-inf")
        for score_guard in (min_score_guard, 0.0):
            for chunk in ranked_candidates:
                chunk_id = str(getattr(chunk, "chunk_id", ""))
                if not chunk_id or chunk_id in selected_ids:
                    continue
                score = float(getattr(chunk, "score", 0.0) or 0.0)
                if score < score_guard:
                    continue
                if not _chunk_matches_mandatory_term(chunk, term):
                    continue
                if score > candidate_score:
                    candidate = chunk
                    candidate_score = score
            if candidate is not None:
                break
        if candidate is None:
            continue

        term_counts: dict[str, int] = {key: 0 for key in mandatory_terms}
        chunk_term_map: list[set[str]] = []
        for chunk in updated:
            matched_terms = {key for key in mandatory_terms if _chunk_matches_mandatory_term(chunk, key)}
            chunk_term_map.append(matched_terms)
            for matched in matched_terms:
                term_counts[matched] = term_counts.get(matched, 0) + 1

        replace_idx: int | None = None
        replace_score = float("inf")
        for idx, (chunk, matched_terms) in enumerate(zip(updated, chunk_term_map)):
            if term in matched_terms:
                continue
            # Keep unique holders of already-covered mandatory terms.
            if any(term_counts.get(existing, 0) <= 1 for existing in matched_terms):
                continue
            score = float(getattr(chunk, "score", 0.0) or 0.0)
            if score < replace_score:
                replace_score = score
                replace_idx = idx
        if replace_idx is None:
            for idx, chunk in enumerate(updated):
                if _chunk_matches_mandatory_term(chunk, term):
                    continue
                score = float(getattr(chunk, "score", 0.0) or 0.0)
                if score < replace_score:
                    replace_score = score
                    replace_idx = idx
        if replace_idx is None:
            continue

        updated[replace_idx] = candidate
        selected_ids.add(str(getattr(candidate, "chunk_id", "")))
        changed = True

    if not changed:
        return selected_chunks, False
    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _query_has_sanction_intent(query: str) -> bool:
    normalized = _normalize_for_query_coverage(query)
    if not normalized:
        return False
    return any(
        marker in normalized
        for marker in (
            "peine",
            "peines",
            "sanction",
            "sanctions",
            "amende",
            "emprisonnement",
            "risque",
            "encourt",
            "puni",
        )
    )


def _chunk_penalty_signal(chunk: Any) -> int:
    haystack = _normalize_for_query_coverage(
        " ".join(
            [
                str(getattr(chunk, "article_hint", "") or ""),
                str(getattr(chunk, "text", "") or "")[:1800],
            ]
        )
    )
    if not haystack:
        return 0
    signal = 0
    for marker in ("amende", "emprisonnement", "peine", "peines", "puni", "punie", "punis"):
        if marker in haystack:
            signal += 1
    if re.search(r"\b\d+\s*(?:ans?|mois|francs?|f)\b", haystack):
        signal += 1
    return signal


def _chunk_sanction_path_signal(chunk: Any) -> int:
    haystack = _normalize_for_query_coverage(
        " ".join(
            [
                str(getattr(chunk, "relative_path", "") or ""),
                str(getattr(chunk, "source_path", "") or ""),
                str(getattr(chunk, "doc_id", "") or ""),
            ]
        )
    )
    if not haystack:
        return 0
    signal = 0
    if "sanction" in haystack:
        signal += 1
    if "amenagement des sanctions" in haystack:
        signal += 1
    if "sanctions penales" in haystack:
        signal += 1
    if "peine" in haystack:
        signal += 1
    return signal


def _enforce_sanction_intent_coverage(
    selected_chunks: list[Any],
    ranked_candidates: list[Any],
    *,
    original_query: str,
    top_k: int,
    min_score_guard: float,
) -> tuple[list[Any], bool]:
    if not selected_chunks or not ranked_candidates or top_k < 1:
        return selected_chunks, False
    if not _query_has_sanction_intent(original_query):
        return selected_chunks, False

    query_tokens = _extract_query_focus_tokens(original_query)
    for chunk in selected_chunks:
        focus_overlap = (
            _chunk_overlap_with_query_tokens(chunk, query_tokens) if query_tokens else 0
        )
        if focus_overlap >= 1 and _chunk_penalty_signal(chunk) >= 2:
            return selected_chunks, False

    selected_ids = {str(getattr(chunk, "chunk_id", "")) for chunk in selected_chunks}
    replacement: Any | None = None
    replacement_focus_overlap = -1
    replacement_penalty_signal = -1
    replacement_score = float("-inf")
    for chunk in ranked_candidates:
        chunk_id = str(getattr(chunk, "chunk_id", ""))
        if not chunk_id or chunk_id in selected_ids:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < min_score_guard:
            continue
        focus_overlap = (
            _chunk_overlap_with_query_tokens(chunk, query_tokens) if query_tokens else 0
        )
        if focus_overlap < 1:
            continue
        penalty_signal = _chunk_penalty_signal(chunk)
        if penalty_signal < 1:
            continue
        key = (focus_overlap, penalty_signal, score)
        best_key = (replacement_focus_overlap, replacement_penalty_signal, replacement_score)
        if key > best_key:
            replacement = chunk
            replacement_focus_overlap = focus_overlap
            replacement_penalty_signal = penalty_signal
            replacement_score = score

    if replacement is None:
        return selected_chunks, False

    replace_idx: int | None = None
    replace_score = float("inf")
    for idx, chunk in enumerate(selected_chunks):
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < replace_score:
            replace_score = score
            replace_idx = idx
    if replace_idx is None:
        return selected_chunks, False

    updated = list(selected_chunks)
    updated[replace_idx] = replacement
    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _deprioritize_sanction_chunks_without_intent(
    selected_chunks: list[Any],
    ranked_candidates: list[Any],
    *,
    original_query: str,
    top_k: int,
    min_score_guard: float,
) -> tuple[list[Any], bool]:
    if not selected_chunks or not ranked_candidates or top_k < 1:
        return selected_chunks, False
    if _query_has_sanction_intent(original_query):
        return selected_chunks, False

    query_tokens = _extract_query_focus_tokens(original_query)
    if not query_tokens:
        return selected_chunks, False

    replace_targets: list[tuple[int, int, float]] = []
    for idx, chunk in enumerate(selected_chunks):
        penalty_signal = _chunk_penalty_signal(chunk)
        path_signal = _chunk_sanction_path_signal(chunk)
        if penalty_signal < 1 and path_signal < 2:
            continue
        overlap = _chunk_overlap_with_query_tokens(chunk, query_tokens)
        if overlap > 0:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        replace_targets.append((idx, penalty_signal + path_signal, score))
    if not replace_targets:
        return selected_chunks, False

    selected_ids = {str(getattr(chunk, "chunk_id", "")) for chunk in selected_chunks}
    replacement_pool: list[tuple[int, float, int, Any]] = []
    for chunk in ranked_candidates:
        chunk_id = str(getattr(chunk, "chunk_id", ""))
        if not chunk_id or chunk_id in selected_ids:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < min_score_guard:
            continue
        overlap = _chunk_overlap_with_query_tokens(chunk, query_tokens)
        if overlap < 1:
            continue
        penalty_signal = _chunk_penalty_signal(chunk)
        if penalty_signal > 1:
            continue
        replacement_pool.append((overlap, score, penalty_signal, chunk))
    if not replacement_pool:
        return selected_chunks, False

    replace_targets.sort(key=lambda item: (item[1], -item[2]), reverse=True)
    replacement_pool.sort(key=lambda item: (item[0], item[1], -item[2]), reverse=True)

    updated = list(selected_chunks)
    used_chunk_ids: set[str] = set()
    changed = False
    replacement_cursor = 0
    for target_idx, _, _ in replace_targets:
        while replacement_cursor < len(replacement_pool):
            _, _, _, candidate = replacement_pool[replacement_cursor]
            replacement_cursor += 1
            candidate_id = str(getattr(candidate, "chunk_id", ""))
            if not candidate_id or candidate_id in used_chunk_ids:
                continue
            updated[target_idx] = candidate
            used_chunk_ids.add(candidate_id)
            changed = True
            break

    if not changed:
        return selected_chunks, False
    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _deprioritize_specialized_mismatch_chunks(
    selected_chunks: list[Any],
    ranked_candidates: list[Any],
    *,
    original_query: str,
    top_k: int,
    min_score_guard: float,
) -> tuple[list[Any], bool]:
    if not selected_chunks or not ranked_candidates or top_k < 1:
        return selected_chunks, False

    disallowed_tags = {
        tag
        for tag in _SPECIALIZED_SOURCE_TAG_PATTERNS
        if not _query_allows_specialized_tag(original_query, tag)
    }
    if not disallowed_tags:
        return selected_chunks, False

    query_tokens = _extract_query_focus_tokens(original_query)
    selected_ids = {str(getattr(chunk, "chunk_id", "")) for chunk in selected_chunks}

    replace_targets: list[tuple[int, float, Any]] = []
    for idx, chunk in enumerate(selected_chunks):
        tags = _chunk_specialization_tags(chunk)
        if not tags.intersection(disallowed_tags):
            continue
        overlap = _chunk_overlap_with_query_tokens(chunk, query_tokens) if query_tokens else 0
        if overlap >= 2:
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        replace_targets.append((idx, score, chunk))
    if not replace_targets:
        return selected_chunks, False

    replacement_candidates: list[tuple[int, float, Any]] = []
    for chunk in ranked_candidates:
        chunk_id = str(getattr(chunk, "chunk_id", ""))
        if not chunk_id or chunk_id in selected_ids:
            continue
        tags = _chunk_specialization_tags(chunk)
        if tags.intersection(disallowed_tags):
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < min_score_guard:
            continue
        overlap = _chunk_overlap_with_query_tokens(chunk, query_tokens) if query_tokens else 0
        if query_tokens and overlap < 1:
            continue
        replacement_candidates.append((overlap, score, chunk))
    if not replacement_candidates:
        return selected_chunks, False

    replace_targets.sort(key=lambda item: item[1])
    replacement_candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    updated = list(selected_chunks)
    used_ids: set[str] = set()
    changed = False
    replacement_cursor = 0
    for idx, _, _ in replace_targets:
        while replacement_cursor < len(replacement_candidates):
            _, _, candidate = replacement_candidates[replacement_cursor]
            replacement_cursor += 1
            candidate_id = str(getattr(candidate, "chunk_id", ""))
            if not candidate_id or candidate_id in used_ids:
                continue
            updated[idx] = candidate
            used_ids.add(candidate_id)
            changed = True
            break

    if not changed:
        return selected_chunks, False
    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _chunk_has_penal_core_signal(chunk: Any) -> bool:
    haystack = _normalize_for_query_coverage(
        " ".join(
            [
                str(getattr(chunk, "relative_path", "") or ""),
                str(getattr(chunk, "source_path", "") or ""),
                str(getattr(chunk, "article_hint", "") or ""),
                str(getattr(chunk, "text", "") or "")[:1200],
            ]
        )
    )
    if not haystack:
        return False
    return (
        "code penal" in haystack
        or "droit penal" in haystack
        or "portant code penal" in haystack
    )


def _enforce_penal_core_coverage(
    selected_chunks: list[Any],
    ranked_candidates: list[Any],
    *,
    retrieval_query: str,
    original_query: str,
    top_k: int,
    min_score_guard: float,
) -> tuple[list[Any], bool]:
    if not selected_chunks or not ranked_candidates or top_k < 1:
        return selected_chunks, False

    normalized_query = _normalize_for_query_coverage(f"{retrieval_query} {original_query}")
    if "penal" not in normalized_query:
        return selected_chunks, False

    query_tokens = _extract_query_focus_tokens(original_query)
    for chunk in selected_chunks:
        if not _chunk_has_penal_core_signal(chunk):
            continue
        if not query_tokens or _chunk_overlap_with_query_tokens(chunk, query_tokens) >= 1:
            return selected_chunks, False

    selected_ids = {str(getattr(chunk, "chunk_id", "")) for chunk in selected_chunks}
    candidate: Any | None = None
    candidate_overlap = -1
    candidate_score = float("-inf")
    for chunk in ranked_candidates:
        chunk_id = str(getattr(chunk, "chunk_id", ""))
        if not chunk_id or chunk_id in selected_ids:
            continue
        if not _chunk_has_penal_core_signal(chunk):
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < min_score_guard:
            continue
        overlap = (
            _chunk_overlap_with_query_tokens(chunk, query_tokens) if query_tokens else 0
        )
        if query_tokens and overlap < 1:
            continue
        if (overlap, score) > (candidate_overlap, candidate_score):
            candidate = chunk
            candidate_overlap = overlap
            candidate_score = score

    if candidate is None:
        return selected_chunks, False

    replace_idx: int | None = None
    replace_score = float("inf")
    for idx, chunk in enumerate(selected_chunks):
        if _chunk_has_penal_core_signal(chunk):
            continue
        score = float(getattr(chunk, "score", 0.0) or 0.0)
        if score < replace_score:
            replace_score = score
            replace_idx = idx
    if replace_idx is None:
        return selected_chunks, False

    updated = list(selected_chunks)
    updated[replace_idx] = candidate
    updated = _merge_unique_chunks(updated)
    if len(updated) > top_k:
        updated = updated[:top_k]
    return updated, True


def _normalize_workspace_file_ids(file_ids: list[str] | None) -> set[str]:
    if not file_ids:
        return set()
    normalized: set[str] = set()
    for raw in file_ids:
        value = str(raw or "").strip()
        if not value:
            continue
        normalized.add(value[:128])
    return normalized


def _workspace_chunk_file_id(chunk: Any) -> str | None:
    doc_id = getattr(chunk, "doc_id", "")
    if not isinstance(doc_id, str):
        return None
    if not doc_id.startswith("workspace:"):
        return None
    file_id = doc_id.split("workspace:", 1)[1].strip()
    return file_id or None


def _filter_workspace_candidates_by_file_ids(
    candidates: list[Any],
    allowed_file_ids: set[str],
) -> list[Any]:
    if not allowed_file_ids:
        return candidates
    filtered: list[Any] = []
    for chunk in candidates:
        file_id = _workspace_chunk_file_id(chunk)
        if file_id and file_id in allowed_file_ids:
            filtered.append(chunk)
    return filtered


def _renumber_chunks_for_context(chunks: list[Any]) -> list[Any]:
    renumbered: list[Any] = []
    for index, chunk in enumerate(chunks, start=1):
        try:
            cloned = chunk.__class__(
                rank=index,
                score=float(getattr(chunk, "score", 0.0)),
                chunk_id=str(getattr(chunk, "chunk_id", "")),
                text=str(getattr(chunk, "text", "")),
                doc_id=getattr(chunk, "doc_id", None),
                relative_path=getattr(chunk, "relative_path", None),
                source_path=getattr(chunk, "source_path", None),
                page_start=getattr(chunk, "page_start", None),
                page_end=getattr(chunk, "page_end", None),
                article_hint=getattr(chunk, "article_hint", None),
            )
        except Exception:
            continue
        renumbered.append(cloned)
    return renumbered


# ---------------------------------------------------------------------------
# Preparation du contexte RAG
# ---------------------------------------------------------------------------
async def _prepare_messages_with_rag(
    messages: list[dict[str, Any]],
    rewrite_enabled_override: bool | None = None,
    workspace_only: bool = False,
    workspace_file_ids: list[str] | None = None,
    rag_target_min_chunks_override: int | None = None,
    rag_target_max_chunks_override: int | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None, str | None]:
    if not settings.rag_enabled:
        return messages, [], None, None

    original_query, query_source = _extract_query_for_rag(messages)
    if not original_query:
        return messages, [], "RAG skipped: no usable message found.", None
    if _is_small_talk_query(original_query):
        rag_notes: list[str] = ["rag-skip-smalltalk"]
        if query_source and query_source != "user":
            rag_notes.append(f"RAG query source={query_source}")
        return messages, [], None, " | ".join(rag_notes)
    retrieval_query, query_rewrite_status = await _rewrite_query_for_rag(
        original_query,
        messages=messages,
        rewrite_enabled_override=rewrite_enabled_override,
    )
    _emit_rewrite_trace(
        query_rewrite_status or "query-rewrite-disabled",
        original_query,
        retrieval_query,
    )
    coverage_query = _compose_query_coverage_input(original_query, retrieval_query)

    try:
        from backend.retrieval import (
            detect_query_domains,
            enforce_article_reference_coverage,
            extract_query_article_refs,
            filter_candidates_by_query_domains,
            filter_by_score_threshold,
            format_retrieval_context,
            rerank_article_aware,
            score_context_relevance,
            select_chunks_adaptive,
        )
    except Exception as exc:  # noqa: BLE001
        detail = f"RAG retrieval backend unavailable: {type(exc).__name__}: {exc}"
        logger.exception(detail)
        return messages, [], detail, "retrieval-unavailable"

    try:
        retriever = get_retriever()
    except Exception as exc:  # noqa: BLE001
        detail = f"RAG retriever init failed: {type(exc).__name__}: {exc}"
        logger.exception(detail)
        return messages, [], detail, "retrieval-unavailable"
    # Les refs d'articles sont extraites depuis la query originale
    # (les numeros d'articles sont dans la question de l'utilisateur)
    article_refs = extract_query_article_refs(original_query)
    article_refs_for_selection = list(article_refs)
    exact_query_domains: list[str] = []
    if not workspace_only and settings.rag_domain_filter_enabled:
        exact_query_domains = detect_query_domains(retrieval_query)

    reranker_applied = False
    reranker_error: str | None = None
    rerank_applied = False
    domain_filter_applied = False
    domain_filter_query_domains: list[str] = []
    domain_filter_in_domain_count = 0
    coverage_applied = False
    anchor_path_coverage_applied = False
    anchor_path_promoted = False
    sanction_intent_coverage_applied = False
    sanction_no_intent_deprioritized = False
    specialized_mismatch_deprioritized = False
    penal_core_coverage_applied = False
    query_coverage_diversity_applied = False
    query_focus_coverage_applied = False
    query_focus_minimum_coverage_applied = False
    strong_token_coverage_applied = False
    mandatory_term_coverage_applied = False
    mandatory_term_lock_applied = False
    query_focus_minimum_lock_applied = False
    specialized_mismatch_lock_applied = False
    inferred_article_refs_applied = False
    article_coverage_lock_applied = False
    query_focus_retrieval_used = False
    threshold_start = settings.rag_min_score_threshold
    threshold_final = threshold_start
    adaptive_iterations = 0
    neutral_added = 0
    removed_by_threshold = 0
    workspace_candidate_count = 0
    allowed_workspace_file_ids = _normalize_workspace_file_ids(workspace_file_ids)
    direct_workspace_chunks: list[Any] = []
    direct_workspace_chunk_count = 0
    effective_target_max_chunks = settings.rag_target_max_chunks
    if isinstance(rag_target_max_chunks_override, int) and rag_target_max_chunks_override > 0:
        effective_target_max_chunks = min(settings.rag_target_max_chunks, rag_target_max_chunks_override)
    effective_target_min_chunks = settings.rag_target_min_chunks
    if isinstance(rag_target_min_chunks_override, int) and rag_target_min_chunks_override > 0:
        effective_target_min_chunks = min(effective_target_max_chunks, rag_target_min_chunks_override)
    if effective_target_min_chunks > effective_target_max_chunks:
        effective_target_min_chunks = effective_target_max_chunks

    if allowed_workspace_file_ids:
        try:
            direct_workspace_chunks = get_workspace_rag_index().get_chunks_for_files(
                sorted(allowed_workspace_file_ids),
                max_chunks=max(effective_target_max_chunks * 4, 32),
            )
            direct_workspace_chunk_count = len(direct_workspace_chunks)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Workspace direct context failed: %s: %s",
                type(exc).__name__,
                exc,
            )

    try:
        reranker_enabled = settings.rag_reranker_enabled
        adaptive_threshold_enabled = settings.rag_adaptive_threshold_enabled

        reranker_pool_size = (
            settings.rag_reranker_pool_size if reranker_enabled else settings.rag_top_k
        )
        candidate_pool_size = max(
            settings.rag_top_k,
            settings.rag_top_k * RAG_RETRIEVAL_OVERFETCH_FACTOR,
            reranker_pool_size,
            effective_target_max_chunks,
            320,
        )
        # Recherche RAG: fusion requete reformulee + requete originale
        # pour eviter une perte de rappel quand la reformulation est trop restrictive.
        if workspace_only:
            retrieved_candidates = []
            retrieved_candidates_rewrite: list[Any] = []
            retrieved_candidates_original: list[Any] = []
            retrieved_candidates_focus: list[Any] = []
        else:
            retrieved_candidates_rewrite = retriever.search_hybrid(
                query=retrieval_query,
                top_k=candidate_pool_size,
                candidate_pool_size=candidate_pool_size,
            )
            normalized_retrieval_query = _normalize_spaces(_strip_accents(retrieval_query).lower())
            normalized_original_query = _normalize_spaces(_strip_accents(original_query).lower())
            if normalized_retrieval_query != normalized_original_query:
                retrieved_candidates_original = retriever.search_hybrid(
                    query=original_query,
                    top_k=max(settings.rag_top_k, candidate_pool_size // 2),
                    candidate_pool_size=candidate_pool_size,
                )
            else:
                retrieved_candidates_original = []
            focus_tokens = sorted(_extract_query_focus_tokens(original_query))
            if len(focus_tokens) >= 2:
                focus_query = " ".join(focus_tokens[:12])
                normalized_focus_query = _normalize_spaces(_strip_accents(focus_query).lower())
                if normalized_focus_query not in {
                    normalized_original_query,
                    normalized_retrieval_query,
                }:
                    retrieved_candidates_focus = retriever.search_hybrid(
                        query=focus_query,
                        top_k=max(settings.rag_top_k, candidate_pool_size // 2),
                        candidate_pool_size=candidate_pool_size,
                    )
                    query_focus_retrieval_used = bool(retrieved_candidates_focus)
                else:
                    retrieved_candidates_focus = []
            else:
                retrieved_candidates_focus = []
            retrieved_candidates = _merge_unique_chunks(
                retrieved_candidates_rewrite + retrieved_candidates_original + retrieved_candidates_focus
            )
        include_workspace_candidates = workspace_only or bool(allowed_workspace_file_ids)
        if include_workspace_candidates:
            workspace_candidates = get_workspace_rag_index().search(
                query=retrieval_query,
                top_k=max(effective_target_max_chunks, settings.rag_top_k),
            )
            workspace_candidates = _filter_workspace_candidates_by_file_ids(
                workspace_candidates,
                allowed_workspace_file_ids,
            )
        else:
            workspace_candidates = []
        workspace_candidate_count = len(workspace_candidates)
        # Recherche exacte des articles mentionnes dans la query originale
        exact_matches_by_ref = (
            {}
            if workspace_only
            else retriever.find_exact_article_matches(
                query=coverage_query,
                refs=article_refs,
                per_ref_limit=12,
                allowed_domains=exact_query_domains,
                strict_domain=False,
                allow_neutral_when_filtered=True,
            )
        )
        exact_candidates: list[Any] = []
        for ref in article_refs:
            exact_candidates.extend(exact_matches_by_ref.get(ref, []))

        merged_candidates = _merge_unique_chunks(
            exact_candidates + workspace_candidates + retrieved_candidates
        )
        if workspace_only:
            domain_filtered_candidates = workspace_candidates
            domain_filter_applied = False
            domain_filter_query_domains = []
            domain_filter_in_domain_count = len(workspace_candidates)
        elif settings.rag_domain_filter_enabled:
            domain_filtered_candidates, domain_filter_applied, domain_filter_query_domains, domain_filter_in_domain_count = filter_candidates_by_query_domains(
                query=retrieval_query,
                candidates=merged_candidates,
                top_k=candidate_pool_size,
                neutral_fallback_max=settings.rag_neutral_fallback_max,
            )
            if include_workspace_candidates and workspace_candidates:
                # Preserve workspace chunks for user-provided documents while keeping strict
                # domain filtering for indexed legal corpus.
                domain_filtered_candidates = _merge_unique_chunks(
                    workspace_candidates + domain_filtered_candidates
                )
        else:
            domain_filtered_candidates = merged_candidates

        allowed_chunk_ids = {chunk.chunk_id for chunk in domain_filtered_candidates}
        exact_matches_by_ref_for_selection: dict[Any, list[Any]] = {}
        for ref, matches in exact_matches_by_ref.items():
            kept = [chunk for chunk in matches if chunk.chunk_id in allowed_chunk_ids]
            if kept:
                exact_matches_by_ref_for_selection[ref] = kept
        if workspace_only:
            pre_ranked = domain_filtered_candidates[:candidate_pool_size]
            ranked_candidates = pre_ranked
        else:
            pre_ranked, rerank_applied = rerank_article_aware(
                query=retrieval_query,
                candidates=domain_filtered_candidates,
                top_k=candidate_pool_size,
            )
            if reranker_enabled:
                ranked_candidates, reranker_applied, reranker_error = retriever.rerank_with_cross_encoder(
                    query=retrieval_query,
                    candidates=pre_ranked,
                    top_k=candidate_pool_size,
                    candidate_pool_size=settings.rag_reranker_pool_size,
                )
            else:
                ranked_candidates = pre_ranked[:candidate_pool_size]

            inferred_refs = _infer_article_refs_from_candidates(
                ranked_candidates,
                original_query=original_query,
                max_refs=3,
                scan_limit=160,
            )
            inferred_refs = [ref for ref in inferred_refs if ref not in article_refs_for_selection]
            if inferred_refs:
                inferred_exact_by_ref = retriever.find_exact_article_matches(
                    query=coverage_query,
                    refs=inferred_refs,
                    per_ref_limit=6,
                    allowed_domains=domain_filter_query_domains or exact_query_domains,
                    strict_domain=True,
                    allow_neutral_when_filtered=False,
                )
                inferred_exact_candidates: list[Any] = []
                for ref in inferred_refs:
                    inferred_exact_candidates.extend(inferred_exact_by_ref.get(ref, []))
                if inferred_exact_candidates:
                    domain_filtered_candidates = _merge_unique_chunks(
                        inferred_exact_candidates + domain_filtered_candidates
                    )
                    ranked_candidates = _merge_unique_chunks(
                        inferred_exact_candidates + ranked_candidates
                    )
                    ranked_candidates, _ = rerank_article_aware(
                        query=retrieval_query,
                        candidates=ranked_candidates,
                        top_k=candidate_pool_size,
                    )
                    allowed_chunk_ids = {chunk.chunk_id for chunk in domain_filtered_candidates}
                    for ref, matches in inferred_exact_by_ref.items():
                        kept = [chunk for chunk in matches if chunk.chunk_id in allowed_chunk_ids]
                        if kept:
                            exact_matches_by_ref_for_selection[ref] = kept
                    exact_matches_by_ref.update(inferred_exact_by_ref)
                    for ref in inferred_refs:
                        if ref not in article_refs_for_selection:
                            article_refs_for_selection.append(ref)
                    inferred_article_refs_applied = True

        if workspace_only:
            selected_chunks = ranked_candidates[: max(1, effective_target_max_chunks)]
            threshold_final = threshold_start
            adaptive_iterations = 0
            neutral_added = 0
            removed_by_threshold = max(0, len(ranked_candidates) - len(selected_chunks))
        else:
            if adaptive_threshold_enabled:
                selected_chunks, threshold_final, adaptive_iterations, neutral_added = select_chunks_adaptive(
                    ranked_candidates,
                    min_score_threshold=settings.rag_min_score_threshold,
                    threshold_floor=settings.rag_adaptive_threshold_floor,
                    threshold_step=settings.rag_adaptive_threshold_step,
                    target_min=effective_target_min_chunks,
                    target_max=effective_target_max_chunks,
                    neutral_fallback_max=settings.rag_neutral_fallback_max,
                    article_refs=article_refs_for_selection,
                    exact_matches_by_ref=exact_matches_by_ref_for_selection,
                )
                # select_chunks_adaptive already enforces article coverage.
                if article_refs_for_selection and exact_matches_by_ref_for_selection:
                    coverage_applied = True
            else:
                selected_chunks, removed_by_threshold = filter_by_score_threshold(
                    ranked_candidates,
                    min_score_threshold=settings.rag_min_score_threshold,
                )
                selected_chunks, coverage_applied = enforce_article_reference_coverage(
                    ranked_chunks=selected_chunks,
                    article_refs=article_refs_for_selection,
                    exact_matches_by_ref=exact_matches_by_ref_for_selection,
                    top_k=effective_target_max_chunks,
                )
                if len(selected_chunks) > effective_target_max_chunks:
                    selected_chunks = selected_chunks[: effective_target_max_chunks]

        if not workspace_only and include_workspace_candidates and allowed_workspace_file_ids and workspace_candidates:
            pinned_workspace_chunks = workspace_candidates[: min(3, len(workspace_candidates))]
            selected_chunks = _merge_unique_chunks(pinned_workspace_chunks + selected_chunks)
            if len(selected_chunks) > effective_target_max_chunks:
                selected_chunks = selected_chunks[: effective_target_max_chunks]
        if direct_workspace_chunks:
            if workspace_only:
                selected_chunks = direct_workspace_chunks
            else:
                selected_chunks = _merge_unique_chunks(direct_workspace_chunks + selected_chunks)

        if not workspace_only:
            coverage_min_score_guard = max(0.0, settings.rag_min_score_threshold * 0.2)
            selected_chunks, anchor_path_coverage_applied = _enforce_anchor_path_coverage(
                selected_chunks,
                ranked_candidates,
                original_query=original_query,
                retrieval_query=retrieval_query,
                top_k=effective_target_max_chunks,
                min_score_guard=coverage_min_score_guard,
            )
            selected_chunks, sanction_intent_coverage_applied = _enforce_sanction_intent_coverage(
                selected_chunks,
                ranked_candidates,
                original_query=original_query,
                top_k=effective_target_max_chunks,
                min_score_guard=coverage_min_score_guard,
            )
            selected_chunks, sanction_no_intent_deprioritized = _deprioritize_sanction_chunks_without_intent(
                selected_chunks,
                ranked_candidates,
                original_query=original_query,
                top_k=effective_target_max_chunks,
                min_score_guard=coverage_min_score_guard,
            )
            selected_chunks, specialized_mismatch_deprioritized = _deprioritize_specialized_mismatch_chunks(
                selected_chunks,
                ranked_candidates,
                original_query=original_query,
                top_k=effective_target_max_chunks,
                min_score_guard=coverage_min_score_guard,
            )
            selected_chunks, query_focus_coverage_applied = _enforce_query_focus_coverage(
                selected_chunks,
                ranked_candidates,
                original_query=original_query,
                top_k=effective_target_max_chunks,
                min_score_guard=coverage_min_score_guard,
            )
            selected_chunks, query_focus_minimum_coverage_applied = _enforce_query_focus_minimum_coverage(
                selected_chunks,
                ranked_candidates,
                original_query=original_query,
                top_k=effective_target_max_chunks,
                min_score_guard=coverage_min_score_guard,
            )
            selected_chunks, strong_token_coverage_applied = _enforce_strong_token_coverage(
                selected_chunks,
                ranked_candidates,
                original_query=original_query,
                top_k=effective_target_max_chunks,
                min_score_guard=coverage_min_score_guard,
            )
            selected_chunks, mandatory_term_coverage_applied = _enforce_mandatory_term_coverage(
                selected_chunks,
                domain_filtered_candidates,
                original_query=coverage_query,
                top_k=effective_target_max_chunks,
                min_score_guard=coverage_min_score_guard,
            )
            selected_chunks, penal_core_coverage_applied = _enforce_penal_core_coverage(
                selected_chunks,
                ranked_candidates,
                retrieval_query=retrieval_query,
                original_query=original_query,
                top_k=effective_target_max_chunks,
                min_score_guard=coverage_min_score_guard,
            )
            selected_chunks, query_coverage_diversity_applied = _enforce_query_coverage_diversity(
                selected_chunks,
                ranked_candidates,
                original_query=original_query,
                retrieval_query=retrieval_query,
                top_k=effective_target_max_chunks,
                min_score_guard=max(0.05, settings.rag_min_score_threshold * 0.5),
            )
            selected_chunks, anchor_path_promoted = _promote_anchor_path_chunk(
                selected_chunks,
                retrieval_query=retrieval_query,
                top_k=effective_target_max_chunks,
            )
            selected_chunks, mandatory_term_lock_applied = _enforce_mandatory_term_coverage(
                selected_chunks,
                domain_filtered_candidates,
                original_query=coverage_query,
                top_k=effective_target_max_chunks,
                min_score_guard=0.0,
            )
            selected_chunks, specialized_mismatch_lock_applied = _deprioritize_specialized_mismatch_chunks(
                selected_chunks,
                ranked_candidates,
                original_query=original_query,
                top_k=effective_target_max_chunks,
                min_score_guard=0.0,
            )
            selected_chunks, query_focus_minimum_lock_applied = _enforce_query_focus_minimum_coverage(
                selected_chunks,
                ranked_candidates,
                original_query=original_query,
                top_k=effective_target_max_chunks,
                min_score_guard=0.0,
            )
            if article_refs_for_selection and exact_matches_by_ref_for_selection:
                selected_chunks, article_coverage_lock_applied = enforce_article_reference_coverage(
                    ranked_chunks=selected_chunks,
                    article_refs=article_refs_for_selection,
                    exact_matches_by_ref=exact_matches_by_ref_for_selection,
                    top_k=effective_target_max_chunks,
                )

    except Exception as exc:  # noqa: BLE001
        logger.exception("RAG retrieval pipeline failed: %s: %s", type(exc).__name__, exc)
        return messages, [], f"RAG retrieval failed: {exc}", None

    if adaptive_threshold_enabled and not workspace_only:
        removed_by_threshold = max(0, len(ranked_candidates) - len(selected_chunks))

    if settings.rag_relevance_check_enabled and not workspace_only:
        relevance = score_context_relevance(
            selected_chunks,
            min_chunks_required=settings.rag_min_chunks_required,
            min_score_threshold=settings.rag_min_score_threshold,
        )
        confidence_level = relevance.confidence_level
        best_score = relevance.best_score
        mean_score = relevance.mean_score
    else:
        confidence_level = "medium" if selected_chunks else "none"
        best_score = selected_chunks[0].score if selected_chunks else 0.0
        mean_score = (
            sum(chunk.score for chunk in selected_chunks) / len(selected_chunks)
            if selected_chunks
            else 0.0
        )

    if settings.rag_relevance_check_enabled and not workspace_only and not relevance.is_relevant:
        confidence_level = "none"

    if confidence_level == "none":
        rag_notes: list[str] = []
        if query_source and query_source != "user":
            rag_notes.append(f"RAG query source={query_source}")
        if query_rewrite_status:
            rag_notes.append(query_rewrite_status)
        rag_notes.append("no-reliable-context")
        rag_notes.append(f"threshold_start={threshold_start:.2f}")
        rag_notes.append(f"threshold_final={threshold_final:.2f}")
        rag_notes.append(f"selected_chunks={len(selected_chunks)}")
        rag_notes.append(
            f"target_range={effective_target_min_chunks}-{effective_target_max_chunks}"
        )
        rag_notes.append(f"workspace_candidates={workspace_candidate_count}")
        if allowed_workspace_file_ids:
            rag_notes.append(f"workspace_file_scope={len(allowed_workspace_file_ids)}")
        if direct_workspace_chunk_count > 0:
            rag_notes.append(f"workspace_direct_chunks={direct_workspace_chunk_count}")
        rag_notes.append(f"removed={removed_by_threshold}")
        rag_notes.append(f"adaptive_iterations={adaptive_iterations}")
        rag_notes.append(f"neutral_added={neutral_added}")
        rag_note = " | ".join(rag_notes)
        return [{"role": "system", "content": RAG_NO_CONTEXT_RESPONSE}, *messages], [], None, rag_note

    context_focus_terms = _extract_query_mandatory_terms(coverage_query)
    if not context_focus_terms:
        context_focus_terms = sorted(_extract_query_focus_tokens(coverage_query))[:8]

    context_chunks = _renumber_chunks_for_context(selected_chunks)
    context_text, sources = format_retrieval_context(
        context_chunks,
        max_chars=settings.rag_max_context_chars,
        focus_terms=context_focus_terms,
    )
    if not context_text:
        return [{"role": "system", "content": RAG_NO_CONTEXT_RESPONSE}, *messages], [], None, "no-context-after-format"

    context_header = "[CONTEXTE RAG]"
    if confidence_level == "low":
        context_header += (
            "\n[INSTRUCTION INTERNE] Sois prudent: privilegie les passages explicites, "
            "et signale les limites sans exposer de score de confiance."
        )

    rag_system_message = {
        "role": "system",
        "content": f"{RAG_SYSTEM_INSTRUCTIONS}\n\n{context_header}\n{context_text}",
    }
    extra_system_messages: list[dict[str, str]] = []
    if _is_definition_question(original_query):
        extra_system_messages.append(
            {
                "role": "system",
                "content": DEFINITION_FOCUS_INSTRUCTIONS,
            }
        )
    if _is_act_generation_question(original_query):
        extra_system_messages.append(
            {
                "role": "system",
                "content": ACT_GENERATION_INSTRUCTIONS,
            }
        )

    rag_notes: list[str] = []
    if query_source and query_source != "user":
        rag_notes.append(f"RAG query source={query_source}")
    if query_rewrite_status:
        rag_notes.append(query_rewrite_status)
    if article_refs and exact_matches_by_ref:
        rag_notes.append("article-exact-match")
    if inferred_article_refs_applied:
        rag_notes.append("article-inferred-match")
    if rerank_applied:
        rag_notes.append("article-aware-rerank")
    if settings.rag_domain_filter_enabled and domain_filter_query_domains:
        rag_notes.append(f"domains={','.join(domain_filter_query_domains)}")
        rag_notes.append(f"in_domain_candidates={domain_filter_in_domain_count}")
        if domain_filter_applied:
            rag_notes.append("domain-filter")
    if reranker_enabled:
        if reranker_applied:
            rag_notes.append("cross-encoder-rerank")
        elif reranker_error:
            rag_notes.append(f"cross-encoder-fallback={reranker_error}")
    if coverage_applied:
        rag_notes.append("multi-article-coverage")
    if article_coverage_lock_applied:
        rag_notes.append("multi-article-coverage-lock")
    if anchor_path_coverage_applied:
        rag_notes.append("anchor-path-coverage")
    if sanction_intent_coverage_applied:
        rag_notes.append("sanction-intent-coverage")
    if sanction_no_intent_deprioritized:
        rag_notes.append("sanction-nointent-deprioritized")
    if specialized_mismatch_deprioritized:
        rag_notes.append("specialized-mismatch-deprioritized")
    if specialized_mismatch_lock_applied:
        rag_notes.append("specialized-mismatch-lock")
    if query_focus_coverage_applied:
        rag_notes.append("query-focus-coverage")
    if query_focus_minimum_coverage_applied:
        rag_notes.append("query-focus-minimum-coverage")
    if query_focus_minimum_lock_applied:
        rag_notes.append("query-focus-minimum-lock")
    if strong_token_coverage_applied:
        rag_notes.append("strong-token-coverage")
    if mandatory_term_coverage_applied:
        rag_notes.append("mandatory-term-coverage")
    if mandatory_term_lock_applied:
        rag_notes.append("mandatory-term-lock")
    if penal_core_coverage_applied:
        rag_notes.append("penal-core-coverage")
    if query_coverage_diversity_applied:
        rag_notes.append("query-coverage-diversity")
    if anchor_path_promoted:
        rag_notes.append("anchor-path-promoted")
    if query_focus_retrieval_used:
        rag_notes.append("query-focus-retrieval")
    rag_notes.append(f"confidence={confidence_level}")
    rag_notes.append(f"threshold_start={threshold_start:.2f}")
    rag_notes.append(f"threshold_final={threshold_final:.2f}")
    rag_notes.append(
        f"target_range={effective_target_min_chunks}-{effective_target_max_chunks}"
    )
    rag_notes.append(f"selected_chunks={len(selected_chunks)}")
    rag_notes.append(f"workspace_candidates={workspace_candidate_count}")
    rag_notes.append(f"removed={removed_by_threshold}")
    rag_notes.append(f"adaptive_iterations={adaptive_iterations}")
    rag_notes.append(f"neutral_added={neutral_added}")
    rag_notes.append(f"citation_target={settings.rag_min_source_citations}")
    rag_notes.append(f"best={best_score:.3f}")
    rag_notes.append(f"mean={mean_score:.3f}")
    if any(msg.get("content") == DEFINITION_FOCUS_INSTRUCTIONS for msg in extra_system_messages):
        rag_notes.append("definition-focus")
    if any(msg.get("content") == ACT_GENERATION_INSTRUCTIONS for msg in extra_system_messages):
        rag_notes.append("act-generation-mode")
    if workspace_only:
        rag_notes.append("workspace-only-context")
    if allowed_workspace_file_ids:
        rag_notes.append(f"workspace_file_scope={len(allowed_workspace_file_ids)}")
    if direct_workspace_chunk_count > 0:
        rag_notes.append(f"workspace_direct_chunks={direct_workspace_chunk_count}")
    rag_note = " | ".join(rag_notes) if rag_notes else None

    if not extra_system_messages:
        return [rag_system_message, *messages], sources, None, rag_note
    return [rag_system_message, *extra_system_messages, *messages], sources, None, rag_note


def _llm_request_kwargs(payload: ChatRequest) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "temperature": payload.temperature,
        "top_p": payload.top_p,
        "max_tokens": payload.max_tokens,
    }
    # NVIDIA supports this parameter; Ollama OpenAI-compatible endpoint may reject it.
    if settings.llm_provider == "nvidia":
        kwargs["extra_body"] = {"chat_template_kwargs": {"thinking": payload.thinking}}
    return kwargs


def _rate_limit_allow(client_ip: str) -> bool:
    # Fixed one-minute window limiter per source IP.
    now = monotonic()
    window_seconds = 60.0
    max_requests = settings.rate_limit_requests_per_minute
    with _RATE_LIMIT_LOCK:
        window_start, count = _RATE_LIMIT_STATE.get(client_ip, (now, 0))
        if now - window_start >= window_seconds:
            _RATE_LIMIT_STATE[client_ip] = (now, 1)
            return True
        if count >= max_requests:
            return False
        _RATE_LIMIT_STATE[client_ip] = (window_start, count + 1)
        return True


docs_url = "/docs" if settings.api_docs_enabled else None
redoc_url = "/redoc" if settings.api_docs_enabled else None
openapi_url = "/openapi.json" if settings.api_docs_enabled else None

app = FastAPI(
    title="Chatbot Juridique API",
    version="0.1.0",
    docs_url=docs_url,
    redoc_url=redoc_url,
    openapi_url=openapi_url,
)
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=settings.trusted_hosts,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_origin_regex=settings.allowed_origin_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "Accept",
        "Origin",
        "User-Agent",
        "X-Client-Auth-Mode",
        "X-User-Id",
        "X-Clerk-User-Id",
        "X-User-Email",
        "X-User-Name",
        "X-User-Username",
    ],
)
if settings.gzip_enabled:
    app.add_middleware(
        GZipMiddleware,
        minimum_size=settings.gzip_min_size,
    )


def _warmup_retrieval_components() -> None:
    if not settings.rag_enabled:
        return
    try:
        retriever = get_retriever()
        retriever.warmup(
            load_reranker=settings.rag_reranker_enabled,
            prepare_bm25=True,
        )
        logger.info(
            "[RAG-WARMUP] completed | reranker=%s | embedding_model=%s",
            settings.rag_reranker_enabled,
            settings.rag_embedding_model,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[RAG-WARMUP] failed: %s: %s", type(exc).__name__, exc)


@app.on_event("startup")
async def startup_warmup() -> None:
    if not settings.rag_preload_on_startup:
        return
    if settings.rag_preload_blocking:
        _warmup_retrieval_components()
        return
    threading.Thread(
        target=_warmup_retrieval_components,
        name="rag-warmup",
        daemon=True,
    ).start()


@app.middleware("http")
async def enforce_request_size_and_security_headers(request: Request, call_next):
    if settings.rate_limit_enabled and request.method != "OPTIONS":
        path = request.url.path
        if path not in {"/health", "/ready"}:
            client_ip = request.client.host if request.client else "unknown"
            if not _rate_limit_allow(client_ip):
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Too many requests. Please retry in a minute."},
                )

    if request.method in {"POST", "PUT", "PATCH"}:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                content_length_value = int(content_length)
            except ValueError:
                content_length_value = 0
            max_bytes = settings.request_max_body_mb * 1024 * 1024
            if content_length_value > max_bytes:
                return JSONResponse(
                    status_code=413,
                    content={
                        "detail": (
                            f"Payload too large. Max {settings.request_max_body_mb}MB."
                        )
                    },
                )

    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
    if settings.app_env == "production":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


@app.exception_handler(RuntimeError)
async def runtime_error_handler(_: Request, exc: RuntimeError):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


@app.get("/health")
async def health():
    workspace_storage = workspace_storage_summary()
    return {
        "status": "ok",
        "env": settings.app_env,
        "provider": settings.llm_provider,
        "model": settings.llm_model,
        "docs_enabled": settings.api_docs_enabled,
        "request_max_body_mb": settings.request_max_body_mb,
        "trusted_hosts": settings.trusted_hosts,
        "allowed_origins": settings.allowed_origins,
        "allowed_origin_regex": settings.allowed_origin_regex,
        "rate_limit_enabled": settings.rate_limit_enabled,
        "rate_limit_requests_per_minute": settings.rate_limit_requests_per_minute,
        "rag": {
            "enabled": settings.rag_enabled,
            "index_dir": settings.rag_index_dir,
            "top_k": settings.rag_top_k,
            "reranker_enabled": settings.rag_reranker_enabled,
            "reranker_model": settings.rag_reranker_model if settings.rag_reranker_enabled else None,
            "reranker_pool_size": settings.rag_reranker_pool_size,
            "domain_filter_enabled": settings.rag_domain_filter_enabled,
            "target_min_chunks": settings.rag_target_min_chunks,
            "target_max_chunks": settings.rag_target_max_chunks,
            "adaptive_threshold_enabled": settings.rag_adaptive_threshold_enabled,
            "adaptive_threshold_floor": settings.rag_adaptive_threshold_floor,
            "adaptive_threshold_step": settings.rag_adaptive_threshold_step,
            "min_source_citations": settings.rag_min_source_citations,
            "neutral_fallback_max": settings.rag_neutral_fallback_max,
            "min_score_threshold": settings.rag_min_score_threshold,
            "min_chunks_required": settings.rag_min_chunks_required,
            "relevance_check_enabled": settings.rag_relevance_check_enabled,
            "query_rewrite_enabled": settings.rag_query_rewrite_enabled,
            "query_rewrite_model": settings.rag_query_rewrite_model or settings.llm_model,
            "query_rewrite_max_tokens": settings.rag_query_rewrite_max_tokens,
            "query_rewrite_temperature": settings.rag_query_rewrite_temperature,
            "query_rewrite_timeout_sec": settings.rag_query_rewrite_timeout_sec,
            "query_rewrite_skip_tokens": settings.rag_query_rewrite_skip_tokens,
            "reranker_cpu_max_candidates": settings.rag_reranker_cpu_max_candidates,
            "reranker_snippet_chars": settings.rag_reranker_snippet_chars,
            "reranker_cpu_snippet_chars": settings.rag_reranker_cpu_snippet_chars,
            "preload_on_startup": settings.rag_preload_on_startup,
            "preload_blocking": settings.rag_preload_blocking,
        },
        "workspace": {
            "enabled": True,
            "storage": workspace_storage.get("backend", "json-file"),
            "fallback": workspace_storage.get("fallback"),
            "path": workspace_storage.get("path", "data/app_state/workspace_state.json"),
            "supabase": workspace_storage.get("supabase"),
            "upload_dir": str(WORKSPACE_UPLOAD_DIR),
            "supported_extensions": sorted(SUPPORTED_UPLOAD_EXTENSIONS),
        },
        "speech": {
            "enabled": settings.speech_enabled,
            "whisper_model_size": settings.whisper_model_size,
            "whisper_device": settings.whisper_device,
            "whisper_compute_type": settings.whisper_compute_type,
            "whisper_language": settings.whisper_language,
            "whisper_beam_size": settings.whisper_beam_size,
            "whisper_vad_filter": settings.whisper_vad_filter,
        },
    }


@app.get("/ready")
async def ready():
    errors: list[str] = []
    checks: dict[str, Any] = {
        "env": settings.app_env,
        "provider": settings.llm_provider,
        "model": settings.llm_model,
        "rag_enabled": settings.rag_enabled,
        "workspace_storage": workspace_storage_summary(),
    }

    rag_index_dir = Path(settings.rag_index_dir)
    if settings.rag_enabled:
        expected_files = [rag_index_dir / "index.faiss", rag_index_dir / "meta.jsonl"]
        missing_files = [str(path) for path in expected_files if not path.exists()]
        checks["rag_index_dir"] = str(rag_index_dir)
        checks["rag_index_missing_files"] = missing_files
        if missing_files:
            errors.append("Missing RAG index files.")
        else:
            try:
                retriever = get_retriever()
                checks["rag_embedding_model"] = retriever.model_name
            except Exception as exc:  # noqa: BLE001
                errors.append(f"RAG retriever init failed: {type(exc).__name__}: {exc}")
    else:
        checks["rag_index_dir"] = str(rag_index_dir)

    try:
        WORKSPACE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"Workspace upload dir not writable: {type(exc).__name__}: {exc}")

    checks["workspace_upload_dir"] = str(WORKSPACE_UPLOAD_DIR)
    checks["trusted_hosts"] = settings.trusted_hosts
    checks["allowed_origins"] = settings.allowed_origins
    checks["allowed_origin_regex"] = settings.allowed_origin_regex

    if errors:
        return JSONResponse(
            status_code=503,
            content={
                "status": "not-ready",
                "errors": errors,
                "checks": checks,
            },
        )
    return {
        "status": "ready",
        "checks": checks,
    }


app.include_router(library_router)
app.include_router(workspace_router)
app.include_router(speech_router)


@app.post("/chat")
async def chat(payload: ChatRequest, request: Request):
    request_started = monotonic()
    input_messages = [message.model_dump() for message in payload.messages]
    original_query, _ = _extract_query_for_rag(input_messages)
    should_capture_chat_qa = _should_capture_chat_sample(request)
    should_use_rag = settings.rag_enabled and payload.use_rag is not False
    if should_use_rag:
        llm_messages, rag_sources, rag_error, rag_note = await _prepare_messages_with_rag(
            input_messages,
            rewrite_enabled_override=payload.rag_query_rewrite,
            workspace_only=payload.workspace_only,
            workspace_file_ids=payload.workspace_file_ids,
        )
    else:
        llm_messages = input_messages
        rag_sources = []
        rag_error = None
        rag_note = "rag-bypassed-request"
    llm_messages = _normalize_messages_for_provider(llm_messages)
    rag_ready_at = monotonic()

    try:
        completion = await client.chat.completions.create(
            model=settings.llm_model,
            messages=llm_messages,
            **_llm_request_kwargs(payload),
            stream=False,
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"LLM request failed: {exc}") from exc

    answer = ""
    finish_reason: str | None = None
    if getattr(completion, "choices", None):
        choice = completion.choices[0]
        finish_reason = getattr(choice, "finish_reason", None)
        answer = _extract_completion_text(getattr(choice, "message", None))
    is_act_generation_mode = bool(rag_note and "act-generation-mode" in rag_note)
    if is_act_generation_mode:
        answer = (answer or "").strip()
        answer_sanitized = False
    else:
        answer, answer_sanitized = _sanitize_generated_answer(answer)
        if answer_sanitized:
            rag_note = _append_rag_note(rag_note, "answer-sanitized")
        answer, rag_sources, citations_sanitized = _sanitize_citations_against_sources(
            answer,
            rag_sources,
        )
        if citations_sanitized:
            rag_note = _append_rag_note(rag_note, "citation-sanitized")
        answer, article_ranges_sanitized = _sanitize_conflicting_article_ranges(
            answer,
            rag_sources,
        )
        if article_ranges_sanitized:
            rag_note = _append_rag_note(rag_note, "article-range-sanitized")
        answer, article_mentions_sanitized = _sanitize_unbacked_article_mentions(answer)
        if article_mentions_sanitized:
            rag_note = _append_rag_note(rag_note, "article-mention-sanitized")

    if is_act_generation_mode and (not answer or _is_rag_note_like_text(answer)):
        fallback_payload = {
            "status": "missing",
            "missing_items": [],
            "assistant_reply": (
                "Je n'ai pas pu produire un projet d'acte exploitable. "
                "Merci de completer les informations essentielles "
                "(identite des parties, objet, dates, montants, lieu) "
                "ou de reformuler votre demande."
            ),
            "document": "",
        }
        answer = json.dumps(fallback_payload, ensure_ascii=False)
        rag_note = _append_rag_note(rag_note, "act-empty-fallback")
    rag_note, citation_underuse = _check_citation_underuse(
        answer=answer,
        rag_source_count=len(rag_sources),
        rag_note=rag_note,
    )

    response_payload: dict[str, Any] = {
        "status": "completed",
        "model": settings.llm_model,
        "answer": answer,
        "finish_reason": finish_reason,
        "rag_enabled": should_use_rag,
        "rag_source_count": len(rag_sources),
        "rag_sources": _public_rag_sources(rag_sources),
    }
    if citation_underuse:
        response_payload["citation_underuse"] = True
    if rag_error:
        response_payload["rag_error"] = rag_error
    if rag_note:
        response_payload["rag_note"] = rag_note
    if should_capture_chat_qa:
        _persist_chat_qa_sample(
            request=request,
            question=original_query or "",
            answer=answer,
            rag_note=rag_note,
            finish_reason=finish_reason,
            rag_source_count=len(rag_sources),
        )
    completed_at = monotonic()
    logger.info(
        "[CHAT-LATENCY] prep_ms=%.1f llm_ms=%.1f total_ms=%.1f sources=%d provider=%s model=%s note=%s",
        (rag_ready_at - request_started) * 1000.0,
        (completed_at - rag_ready_at) * 1000.0,
        (completed_at - request_started) * 1000.0,
        len(rag_sources),
        settings.llm_provider,
        settings.llm_model,
        _clip_for_log(rag_note or ""),
    )
    return response_payload


@app.post("/chat/stream")
async def chat_stream(payload: ChatRequest, request: Request):
    request_started = monotonic()
    input_messages = [message.model_dump() for message in payload.messages]
    original_query, _ = _extract_query_for_rag(input_messages)
    should_capture_chat_qa = _should_capture_chat_sample(request)
    stream_fast_target_min = 8
    stream_fast_target_max = 10
    should_use_rag = settings.rag_enabled and payload.use_rag is not False
    if should_use_rag:
        llm_messages, rag_sources, rag_error, rag_note = await _prepare_messages_with_rag(
            input_messages,
            rewrite_enabled_override=payload.rag_query_rewrite,
            workspace_only=payload.workspace_only,
            workspace_file_ids=payload.workspace_file_ids,
            rag_target_min_chunks_override=stream_fast_target_min,
            rag_target_max_chunks_override=stream_fast_target_max,
        )
    else:
        llm_messages = input_messages
        rag_sources = []
        rag_error = None
        rag_note = "rag-bypassed-request"
    llm_messages = _normalize_messages_for_provider(llm_messages)
    rag_ready_at = monotonic()

    async def event_generator() -> AsyncGenerator[str, None]:
        stream_rag_note = rag_note
        first_token_at: float | None = None
        captured_chat_sample = False

        def _capture_chat_qa_once(
            *,
            answer: str,
            finish_reason: str | None,
            rag_note_value: str | None,
            rag_source_count: int,
        ) -> None:
            nonlocal captured_chat_sample
            if captured_chat_sample or not should_capture_chat_qa:
                return
            _persist_chat_qa_sample(
                request=request,
                question=original_query or "",
                answer=answer,
                rag_note=rag_note_value,
                finish_reason=finish_reason,
                rag_source_count=rag_source_count,
            )
            captured_chat_sample = True

        def _log_stream_latency(final_note: str | None) -> None:
            completed_at = monotonic()
            first_token_ms = (
                f"{((first_token_at - request_started) * 1000.0):.1f}"
                if first_token_at is not None
                else "none"
            )
            logger.info(
                "[CHAT-STREAM-LATENCY] prep_ms=%.1f first_token_ms=%s total_ms=%.1f sources=%d provider=%s model=%s note=%s",
                (rag_ready_at - request_started) * 1000.0,
                first_token_ms,
                (completed_at - request_started) * 1000.0,
                len(rag_sources),
                settings.llm_provider,
                settings.llm_model,
                _clip_for_log(final_note or ""),
            )

        meta_payload: dict[str, Any] = {
            "status": "started",
            "model": settings.llm_model,
            "rag_enabled": should_use_rag,
            "rag_source_count": len(rag_sources),
            "rag_sources": _public_rag_sources(rag_sources),
        }
        if rag_error:
            meta_payload["rag_error"] = rag_error
        if stream_rag_note:
            meta_payload["rag_note"] = stream_rag_note
        yield _sse("meta", meta_payload)
        answer_parts: list[str] = []

        try:
            stream = await client.chat.completions.create(
                model=settings.llm_model,
                messages=llm_messages,
                **_llm_request_kwargs(payload),
                stream=True,
            )

            async for chunk in stream:
                if not getattr(chunk, "choices", None):
                    continue

                choice = chunk.choices[0]
                delta = getattr(choice, "delta", None)
                if delta is None:
                    continue

                reasoning = getattr(delta, "reasoning_content", None)
                if reasoning:
                    yield _sse("reasoning", {"text": reasoning})

                content = getattr(delta, "content", None)
                if isinstance(content, str) and content:
                    if first_token_at is None:
                        first_token_at = monotonic()
                    answer_parts.append(content)
                    yield _sse("token", {"text": content})
                    current_answer = "".join(answer_parts)
                    if _has_runaway_repetition(current_answer):
                        sanitized_answer, answer_sanitized = _sanitize_generated_answer(current_answer)
                        if answer_sanitized:
                            yield _sse("replace", {"text": sanitized_answer})
                        sanitized_answer, final_sources, citations_sanitized = _sanitize_citations_against_sources(
                            sanitized_answer,
                            rag_sources,
                        )
                        if citations_sanitized:
                            yield _sse("replace", {"text": sanitized_answer})
                        sanitized_answer, article_ranges_sanitized = _sanitize_conflicting_article_ranges(
                            sanitized_answer,
                            final_sources,
                        )
                        if article_ranges_sanitized:
                            yield _sse("replace", {"text": sanitized_answer})
                        sanitized_answer, article_mentions_sanitized = _sanitize_unbacked_article_mentions(
                            sanitized_answer
                        )
                        if article_mentions_sanitized:
                            yield _sse("replace", {"text": sanitized_answer})
                        final_rag_note = _append_rag_note(stream_rag_note, "loop-guard-stop")
                        if answer_sanitized:
                            final_rag_note = _append_rag_note(final_rag_note, "answer-sanitized")
                        if citations_sanitized:
                            final_rag_note = _append_rag_note(final_rag_note, "citation-sanitized")
                        if article_ranges_sanitized:
                            final_rag_note = _append_rag_note(final_rag_note, "article-range-sanitized")
                        if article_mentions_sanitized:
                            final_rag_note = _append_rag_note(final_rag_note, "article-mention-sanitized")
                        final_rag_note, citation_underuse = _check_citation_underuse(
                            answer=sanitized_answer,
                            rag_source_count=len(final_sources),
                            rag_note=final_rag_note,
                        )
                        done_payload: dict[str, Any] = {"finish_reason": "loop_guard_stop"}
                        done_payload["rag_sources"] = _public_rag_sources(final_sources)
                        if final_rag_note:
                            done_payload["rag_note"] = final_rag_note
                        if citation_underuse:
                            done_payload["citation_underuse"] = True
                        _capture_chat_qa_once(
                            answer=sanitized_answer,
                            finish_reason="loop_guard_stop",
                            rag_note_value=final_rag_note,
                            rag_source_count=len(final_sources),
                        )
                        _log_stream_latency(final_rag_note)
                        yield _sse("done", done_payload)
                        return

                if choice.finish_reason:
                    final_answer = "".join(answer_parts)
                    final_answer, answer_sanitized = _sanitize_generated_answer(final_answer)
                    if answer_sanitized:
                        yield _sse("replace", {"text": final_answer})
                        stream_rag_note = _append_rag_note(stream_rag_note, "answer-sanitized")
                    final_answer, final_sources, citations_sanitized = _sanitize_citations_against_sources(
                        final_answer,
                        rag_sources,
                    )
                    if citations_sanitized:
                        yield _sse("replace", {"text": final_answer})
                        stream_rag_note = _append_rag_note(stream_rag_note, "citation-sanitized")
                    final_answer, article_ranges_sanitized = _sanitize_conflicting_article_ranges(
                        final_answer,
                        final_sources,
                    )
                    if article_ranges_sanitized:
                        yield _sse("replace", {"text": final_answer})
                        stream_rag_note = _append_rag_note(stream_rag_note, "article-range-sanitized")
                    final_answer, article_mentions_sanitized = _sanitize_unbacked_article_mentions(
                        final_answer
                    )
                    if article_mentions_sanitized:
                        yield _sse("replace", {"text": final_answer})
                        stream_rag_note = _append_rag_note(stream_rag_note, "article-mention-sanitized")
                    final_rag_note, citation_underuse = _check_citation_underuse(
                        answer=final_answer,
                        rag_source_count=len(final_sources),
                        rag_note=stream_rag_note,
                    )
                    done_payload: dict[str, Any] = {"finish_reason": choice.finish_reason}
                    done_payload["rag_sources"] = _public_rag_sources(final_sources)
                    if final_rag_note:
                        done_payload["rag_note"] = final_rag_note
                    if citation_underuse:
                        done_payload["citation_underuse"] = True
                    _capture_chat_qa_once(
                        answer=final_answer,
                        finish_reason=choice.finish_reason,
                        rag_note_value=final_rag_note,
                        rag_source_count=len(final_sources),
                    )
                    _log_stream_latency(final_rag_note)
                    yield _sse("done", done_payload)
                    return

            final_answer = "".join(answer_parts)
            final_answer, answer_sanitized = _sanitize_generated_answer(final_answer)
            if answer_sanitized:
                yield _sse("replace", {"text": final_answer})
                stream_rag_note = _append_rag_note(stream_rag_note, "answer-sanitized")
            final_answer, final_sources, citations_sanitized = _sanitize_citations_against_sources(
                final_answer,
                rag_sources,
            )
            if citations_sanitized:
                yield _sse("replace", {"text": final_answer})
                stream_rag_note = _append_rag_note(stream_rag_note, "citation-sanitized")
            final_answer, article_ranges_sanitized = _sanitize_conflicting_article_ranges(
                final_answer,
                final_sources,
            )
            if article_ranges_sanitized:
                yield _sse("replace", {"text": final_answer})
                stream_rag_note = _append_rag_note(stream_rag_note, "article-range-sanitized")
            final_answer, article_mentions_sanitized = _sanitize_unbacked_article_mentions(final_answer)
            if article_mentions_sanitized:
                yield _sse("replace", {"text": final_answer})
                stream_rag_note = _append_rag_note(stream_rag_note, "article-mention-sanitized")
            final_rag_note, citation_underuse = _check_citation_underuse(
                answer=final_answer,
                rag_source_count=len(final_sources),
                rag_note=stream_rag_note,
            )
            done_payload = {"finish_reason": "stop"}
            done_payload["rag_sources"] = _public_rag_sources(final_sources)
            if final_rag_note:
                done_payload["rag_note"] = final_rag_note
            if citation_underuse:
                done_payload["citation_underuse"] = True
            _capture_chat_qa_once(
                answer=final_answer,
                finish_reason="stop",
                rag_note_value=final_rag_note,
                rag_source_count=len(final_sources),
            )
            _log_stream_latency(final_rag_note)
            yield _sse("done", done_payload)
        except Exception as exc:  # noqa: BLE001
            _log_stream_latency(stream_rag_note)
            yield _sse("error", {"detail": str(exc)})

    return StreamingResponse(event_generator(), media_type="text/event-stream")
