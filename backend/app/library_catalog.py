from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .paths import LEGAL_DATA_DIR

def _classify_folder(folder_name: str) -> str:
    # Classement volontairement simple: la categorie vient du nom du dossier parent.
    # Normalisation d'affichage:
    # - PDFs_OHADA -> OHADA
    # - sinon: premiere lettre majuscule, le reste en minuscule.
    cleaned = re.sub(r"[_-]+", " ", (folder_name or "").strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return "Non classe"

    lowered = cleaned.lower()
    if lowered in {"pdf ohada", "pdfs ohada"}:
        return "OHADA"

    return cleaned[:1].upper() + cleaned[1:].lower()


def _title_from_stem(stem: str) -> str:
    cleaned = stem.replace("_", " ").replace("-", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return "Document"
    return cleaned[0].upper() + cleaned[1:]


def _doc_id(relative_path: str) -> str:
    return hashlib.sha1(relative_path.encode("utf-8")).hexdigest()[:20]


def _iso_mtime(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _normalize_sort_value(value: str) -> str:
    lowered = (value or "").strip().lower()
    if not lowered:
        return ""
    decomposed = unicodedata.normalize("NFKD", lowered)
    no_accents = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", no_accents).strip()


def _is_code_first_document(row: dict[str, Any]) -> bool:
    candidates = (
        str(row.get("title", "")),
        str(row.get("fileName", "")),
        str(row.get("folder", "")),
        str(row.get("category", "")),
    )
    for candidate in candidates:
        normalized = _normalize_sort_value(candidate)
        if normalized == "code" or normalized.startswith("code "):
            return True
    return False


def list_legal_pdf_documents() -> list[dict[str, Any]]:
    if not LEGAL_DATA_DIR.exists():
        return []

    rows: list[dict[str, Any]] = []
    for file_path in LEGAL_DATA_DIR.rglob("*.pdf"):
        if not file_path.is_file():
            continue
        try:
            relative = file_path.relative_to(LEGAL_DATA_DIR).as_posix()
        except ValueError:
            continue
        folder = file_path.parent.name
        rows.append(
            {
                "id": _doc_id(relative),
                "title": _title_from_stem(file_path.stem),
                "description": f"PDF juridique classe dans '{folder}'.",
                "category": _classify_folder(folder),
                "docType": "Textes de Loi",
                "folder": folder,
                "fileName": file_path.name,
                "relativePath": relative,
                "size": file_path.stat().st_size,
                "updatedAt": _iso_mtime(file_path),
            }
        )

    rows.sort(
        key=lambda row: (
            0 if _is_code_first_document(row) else 1,
            _normalize_sort_value(str(row.get("category", ""))),
            _normalize_sort_value(str(row.get("folder", ""))),
            _normalize_sort_value(str(row.get("title", ""))),
        )
    )
    return rows


def resolve_document_path(relative_path: str) -> Path:
    base = LEGAL_DATA_DIR.resolve()
    candidate = (LEGAL_DATA_DIR / relative_path).resolve()
    if base not in candidate.parents and candidate != base:
        raise ValueError("Invalid path.")
    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError(relative_path)
    return candidate
