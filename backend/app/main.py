from __future__ import annotations

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

logger = logging.getLogger("backend.app.main")

_RATE_LIMIT_LOCK = threading.Lock()
_RATE_LIMIT_STATE: dict[str, tuple[float, int]] = {}


def _sse(event: str, data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


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


_SOURCE_CITATION_RE = re.compile(r"\[source\s+(\d+)\]", re.IGNORECASE)
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


def _distinct_source_citations(answer: str) -> set[int]:
    citations: set[int] = set()
    for match in _SOURCE_CITATION_RE.finditer(answer):
        value = match.group(1)
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
    if len(distinct_citations) >= settings.rag_min_source_citations:
        return rag_note, False
    updated_note = _append_rag_note(rag_note, "citation-underuse")
    return updated_note, True


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
    "Ne mentionne jamais le niveau de confiance interne (LOW, MEDIUM, HIGH) dans la reponse.\n"
    "Si tu cites un article ou une loi, ecris-le explicitement (ex: Article 55) dans la reponse.\n"
    "Quand une source RAG supporte cet article, ajoute la reference [source X].\n"
    "Si un article est mentionne par raisonnement interne et n'apparait pas clairement dans les sources RAG,\n"
    "marque-le comme 'a verifier sur texte officiel' et n'invente pas de citation [source X].\n"
    "Quand au moins 3 sources sont fournies, synthetise au moins 3 sources distinctes.\n"
    "Si moins de 3 sources sont disponibles, dis-le explicitement et reponds avec ce qui est disponible.\n"
    "Tu peux faire un raisonnement juridique simple en t'appuyant sur ton entrainement interne\n"
    "uniquement pour relier des elements deja compatibles avec les sources recuperees.\n"
    "N'invente ni faits, ni articles, ni sanctions.\n"
    "Regle speciale: si la question porte sur homosexualite/acte contre nature et que present,\n"
    "cite explicitement l'Article 319 (Loi n 66-16 du 1er fevrier 1966).\n"
)

RAG_NO_CONTEXT_RESPONSE = (
    "Tu es un assistant juridique francophone specialise en droit senegalais.\n"
    "Aucun contexte documentaire fiable n'est disponible pour cette question.\n"
    "Reponds honnetement que l'information n'est pas disponible dans la base actuelle,\n"
    "sans inventer de contenu juridique, puis recommande de verifier le texte officiel.\n"
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
)

ARTICLE_319_SPECIAL_INSTRUCTIONS = (
    "Instruction obligatoire pour cette question:\n"
    "- Repondre explicitement en citant l'Article 319 (Loi n 66-16 du 1er fevrier 1966).\n"
    "- Indiquer la peine pour 'acte impudique ou contre nature avec un individu de son sexe': "
    "emprisonnement de 1 a 5 ans et amende de 100.000 a 1.500.000 francs.\n"
    "- Indiquer que si l'acte est commis avec un mineur de 21 ans, le maximum de la peine est prononce.\n"
    "- Si le texte exact n'est pas present dans le CONTEXTE RAG, ecrire explicitement que "
    "l'information est non trouvee dans le contexte.\n"
    "- Format de reponse obligatoire:\n"
    "Reponse: ...\n"
    "Base legale citee: ...\n"
    "Peines: ...\n"
    "Sources: [source X]\n"
)

RAG_RETRIEVAL_OVERFETCH_FACTOR = 4

RAG_QUERY_REWRITE_SYSTEM_INSTRUCTIONS = (
    "Tu es un assistant de reformulation pour la recherche documentaire juridique.\n"
    "Objectif: transformer la question utilisateur en requete RAG precise, en francais, "
    "avec synonymes juridiques utiles (Senegal/OHADA) sans changer l'intention.\n"
    "Regles:\n"
    "- La requete finale doit etre STRICTEMENT en francais.\n"
    "- N'utilise pas d'anglais, sauf sigle officiel ou nom propre.\n"
    "- Retourne uniquement un JSON valide sur une seule ligne.\n"
    "- Format exact: {\"query\":\"...\"}\n"
    "- La valeur `query` doit contenir la question reformulee et enrichie en termes juridiques.\n"
    "- Si la question est une demande de definition simple (ex: 'c quoi ...', 'definition ...', "
    "'exemple ...'), retourne une requete courte de type 'definition ...' sans sur-enrichissement.\n"
    "- N'ajoute aucune explication, aucun markdown, aucun commentaire.\n"
    "- Maximum 40 mots.\n"
)

_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
_DEFINITION_PREFIX_RE = re.compile(
    r"^\s*(?:c[' ]?est\s+quoi|c\s+quoi|que\s+signifie|definition(?:\s+de)?|definir|explique(?:\s+moi)?|exemple|example)\b[\s:,-]*",
    re.IGNORECASE,
)
_ARTICLE_LIKE_QUERY_RE = re.compile(r"\b(?:article|art\.?)\s*\d+", re.IGNORECASE)
_LEADING_DETERMINER_RE = re.compile(r"^(?:l'|le|la|les|du|de la|de l')\s+", re.IGNORECASE)


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

    if has_definition_prefix:
        subject = _DEFINITION_PREFIX_RE.sub("", query).strip(" .,:;?!-")
        subject = _LEADING_DETERMINER_RE.sub("", subject).strip()
        if not subject:
            subject = query
        return _normalize_spaces(f"definition {subject}")

    # Short concept queries (e.g. "contrat de travail") should remain concise.
    tokens = [token for token in re.split(r"\s+", lowered) if token]
    if 1 <= len(tokens) <= 4 and not any(char.isdigit() for char in lowered):
        return _normalize_spaces(f"definition {query}")

    return None


def _is_definition_question(query: str) -> bool:
    return _definition_rewrite_candidate(query) is not None


def _is_act_generation_question(query: str) -> bool:
    lowered = _strip_accents(query).lower()
    patterns = [
        r"\b(genere|generer|generation|redige|rediger|modele|brouillon|template)\b.{0,40}\b(acte|contrat|plainte|requete|assignation|procuration|statuts|reconnaissance de dette|mise en demeure)\b",
        r"\b(acte|contrat|plainte|requete|assignation|procuration|statuts|reconnaissance de dette|mise en demeure)\b.{0,40}\b(genere|generer|redige|rediger|modele|brouillon)\b",
    ]
    return any(re.search(pattern, lowered) for pattern in patterns)


def _normalize_spaces(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


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
    rewrite_enabled_override: bool | None = None,
) -> tuple[str, str | None]:
    if rewrite_enabled_override is False:
        return original_query, "query-rewrite-request-disabled"
    if not settings.rag_query_rewrite_enabled:
        return original_query, None

    definition_candidate = _definition_rewrite_candidate(original_query)
    if definition_candidate:
        return definition_candidate, "query-rewrite-definition-intent"

    rewrite_model = settings.rag_query_rewrite_model or settings.llm_model
    rewrite_messages = [
        {"role": "system", "content": RAG_QUERY_REWRITE_SYSTEM_INSTRUCTIONS},
        {"role": "user", "content": original_query},
    ]
    kwargs: dict[str, Any] = {
        "temperature": settings.rag_query_rewrite_temperature,
        "top_p": 1.0,
        "max_tokens": settings.rag_query_rewrite_max_tokens,
        "stream": False,
    }
    if settings.llm_provider == "nvidia":
        kwargs["extra_body"] = {"chat_template_kwargs": {"thinking": False}}

    try:
        completion = await client.chat.completions.create(
            model=rewrite_model,
            messages=rewrite_messages,
            **kwargs,
        )
    except Exception as exc:  # noqa: BLE001
        return original_query, f"query-rewrite-fallback={type(exc).__name__}"

    rewritten_content = ""
    if getattr(completion, "choices", None):
        rewritten_content = _extract_completion_text(getattr(completion.choices[0], "message", None))

    rewritten_query, status = _extract_rewritten_query(rewritten_content, original_query)
    return rewritten_query, status


def _is_article_319_topic(query: str) -> bool:
    lowered = query.lower()
    patterns = [
        r"\bhomosex",
        r"contre\s+nature",
        r"acte\s+impudique",
        r"\barticle\s*319\b",
        r"\bart\.?\s*319\b",
        r"\bmeme\s+sexe\b",
    ]
    return any(re.search(pattern, lowered) for pattern in patterns)


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


# ---------------------------------------------------------------------------
# Preparation du contexte RAG
# ---------------------------------------------------------------------------
async def _prepare_messages_with_rag(
    messages: list[dict[str, Any]],
    rewrite_enabled_override: bool | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None, str | None]:
    if not settings.rag_enabled:
        return messages, [], None, None

    original_query, query_source = _extract_query_for_rag(messages)
    if not original_query:
        return messages, [], "RAG skipped: no usable message found.", None
    retrieval_query, query_rewrite_status = await _rewrite_query_for_rag(
        original_query,
        rewrite_enabled_override,
    )
    _emit_rewrite_trace(
        query_rewrite_status or "query-rewrite-disabled",
        original_query,
        retrieval_query,
    )

    try:
        from backend.retrieval import (
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

    reranker_applied = False
    reranker_error: str | None = None
    domain_filter_applied = False
    domain_filter_query_domains: list[str] = []
    domain_filter_in_domain_count = 0
    coverage_applied = False
    threshold_start = settings.rag_min_score_threshold
    threshold_final = threshold_start
    adaptive_iterations = 0
    neutral_added = 0
    removed_by_threshold = 0
    workspace_candidate_count = 0
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
            settings.rag_target_max_chunks,
        )
        # Recherche RAG avec la question (eventuellement reformulee)
        retrieved_candidates = retriever.search_hybrid(
            query=retrieval_query,
            top_k=candidate_pool_size,
            candidate_pool_size=candidate_pool_size,
        )
        workspace_candidates = get_workspace_rag_index().search(
            query=retrieval_query,
            top_k=max(settings.rag_target_max_chunks, settings.rag_top_k),
        )
        workspace_candidate_count = len(workspace_candidates)
        # Recherche exacte des articles mentionnes dans la query originale
        exact_matches_by_ref = retriever.find_exact_article_matches(
            query=original_query,
            refs=article_refs,
            per_ref_limit=4,
        )
        exact_candidates: list[Any] = []
        for ref in article_refs:
            exact_candidates.extend(exact_matches_by_ref.get(ref, []))

        merged_candidates = _merge_unique_chunks(
            exact_candidates + workspace_candidates + retrieved_candidates
        )
        if settings.rag_domain_filter_enabled:
            domain_filtered_candidates, domain_filter_applied, domain_filter_query_domains, domain_filter_in_domain_count = filter_candidates_by_query_domains(
                query=retrieval_query,
                candidates=merged_candidates,
                top_k=candidate_pool_size,
                neutral_fallback_max=settings.rag_neutral_fallback_max,
            )
            if workspace_candidates:
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

        if adaptive_threshold_enabled:
            selected_chunks, threshold_final, adaptive_iterations, neutral_added = select_chunks_adaptive(
                ranked_candidates,
                min_score_threshold=settings.rag_min_score_threshold,
                threshold_floor=settings.rag_adaptive_threshold_floor,
                threshold_step=settings.rag_adaptive_threshold_step,
                target_min=settings.rag_target_min_chunks,
                target_max=settings.rag_target_max_chunks,
                neutral_fallback_max=settings.rag_neutral_fallback_max,
                article_refs=article_refs,
                exact_matches_by_ref=exact_matches_by_ref_for_selection,
            )
            # select_chunks_adaptive already enforces article coverage.
            if article_refs and exact_matches_by_ref_for_selection:
                coverage_applied = True
        else:
            selected_chunks, removed_by_threshold = filter_by_score_threshold(
                ranked_candidates,
                min_score_threshold=settings.rag_min_score_threshold,
            )
            selected_chunks, coverage_applied = enforce_article_reference_coverage(
                ranked_chunks=selected_chunks,
                article_refs=article_refs,
                exact_matches_by_ref=exact_matches_by_ref_for_selection,
                top_k=settings.rag_target_max_chunks,
            )
            if len(selected_chunks) > settings.rag_target_max_chunks:
                selected_chunks = selected_chunks[: settings.rag_target_max_chunks]
    except Exception as exc:  # noqa: BLE001
        return messages, [], f"RAG retrieval failed: {exc}", None

    if adaptive_threshold_enabled:
        removed_by_threshold = max(0, len(ranked_candidates) - len(selected_chunks))

    if settings.rag_relevance_check_enabled:
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

    if settings.rag_relevance_check_enabled and not relevance.is_relevant:
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
            f"target_range={settings.rag_target_min_chunks}-{settings.rag_target_max_chunks}"
        )
        rag_notes.append(f"workspace_candidates={workspace_candidate_count}")
        rag_notes.append(f"removed={removed_by_threshold}")
        rag_notes.append(f"adaptive_iterations={adaptive_iterations}")
        rag_notes.append(f"neutral_added={neutral_added}")
        rag_note = " | ".join(rag_notes)
        return [{"role": "system", "content": RAG_NO_CONTEXT_RESPONSE}, *messages], [], None, rag_note

    context_text, sources = format_retrieval_context(
        selected_chunks,
        max_chars=settings.rag_max_context_chars,
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
    if _is_article_319_topic(original_query):
        extra_system_messages.append(
            {
                "role": "system",
                "content": ARTICLE_319_SPECIAL_INSTRUCTIONS,
            }
        )
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
    rag_notes.append(f"confidence={confidence_level}")
    rag_notes.append(f"threshold_start={threshold_start:.2f}")
    rag_notes.append(f"threshold_final={threshold_final:.2f}")
    rag_notes.append(
        f"target_range={settings.rag_target_min_chunks}-{settings.rag_target_max_chunks}"
    )
    rag_notes.append(f"selected_chunks={len(selected_chunks)}")
    rag_notes.append(f"workspace_candidates={workspace_candidate_count}")
    rag_notes.append(f"removed={removed_by_threshold}")
    rag_notes.append(f"adaptive_iterations={adaptive_iterations}")
    rag_notes.append(f"neutral_added={neutral_added}")
    rag_notes.append(f"citation_target={settings.rag_min_source_citations}")
    rag_notes.append(f"best={best_score:.3f}")
    rag_notes.append(f"mean={mean_score:.3f}")
    if any(msg.get("content") == ARTICLE_319_SPECIAL_INSTRUCTIONS for msg in extra_system_messages):
        rag_notes.append("article-319-special-rule")
    if any(msg.get("content") == DEFINITION_FOCUS_INSTRUCTIONS for msg in extra_system_messages):
        rag_notes.append("definition-focus")
    if any(msg.get("content") == ACT_GENERATION_INSTRUCTIONS for msg in extra_system_messages):
        rag_notes.append("act-generation-mode")
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
    allow_headers=["Authorization", "Content-Type", "Accept", "Origin", "User-Agent"],
)
if settings.gzip_enabled:
    app.add_middleware(
        GZipMiddleware,
        minimum_size=settings.gzip_min_size,
    )


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
        },
        "workspace": {
            "enabled": True,
            "storage": "json-file",
            "path": "data/app_state/workspace_state.json",
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
async def chat(payload: ChatRequest):
    input_messages = [message.model_dump() for message in payload.messages]
    llm_messages, rag_sources, rag_error, rag_note = await _prepare_messages_with_rag(
        input_messages,
        rewrite_enabled_override=payload.rag_query_rewrite,
    )
    llm_messages = _normalize_messages_for_provider(llm_messages)

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
        "rag_enabled": settings.rag_enabled,
        "rag_source_count": len(rag_sources),
        "rag_sources": rag_sources,
    }
    if citation_underuse:
        response_payload["citation_underuse"] = True
    if rag_error:
        response_payload["rag_error"] = rag_error
    if rag_note:
        response_payload["rag_note"] = rag_note
    return response_payload


@app.post("/chat/stream")
async def chat_stream(payload: ChatRequest):
    input_messages = [message.model_dump() for message in payload.messages]
    llm_messages, rag_sources, rag_error, rag_note = await _prepare_messages_with_rag(
        input_messages,
        rewrite_enabled_override=payload.rag_query_rewrite,
    )
    llm_messages = _normalize_messages_for_provider(llm_messages)

    async def event_generator() -> AsyncGenerator[str, None]:
        stream_rag_note = rag_note
        meta_payload: dict[str, Any] = {
            "status": "started",
            "model": settings.llm_model,
            "rag_enabled": settings.rag_enabled,
            "rag_source_count": len(rag_sources),
            "rag_sources": rag_sources,
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
                    answer_parts.append(content)
                    yield _sse("token", {"text": content})
                    current_answer = "".join(answer_parts)
                    if _has_runaway_repetition(current_answer):
                        sanitized_answer, answer_sanitized = _sanitize_generated_answer(current_answer)
                        if answer_sanitized:
                            yield _sse("replace", {"text": sanitized_answer})
                        final_rag_note = _append_rag_note(stream_rag_note, "loop-guard-stop")
                        if answer_sanitized:
                            final_rag_note = _append_rag_note(final_rag_note, "answer-sanitized")
                        final_rag_note, citation_underuse = _check_citation_underuse(
                            answer=sanitized_answer,
                            rag_source_count=len(rag_sources),
                            rag_note=final_rag_note,
                        )
                        done_payload: dict[str, Any] = {"finish_reason": "loop_guard_stop"}
                        if final_rag_note:
                            done_payload["rag_note"] = final_rag_note
                        if citation_underuse:
                            done_payload["citation_underuse"] = True
                        yield _sse("done", done_payload)
                        return

                if choice.finish_reason:
                    final_answer = "".join(answer_parts)
                    final_answer, answer_sanitized = _sanitize_generated_answer(final_answer)
                    if answer_sanitized:
                        yield _sse("replace", {"text": final_answer})
                        stream_rag_note = _append_rag_note(stream_rag_note, "answer-sanitized")
                    final_rag_note, citation_underuse = _check_citation_underuse(
                        answer=final_answer,
                        rag_source_count=len(rag_sources),
                        rag_note=stream_rag_note,
                    )
                    done_payload: dict[str, Any] = {"finish_reason": choice.finish_reason}
                    if final_rag_note:
                        done_payload["rag_note"] = final_rag_note
                    if citation_underuse:
                        done_payload["citation_underuse"] = True
                    yield _sse("done", done_payload)
                    return

            final_answer = "".join(answer_parts)
            final_answer, answer_sanitized = _sanitize_generated_answer(final_answer)
            if answer_sanitized:
                yield _sse("replace", {"text": final_answer})
                stream_rag_note = _append_rag_note(stream_rag_note, "answer-sanitized")
            final_rag_note, citation_underuse = _check_citation_underuse(
                answer=final_answer,
                rag_source_count=len(rag_sources),
                rag_note=stream_rag_note,
            )
            done_payload = {"finish_reason": "stop"}
            if final_rag_note:
                done_payload["rag_note"] = final_rag_note
            if citation_underuse:
                done_payload["citation_underuse"] = True
            yield _sse("done", done_payload)
        except Exception as exc:  # noqa: BLE001
            yield _sse("error", {"detail": str(exc)})

    return StreamingResponse(event_generator(), media_type="text/event-stream")
