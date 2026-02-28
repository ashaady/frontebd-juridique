from __future__ import annotations

import hashlib
import json
import re
import threading
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from docx import Document
from pypdf import PdfReader

from .paths import data_path

WORKSPACE_UPLOAD_DIR = data_path("app_state", "uploads")
WORKSPACE_RAG_JSONL_PATH = data_path("app_state", "workspace_rag.jsonl")

SUPPORTED_UPLOAD_EXTENSIONS = {".pdf", ".txt", ".md", ".docx"}

ARTICLE_HINT_RE = re.compile(
    r"\b(?:article|art\.?)\s+([A-Za-z]{1,3}\s*\.?\s*)?(\d+[A-Za-z0-9.\-]*)\b",
    re.IGNORECASE,
)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _normalize_spaces(text: str) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    return compact


def _normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text or "")
    normalized = normalized.replace("\x00", " ")
    lines = [line.strip() for line in normalized.splitlines()]
    kept = [line for line in lines if line]
    return "\n".join(kept).strip()


def _chunk_text(text: str, *, target_chars: int = 1600, overlap_chars: int = 220) -> list[str]:
    cleaned = _normalize_text(text)
    if not cleaned:
        return []
    if len(cleaned) <= target_chars:
        return [cleaned]

    chunks: list[str] = []
    start = 0
    total = len(cleaned)
    while start < total:
        end = min(total, start + target_chars)
        if end < total:
            split = cleaned.rfind("\n", start, end)
            if split <= start:
                split = cleaned.rfind(". ", start, end)
            if split > start + 300:
                end = split + 1
        chunk = cleaned[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= total:
            break
        start = max(0, end - overlap_chars)
    return chunks


def _extract_article_hint(text: str) -> str | None:
    match = ARTICLE_HINT_RE.search(text)
    if not match:
        return None
    full = match.group(0)
    return _normalize_spaces(full)[:120]


def _read_text_file(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def _read_pdf_file(path: Path) -> str:
    reader = PdfReader(str(path))
    parts: list[str] = []
    for page in reader.pages:
        page_text = page.extract_text() or ""
        if page_text.strip():
            parts.append(page_text)
    return "\n\n".join(parts)


def _read_docx_file(path: Path) -> str:
    doc = Document(str(path))
    paragraphs = [p.text for p in doc.paragraphs if p.text and p.text.strip()]
    return "\n".join(paragraphs)


def extract_text_from_file(path: Path) -> str:
    extension = path.suffix.lower()
    if extension in {".txt", ".md"}:
        return _read_text_file(path)
    if extension == ".pdf":
        return _read_pdf_file(path)
    if extension == ".docx":
        return _read_docx_file(path)
    raise ValueError(f"unsupported extension: {extension}")


@dataclass(frozen=True)
class WorkspaceRagChunk:
    chunk_id: str
    file_id: str
    file_name: str
    relative_path: str
    source_path: str
    text: str
    article_hint: str | None
    uploaded_at: str
    embedding: list[float]


@dataclass(frozen=True)
class RetrievedChunk:
    rank: int
    score: float
    chunk_id: str
    text: str
    doc_id: str | None
    relative_path: str | None
    source_path: str | None
    page_start: int | None
    page_end: int | None
    article_hint: str | None

    def citation(self) -> str:
        source = self.relative_path or self.source_path or "unknown-source"
        if isinstance(self.page_start, int) and isinstance(self.page_end, int):
            if self.page_start == self.page_end:
                return f"{source} (p. {self.page_start})"
            return f"{source} (pp. {self.page_start}-{self.page_end})"
        if isinstance(self.page_start, int):
            return f"{source} (p. {self.page_start})"
        return source

    def to_source_dict(self) -> dict[str, Any]:
        return {
            "rank": self.rank,
            "score": self.score,
            "chunk_id": self.chunk_id,
            "citation": self.citation(),
            "relative_path": self.relative_path,
            "source_path": self.source_path,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "article_hint": self.article_hint,
        }


class WorkspaceRagIndex:
    def __init__(self, model_name: str, device: str | None = None) -> None:
        self.model_name = model_name
        self.device = device
        self._lock = threading.Lock()
        self._model: Any | None = None
        self._loaded = False
        self._chunks: list[WorkspaceRagChunk] = []
        self._embeddings: np.ndarray | None = None

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            from sentence_transformers import SentenceTransformer
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "sentence-transformers is required for workspace file embeddings."
            ) from exc
        kwargs: dict[str, Any] = {}
        if self.device:
            kwargs["device"] = self.device
        self._model = SentenceTransformer(self.model_name, **kwargs)
        return self._model

    def _ensure_loaded(self) -> None:
        with self._lock:
            if self._loaded:
                return
            if not WORKSPACE_RAG_JSONL_PATH.exists():
                self._chunks = []
                self._embeddings = None
                self._loaded = True
                return

            rows: list[WorkspaceRagChunk] = []
            vectors: list[np.ndarray] = []
            with WORKSPACE_RAG_JSONL_PATH.open("r", encoding="utf-8", errors="ignore") as handle:
                for line in handle:
                    value = line.strip()
                    if not value or not value.startswith("{"):
                        continue
                    try:
                        obj = json.loads(value)
                    except json.JSONDecodeError:
                        continue
                    embedding_raw = obj.get("embedding")
                    if not isinstance(embedding_raw, list) or not embedding_raw:
                        continue
                    try:
                        vec = np.asarray(embedding_raw, dtype=np.float32)
                    except Exception:
                        continue
                    if vec.ndim != 1 or vec.size == 0:
                        continue
                    row = WorkspaceRagChunk(
                        chunk_id=str(obj.get("chunk_id", "")).strip(),
                        file_id=str(obj.get("file_id", "")).strip(),
                        file_name=str(obj.get("file_name", "")).strip(),
                        relative_path=str(obj.get("relative_path", "")).strip(),
                        source_path=str(obj.get("source_path", "")).strip(),
                        text=str(obj.get("text", "")).strip(),
                        article_hint=(
                            str(obj.get("article_hint")).strip()
                            if obj.get("article_hint") is not None
                            else None
                        ),
                        uploaded_at=str(obj.get("uploaded_at", "")).strip() or _utc_now_iso(),
                        embedding=vec.tolist(),
                    )
                    if not row.chunk_id or not row.file_id or not row.text:
                        continue
                    rows.append(row)
                    vectors.append(vec)

            self._chunks = rows
            self._embeddings = np.vstack(vectors).astype(np.float32, copy=False) if vectors else None
            self._loaded = True

    def _persist_locked(self) -> None:
        _ensure_dir(WORKSPACE_RAG_JSONL_PATH.parent)
        temp_path = WORKSPACE_RAG_JSONL_PATH.with_suffix(".tmp")
        with temp_path.open("w", encoding="utf-8") as handle:
            for row in self._chunks:
                payload = {
                    "chunk_id": row.chunk_id,
                    "file_id": row.file_id,
                    "file_name": row.file_name,
                    "relative_path": row.relative_path,
                    "source_path": row.source_path,
                    "text": row.text,
                    "article_hint": row.article_hint,
                    "uploaded_at": row.uploaded_at,
                    "embedding": row.embedding,
                }
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
        temp_path.replace(WORKSPACE_RAG_JSONL_PATH)

    def _encode(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, 0), dtype=np.float32)
        model = self._load_model()
        vectors = model.encode(
            list(texts),
            show_progress_bar=False,
            convert_to_numpy=True,
            normalize_embeddings=True,
        )
        matrix = np.asarray(vectors, dtype=np.float32)
        if matrix.ndim == 1:
            matrix = np.expand_dims(matrix, axis=0)
        return matrix

    def ingest_file(
        self,
        *,
        file_id: str,
        file_name: str,
        source_path: Path,
        relative_path: str,
    ) -> int:
        self._ensure_loaded()
        text = extract_text_from_file(source_path)
        pieces = _chunk_text(text)
        if not pieces:
            return 0

        embeddings = self._encode(pieces)
        uploaded_at = _utc_now_iso()
        new_chunks: list[WorkspaceRagChunk] = []
        for index, piece in enumerate(pieces):
            digest = hashlib.sha1(f"{file_id}|{index}|{piece}".encode("utf-8")).hexdigest()[:16]
            chunk_id = f"workspace-{file_id}-{digest}"
            hint = _extract_article_hint(piece)
            vec = embeddings[index].tolist()
            row = WorkspaceRagChunk(
                chunk_id=chunk_id,
                file_id=file_id,
                file_name=file_name,
                relative_path=relative_path,
                source_path=str(source_path),
                text=piece,
                article_hint=hint,
                uploaded_at=uploaded_at,
                embedding=vec,
            )
            new_chunks.append(row)

        with self._lock:
            existing = [chunk for chunk in self._chunks if chunk.file_id != file_id]
            existing.extend(new_chunks)
            self._chunks = existing
            if self._chunks:
                self._embeddings = np.asarray([row.embedding for row in self._chunks], dtype=np.float32)
            else:
                self._embeddings = None
            self._persist_locked()
        return len(new_chunks)

    def remove_file(self, file_id: str) -> int:
        self._ensure_loaded()
        with self._lock:
            before = len(self._chunks)
            self._chunks = [row for row in self._chunks if row.file_id != file_id]
            removed = before - len(self._chunks)
            if removed <= 0:
                return 0
            if self._chunks:
                self._embeddings = np.asarray([row.embedding for row in self._chunks], dtype=np.float32)
            else:
                self._embeddings = None
            self._persist_locked()
            return removed

    def clear(self) -> None:
        self._ensure_loaded()
        with self._lock:
            self._chunks = []
            self._embeddings = None
            _ensure_dir(WORKSPACE_RAG_JSONL_PATH.parent)
            if WORKSPACE_RAG_JSONL_PATH.exists():
                WORKSPACE_RAG_JSONL_PATH.unlink()

    def search(self, query: str, *, top_k: int) -> list[RetrievedChunk]:
        self._ensure_loaded()
        query_text = query.strip()
        if not query_text or top_k < 1:
            return []

        with self._lock:
            if not self._chunks or self._embeddings is None:
                return []
            matrix = self._embeddings
            chunks = list(self._chunks)

        query_vec = self._encode([query_text])[0]
        scores = np.dot(matrix, query_vec)
        if scores.ndim != 1 or scores.size == 0:
            return []

        limit = min(int(top_k), scores.size)
        indices = np.argpartition(scores, -limit)[-limit:]
        ordered = sorted(indices.tolist(), key=lambda idx: float(scores[idx]), reverse=True)

        rows: list[RetrievedChunk] = []
        for rank, idx in enumerate(ordered, start=1):
            chunk = chunks[idx]
            rows.append(
                RetrievedChunk(
                    rank=rank,
                    score=float(scores[idx]),
                    chunk_id=chunk.chunk_id,
                    text=chunk.text,
                    doc_id=f"workspace:{chunk.file_id}",
                    relative_path=chunk.relative_path,
                    source_path=chunk.source_path,
                    page_start=None,
                    page_end=None,
                    article_hint=chunk.article_hint,
                )
            )
        return rows
