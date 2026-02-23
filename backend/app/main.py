from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, AsyncGenerator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from openai import AsyncOpenAI

from backend.retrieval import (
    FaissRetriever,
    enforce_article_reference_coverage,
    extract_query_article_refs,
    filter_candidates_by_query_domains,
    filter_by_score_threshold,
    format_retrieval_context,
    rerank_article_aware,
    score_context_relevance,
    select_chunks_adaptive,
)

from .config import get_settings
from .schemas import ChatRequest


def _sse(event: str, data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


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


settings = get_settings()
client = AsyncOpenAI(
    base_url=settings.llm_base_url,
    api_key=settings.llm_api_key,
)

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


@lru_cache(maxsize=1)
def get_retriever() -> FaissRetriever:
    return FaissRetriever(
        index_dir=Path(settings.rag_index_dir),
        model_name=settings.rag_embedding_model,
        device=settings.rag_embedding_device,
        normalize_query_embeddings=True,
        reranker_model_name=settings.rag_reranker_model if settings.rag_reranker_enabled else None,
        reranker_device=settings.rag_reranker_device,
        reranker_batch_size=settings.rag_reranker_batch_size,
    )


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
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None, str | None]:
    if not settings.rag_enabled:
        return messages, [], None, None

    original_query, query_source = _extract_query_for_rag(messages)
    if not original_query:
        return messages, [], "RAG skipped: no usable message found.", None

    retriever = get_retriever()
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
    try:
        reranker_pool_size = (
            settings.rag_reranker_pool_size if settings.rag_reranker_enabled else settings.rag_top_k
        )
        candidate_pool_size = max(
            settings.rag_top_k,
            settings.rag_top_k * RAG_RETRIEVAL_OVERFETCH_FACTOR,
            reranker_pool_size,
            settings.rag_target_max_chunks,
        )
        # Recherche RAG avec la question originale
        retrieved_candidates = retriever.search_hybrid(
            query=original_query,
            top_k=candidate_pool_size,
            candidate_pool_size=candidate_pool_size,
        )
        # Recherche exacte des articles mentionnes dans la query originale
        exact_matches_by_ref = retriever.find_exact_article_matches(
            query=original_query,
            refs=article_refs,
            per_ref_limit=4,
        )
        exact_candidates: list[Any] = []
        for ref in article_refs:
            exact_candidates.extend(exact_matches_by_ref.get(ref, []))

        merged_candidates = _merge_unique_chunks(exact_candidates + retrieved_candidates)
        if settings.rag_domain_filter_enabled:
            domain_filtered_candidates, domain_filter_applied, domain_filter_query_domains, domain_filter_in_domain_count = filter_candidates_by_query_domains(
                query=original_query,
                candidates=merged_candidates,
                top_k=candidate_pool_size,
                neutral_fallback_max=settings.rag_neutral_fallback_max,
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
            query=original_query,
            candidates=domain_filtered_candidates,
            top_k=candidate_pool_size,
        )
        if settings.rag_reranker_enabled:
            ranked_candidates, reranker_applied, reranker_error = retriever.rerank_with_cross_encoder(
                query=original_query,
                candidates=pre_ranked,
                top_k=candidate_pool_size,
                candidate_pool_size=settings.rag_reranker_pool_size,
            )
        else:
            ranked_candidates = pre_ranked[:candidate_pool_size]

        if settings.rag_adaptive_threshold_enabled:
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

    if settings.rag_adaptive_threshold_enabled:
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
        rag_notes.append("no-reliable-context")
        rag_notes.append(f"threshold_start={threshold_start:.2f}")
        rag_notes.append(f"threshold_final={threshold_final:.2f}")
        rag_notes.append(f"selected_chunks={len(selected_chunks)}")
        rag_notes.append(
            f"target_range={settings.rag_target_min_chunks}-{settings.rag_target_max_chunks}"
        )
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
    special_system_message: dict[str, str] | None = None
    if _is_article_319_topic(original_query):
        special_system_message = {
            "role": "system",
            "content": ARTICLE_319_SPECIAL_INSTRUCTIONS,
        }

    rag_notes: list[str] = []
    if query_source and query_source != "user":
        rag_notes.append(f"RAG query source={query_source}")
    if article_refs and exact_matches_by_ref:
        rag_notes.append("article-exact-match")
    if rerank_applied:
        rag_notes.append("article-aware-rerank")
    if settings.rag_domain_filter_enabled and domain_filter_query_domains:
        rag_notes.append(f"domains={','.join(domain_filter_query_domains)}")
        rag_notes.append(f"in_domain_candidates={domain_filter_in_domain_count}")
        if domain_filter_applied:
            rag_notes.append("domain-filter")
    if settings.rag_reranker_enabled:
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
    rag_notes.append(f"removed={removed_by_threshold}")
    rag_notes.append(f"adaptive_iterations={adaptive_iterations}")
    rag_notes.append(f"neutral_added={neutral_added}")
    rag_notes.append(f"citation_target={settings.rag_min_source_citations}")
    rag_notes.append(f"best={best_score:.3f}")
    rag_notes.append(f"mean={mean_score:.3f}")
    if special_system_message is not None:
        rag_notes.append("article-319-special-rule")
    rag_note = " | ".join(rag_notes) if rag_notes else None

    if special_system_message is None:
        return [rag_system_message, *messages], sources, None, rag_note
    return [rag_system_message, special_system_message, *messages], sources, None, rag_note


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


app = FastAPI(title="Chatbot Juridique API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_no_cache_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(RuntimeError)
async def runtime_error_handler(_: Request, exc: RuntimeError):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "provider": settings.llm_provider,
        "model": settings.llm_model,
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
        },
    }


@app.post("/chat")
async def chat(payload: ChatRequest):
    input_messages = [message.model_dump() for message in payload.messages]
    llm_messages, rag_sources, rag_error, rag_note = await _prepare_messages_with_rag(input_messages)

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
    llm_messages, rag_sources, rag_error, rag_note = await _prepare_messages_with_rag(input_messages)

    async def event_generator() -> AsyncGenerator[str, None]:
        meta_payload: dict[str, Any] = {
            "status": "started",
            "model": settings.llm_model,
            "rag_enabled": settings.rag_enabled,
            "rag_source_count": len(rag_sources),
            "rag_sources": rag_sources,
        }
        if rag_error:
            meta_payload["rag_error"] = rag_error
        if rag_note:
            meta_payload["rag_note"] = rag_note
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

                if choice.finish_reason:
                    final_answer = "".join(answer_parts)
                    final_rag_note, citation_underuse = _check_citation_underuse(
                        answer=final_answer,
                        rag_source_count=len(rag_sources),
                        rag_note=rag_note,
                    )
                    done_payload: dict[str, Any] = {"finish_reason": choice.finish_reason}
                    if final_rag_note:
                        done_payload["rag_note"] = final_rag_note
                    if citation_underuse:
                        done_payload["citation_underuse"] = True
                    yield _sse("done", done_payload)
                    return

            final_answer = "".join(answer_parts)
            final_rag_note, citation_underuse = _check_citation_underuse(
                answer=final_answer,
                rag_source_count=len(rag_sources),
                rag_note=rag_note,
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
