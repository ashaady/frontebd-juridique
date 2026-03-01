from __future__ import annotations

import json
import math
import re
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..library_catalog import list_legal_pdf_documents, resolve_document_path
from ..paths import data_path

router = APIRouter(prefix="/library", tags=["library"])
CHUNKS_JSONL_PATH = data_path("chunks", "chunks.jsonl")
WORKSPACE_RAG_JSONL_PATH = data_path("app_state", "workspace_rag.jsonl")


class ChunkResolvePayload(BaseModel):
    chunk_ids: list[str] = Field(default_factory=list, max_length=64)


def _normalize_for_search(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    no_accents = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    lowered = no_accents.lower().replace("’", "'").replace("_", " ")
    return re.sub(r"\s+", " ", lowered).strip()


def _normalize_relative_path(value: str) -> str:
    return _normalize_for_search((value or "").replace("\\", "/").strip("/"))


def _build_haystack(row: dict[str, Any]) -> str:
    return " ".join(
        [
            str(row.get("title", "")),
            str(row.get("description", "")),
            str(row.get("folder", "")),
            str(row.get("fileName", "")),
            str(row.get("category", "")),
            str(row.get("docType", "")),
            str(row.get("sectionLabel", "")),
            str(row.get("sectionTitle", "")),
            str(row.get("blockLabel", "")),
            str(row.get("blockTitle", "")),
            str(row.get("subCategory", "")),
            str(row.get("curationNote", "")),
            str(row.get("relativePath", "")),
        ]
    )


def _score_term(
    normalized_text: str,
    value: str,
    *,
    weight: float,
    min_token_coverage: float = 0.34,
) -> tuple[bool, float]:
    term = _normalize_for_search(value)
    if not term:
        return True, 0.0

    if term in normalized_text:
        hit_count = normalized_text.count(term)
        return True, weight * min(3.0, 1.0 + 0.35 * max(0, hit_count - 1))

    tokens = [token for token in term.split(" ") if len(token) >= 3]
    if not tokens:
        return False, 0.0
    matches = sum(1 for token in tokens if token in normalized_text)
    coverage = matches / len(tokens)
    if coverage < min_token_coverage:
        return False, 0.0
    return True, weight * coverage * 0.9


def _score_article(normalized_text: str, value: str) -> tuple[bool, float]:
    term = _normalize_for_search(value)
    if not term:
        return True, 0.0
    if term in normalized_text:
        return True, 3.2

    number_match = re.search(r"\d+", term)
    if not number_match:
        return False, 0.0

    number = number_match.group(0)
    article_tokens = (
        f"article {number}",
        f"art {number}",
        f"art.{number}",
        f"art-{number}",
    )
    hits = sum(1 for token in article_tokens if token in normalized_text)
    if hits == 0:
        return False, 0.0
    return True, 2.8 + min(1.2, 0.25 * hits)


def _chunks_cache_key(path: Path) -> tuple[str, str]:
    if not path.exists():
        return str(path), "missing"
    stat = path.stat()
    return str(path), f"{stat.st_mtime_ns}:{stat.st_size}"


@lru_cache(maxsize=2)
def _read_chunk_entries_cached(path_value: str, cache_stamp: str) -> tuple[dict[str, Any], ...]:
    chunk_path = Path(path_value)
    if cache_stamp == "missing" or not chunk_path.exists():
        return ()

    entries: list[dict[str, Any]] = []
    with chunk_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            raw = line.strip()
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue

            text = str(payload.get("text", "")).strip()
            relative_path = str(payload.get("relative_path", "")).strip()
            if not text or not relative_path:
                continue

            text_flat = re.sub(r"\s+", " ", text).strip()
            entries.append(
                {
                    "relative_path_norm": _normalize_relative_path(relative_path),
                    "text_norm": _normalize_for_search(text),
                    "snippet": text_flat[:320],
                    "page_start": payload.get("page_start"),
                    "page_end": payload.get("page_end"),
                }
            )
    return tuple(entries)


def _read_chunk_entries() -> tuple[dict[str, Any], ...]:
    path_value, cache_stamp = _chunks_cache_key(CHUNKS_JSONL_PATH)
    return _read_chunk_entries_cached(path_value, cache_stamp)


def _search_documents_with_chunks(
    rows: list[dict[str, Any]],
    *,
    q: str,
    article: str,
    keyword: str,
    infraction_type: str,
    jurisdiction: str,
) -> list[dict[str, Any]]:
    chunks = _read_chunk_entries()
    if not chunks:
        return []

    rows_by_relative = {
        _normalize_relative_path(str(row.get("relativePath", ""))): row
        for row in rows
        if str(row.get("relativePath", "")).strip()
    }
    rows_by_id = {str(row.get("id", "")): row for row in rows}
    row_order = {str(row.get("id", "")): idx for idx, row in enumerate(rows)}

    stats: dict[str, dict[str, Any]] = {}
    for chunk in chunks:
        row = rows_by_relative.get(str(chunk.get("relative_path_norm", "")))
        if row is None:
            continue

        text_norm = str(chunk.get("text_norm", ""))
        q_ok, q_score = _score_term(text_norm, q, weight=2.2, min_token_coverage=0.3)
        article_ok, article_score = _score_article(text_norm, article)
        keyword_ok, keyword_score = _score_term(text_norm, keyword, weight=2.6, min_token_coverage=0.28)
        infraction_ok, infraction_score = _score_term(
            text_norm,
            infraction_type,
            weight=2.8,
            min_token_coverage=0.28,
        )
        jurisdiction_ok, jurisdiction_score = _score_term(
            text_norm,
            jurisdiction,
            weight=2.8,
            min_token_coverage=0.28,
        )
        if not (q_ok and article_ok and keyword_ok and infraction_ok and jurisdiction_ok):
            continue

        row_id = str(row.get("id", ""))
        chunk_score = q_score + article_score + keyword_score + infraction_score + jurisdiction_score
        slot = stats.setdefault(
            row_id,
            {
                "best_chunk_score": 0.0,
                "matched_chunk_count": 0,
                "matched_pages": set(),
                "matched_snippet": "",
            },
        )
        slot["matched_chunk_count"] += 1
        page_start = chunk.get("page_start")
        if isinstance(page_start, int):
            slot["matched_pages"].add(page_start)
        if chunk_score > float(slot["best_chunk_score"]):
            slot["best_chunk_score"] = chunk_score
            slot["matched_snippet"] = str(chunk.get("snippet", ""))

    ranked: list[dict[str, Any]] = []
    for row_id, summary in stats.items():
        base = rows_by_id.get(row_id)
        if base is None:
            continue
        matched_chunk_count = int(summary["matched_chunk_count"])
        best_chunk_score = float(summary["best_chunk_score"])
        search_score = round(best_chunk_score + math.log1p(matched_chunk_count) * 0.65, 4)
        ranked.append(
            {
                **base,
                "searchScore": search_score,
                "matchedChunkCount": matched_chunk_count,
                "matchedPages": sorted(summary["matched_pages"])[:16],
                "matchedSnippet": summary["matched_snippet"],
            }
        )

    ranked.sort(
        key=lambda row: (
            -float(row.get("searchScore", 0.0)),
            -int(row.get("matchedChunkCount", 0)),
            row_order.get(str(row.get("id", "")), 10**9),
        )
    )
    return ranked


def _search_documents_with_metadata(
    rows: list[dict[str, Any]],
    *,
    q: str,
    article: str,
    keyword: str,
    infraction_type: str,
    jurisdiction: str,
) -> list[dict[str, Any]]:
    matched: list[dict[str, Any]] = []
    for row in rows:
        haystack_norm = _normalize_for_search(_build_haystack(row))
        q_ok, q_score = _score_term(haystack_norm, q, weight=1.4)
        article_ok, article_score = _score_article(haystack_norm, article)
        keyword_ok, keyword_score = _score_term(haystack_norm, keyword, weight=1.7)
        infraction_ok, infraction_score = _score_term(haystack_norm, infraction_type, weight=1.8)
        jurisdiction_ok, jurisdiction_score = _score_term(haystack_norm, jurisdiction, weight=1.8)

        if not (q_ok and article_ok and keyword_ok and infraction_ok and jurisdiction_ok):
            continue

        score = q_score + article_score + keyword_score + infraction_score + jurisdiction_score
        matched.append({**row, "searchScore": round(score, 4)})

    matched.sort(key=lambda row: -float(row.get("searchScore", 0.0)))
    return matched


def _resolve_document_or_404(document_id: str) -> dict[str, Any]:
    rows = list_legal_pdf_documents()
    selected = next((row for row in rows if row.get("id") == document_id), None)
    if selected is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return selected


def _iter_chunk_paths() -> tuple[Path, ...]:
    return (CHUNKS_JSONL_PATH, WORKSPACE_RAG_JSONL_PATH)


def _resolve_chunks_by_ids(chunk_ids: list[str]) -> list[dict[str, Any]]:
    if not chunk_ids:
        return []

    wanted = {chunk_id: True for chunk_id in chunk_ids if chunk_id}
    if not wanted:
        return []

    found: dict[str, dict[str, Any]] = {}
    for chunk_path in _iter_chunk_paths():
        if not chunk_path.exists():
            continue
        with chunk_path.open("r", encoding="utf-8", errors="ignore") as handle:
            for line in handle:
                if len(found) >= len(wanted):
                    break
                raw = line.strip()
                if not raw:
                    continue
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                chunk_id = str(payload.get("chunk_id", "")).strip()
                if not chunk_id or chunk_id not in wanted or chunk_id in found:
                    continue

                text = str(payload.get("text", "")).strip()
                if not text:
                    continue
                snippet = re.sub(r"\s+", " ", text).strip()[:420]
                found[chunk_id] = {
                    "chunk_id": chunk_id,
                    "text": text,
                    "snippet": snippet,
                    "relative_path": payload.get("relative_path"),
                    "source_path": payload.get("source_path"),
                    "page_start": payload.get("page_start"),
                    "page_end": payload.get("page_end"),
                    "article_hint": payload.get("article_hint"),
                }

    return [found[chunk_id] for chunk_id in chunk_ids if chunk_id in found]


@router.get("/documents")
async def library_list_documents(
    q: str = "",
    category: str = "",
    article: str = "",
    keyword: str = "",
    infraction_type: str = "",
    jurisdiction: str = "",
    document_id: str = "",
):
    rows = list_legal_pdf_documents()
    category_filter = category.strip().lower()
    document_id_filter = document_id.strip()

    base_rows: list[dict[str, Any]] = []
    for row in rows:
        if category_filter:
            row_category = str(row.get("category", "")).strip().lower()
            if row_category != category_filter:
                continue
        if document_id_filter and str(row.get("id", "")) != document_id_filter:
            continue
        base_rows.append(row)

    use_chunk_search = any(
        value.strip()
        for value in [
            q,
            article,
            keyword,
            infraction_type,
            jurisdiction,
        ]
    )

    if use_chunk_search:
        filtered = _search_documents_with_chunks(
            base_rows,
            q=q,
            article=article,
            keyword=keyword,
            infraction_type=infraction_type,
            jurisdiction=jurisdiction,
        )
        if not filtered:
            filtered = _search_documents_with_metadata(
                base_rows,
                q=q,
                article=article,
                keyword=keyword,
                infraction_type=infraction_type,
                jurisdiction=jurisdiction,
            )
    else:
        filtered = base_rows

    items: list[dict[str, Any]] = []
    for row in filtered:
        row_id = str(row.get("id", ""))
        items.append(
            {
                **row,
                "viewUrl": f"/library/documents/{row_id}/view",
                "rawUrl": f"/library/documents/{row_id}/raw",
                "downloadUrl": f"/library/documents/{row_id}/download",
            }
        )

    return {"items": items, "total": len(items)}


@router.post("/chunks/resolve")
async def library_resolve_chunks(payload: ChunkResolvePayload):
    chunk_ids: list[str] = []
    seen: set[str] = set()
    for raw_chunk_id in payload.chunk_ids:
        chunk_id = str(raw_chunk_id).strip()
        if not chunk_id or chunk_id in seen:
            continue
        seen.add(chunk_id)
        chunk_ids.append(chunk_id)
        if len(chunk_ids) >= 64:
            break

    items = _resolve_chunks_by_ids(chunk_ids)
    return {
        "items": items,
        "requested": len(chunk_ids),
        "resolved": len(items),
    }


@router.get("/documents/{document_id}/view")
async def library_view_document(document_id: str):
    selected = _resolve_document_or_404(document_id)

    relative_path = str(selected.get("relativePath", ""))
    try:
        disk_path = resolve_document_path(relative_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document file not found.")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid document path.")

    file_name = str(selected.get("fileName", "document.pdf"))
    return FileResponse(
        path=disk_path,
        media_type="application/pdf",
        filename=file_name,
        content_disposition_type="inline",
    )


@router.get("/documents/{document_id}/raw")
async def library_read_document_bytes(document_id: str):
    selected = _resolve_document_or_404(document_id)

    relative_path = str(selected.get("relativePath", ""))
    try:
        disk_path = resolve_document_path(relative_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document file not found.")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid document path.")

    file_name = str(selected.get("fileName", "document.pdf"))
    return FileResponse(
        path=disk_path,
        media_type="application/pdf",
        filename=file_name,
        content_disposition_type="inline",
    )


@router.get("/documents/{document_id}/download")
async def library_download_document(document_id: str):
    selected = _resolve_document_or_404(document_id)

    relative_path = str(selected.get("relativePath", ""))
    try:
        disk_path = resolve_document_path(relative_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Document file not found.")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid document path.")

    return FileResponse(
        path=disk_path,
        media_type="application/pdf",
        filename=str(selected.get("fileName", "document.pdf")),
    )
