from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .paths import data_path

WORKSPACE_STATE_PATH = data_path("app_state", "workspace_state.json")

_STATE_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_state() -> dict[str, Any]:
    return {
        "consultations": [],
        "notes": "",
        "files": [],
    }


def _normalize_consultation(raw: dict[str, Any]) -> dict[str, Any]:
    now = _now_iso()
    status = "error" if str(raw.get("status", "done")).strip().lower() == "error" else "done"
    source_count_raw = raw.get("sourceCount", 0)
    try:
        source_count = max(0, int(source_count_raw))
    except (TypeError, ValueError):
        source_count = 0
    return {
        "id": str(raw.get("id", "")).strip(),
        "question": str(raw.get("question", "")).strip(),
        "answer": str(raw.get("answer", "")).strip(),
        "status": status,
        "finishReason": str(raw.get("finishReason", "")).strip(),
        "ragNote": str(raw.get("ragNote", "")).strip(),
        "sourceCount": source_count,
        "createdAt": str(raw.get("createdAt", now)) or now,
        "updatedAt": str(raw.get("updatedAt", now)) or now,
    }


def _normalize_file(raw: dict[str, Any]) -> dict[str, Any]:
    now = _now_iso()
    size_raw = raw.get("size", 0)
    try:
        size = max(0, int(size_raw))
    except (TypeError, ValueError):
        size = 0
    return {
        "id": str(raw.get("id", "")).strip(),
        "name": str(raw.get("name", "")).strip(),
        "size": size,
        "addedAt": str(raw.get("addedAt", now)) or now,
    }


def _parse_timestamp(value: str) -> float:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _read_state_unlocked() -> dict[str, Any]:
    if not WORKSPACE_STATE_PATH.exists():
        return _default_state()
    try:
        raw = json.loads(WORKSPACE_STATE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _default_state()

    if not isinstance(raw, dict):
        return _default_state()

    consultations_raw = raw.get("consultations", [])
    files_raw = raw.get("files", [])
    notes_raw = raw.get("notes", "")

    consultations: list[dict[str, Any]] = []
    if isinstance(consultations_raw, list):
        for item in consultations_raw:
            if isinstance(item, dict):
                normalized = _normalize_consultation(item)
                if normalized["id"]:
                    consultations.append(normalized)

    files: list[dict[str, Any]] = []
    if isinstance(files_raw, list):
        for item in files_raw:
            if isinstance(item, dict):
                normalized = _normalize_file(item)
                if normalized["id"] and normalized["name"]:
                    files.append(normalized)

    notes = str(notes_raw) if isinstance(notes_raw, str) else ""

    return {
        "consultations": consultations,
        "notes": notes,
        "files": files,
    }


def _write_state_unlocked(state: dict[str, Any]) -> None:
    _ensure_parent_dir(WORKSPACE_STATE_PATH)
    temp_path = WORKSPACE_STATE_PATH.with_suffix(".tmp")
    payload = json.dumps(state, ensure_ascii=False, indent=2)
    temp_path.write_text(payload, encoding="utf-8")
    temp_path.replace(WORKSPACE_STATE_PATH)


def _sort_consultations(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        items,
        key=lambda item: _parse_timestamp(str(item.get("updatedAt", ""))),
        reverse=True,
    )


def _sort_files(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        items,
        key=lambda item: _parse_timestamp(str(item.get("addedAt", ""))),
        reverse=True,
    )


def read_consultations() -> list[dict[str, Any]]:
    with _STATE_LOCK:
        state = _read_state_unlocked()
        return _sort_consultations(state["consultations"])


def upsert_consultation(record: dict[str, Any], *, max_items: int = 200) -> list[dict[str, Any]]:
    normalized = _normalize_consultation(record)
    if not normalized["id"]:
        return read_consultations()

    with _STATE_LOCK:
        state = _read_state_unlocked()
        existing = state["consultations"]

        index = -1
        for i, item in enumerate(existing):
            if item.get("id") == normalized["id"]:
                index = i
                break

        if index >= 0:
            created_at = existing[index].get("createdAt", normalized["createdAt"])
            normalized["createdAt"] = str(created_at) if created_at else normalized["createdAt"]
            existing[index] = normalized
        else:
            existing.append(normalized)

        ordered = _sort_consultations(existing)[: max(1, max_items)]
        state["consultations"] = ordered
        _write_state_unlocked(state)
        return ordered


def clear_consultations() -> list[dict[str, Any]]:
    with _STATE_LOCK:
        state = _read_state_unlocked()
        state["consultations"] = []
        _write_state_unlocked(state)
        return []


def remove_consultation(consultation_id: str) -> list[dict[str, Any]]:
    normalized_id = str(consultation_id).strip()
    if not normalized_id:
        return read_consultations()
    with _STATE_LOCK:
        state = _read_state_unlocked()
        state["consultations"] = [
            row for row in state["consultations"] if str(row.get("id")) != normalized_id
        ]
        state["consultations"] = _sort_consultations(state["consultations"])
        _write_state_unlocked(state)
        return state["consultations"]


def read_notes() -> str:
    with _STATE_LOCK:
        state = _read_state_unlocked()
        return str(state.get("notes", ""))


def write_notes(notes: str) -> str:
    with _STATE_LOCK:
        state = _read_state_unlocked()
        state["notes"] = str(notes)
        _write_state_unlocked(state)
        return state["notes"]


def read_files() -> list[dict[str, Any]]:
    with _STATE_LOCK:
        state = _read_state_unlocked()
        return _sort_files(state["files"])


def write_files(files: list[dict[str, Any]], *, max_items: int = 200) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        row = _normalize_file(item)
        if row["id"] and row["name"]:
            normalized.append(row)

    dedup: dict[str, dict[str, Any]] = {}
    for item in normalized:
        dedup[item["id"]] = item

    ordered = _sort_files(list(dedup.values()))[: max(1, max_items)]
    with _STATE_LOCK:
        state = _read_state_unlocked()
        state["files"] = ordered
        _write_state_unlocked(state)
        return ordered


def upsert_files(files: list[dict[str, Any]], *, max_items: int = 200) -> list[dict[str, Any]]:
    with _STATE_LOCK:
        state = _read_state_unlocked()
        dedup: dict[str, dict[str, Any]] = {item["id"]: item for item in state["files"] if item.get("id")}
        for item in files:
            if not isinstance(item, dict):
                continue
            row = _normalize_file(item)
            if row["id"] and row["name"]:
                dedup[row["id"]] = row

        ordered = _sort_files(list(dedup.values()))[: max(1, max_items)]
        state["files"] = ordered
        _write_state_unlocked(state)
        return ordered


def clear_files() -> list[dict[str, Any]]:
    with _STATE_LOCK:
        state = _read_state_unlocked()
        state["files"] = []
        _write_state_unlocked(state)
        return []


def remove_file(file_id: str) -> list[dict[str, Any]]:
    normalized_id = str(file_id).strip()
    if not normalized_id:
        return read_files()
    with _STATE_LOCK:
        state = _read_state_unlocked()
        state["files"] = [row for row in state["files"] if str(row.get("id")) != normalized_id]
        state["files"] = _sort_files(state["files"])
        _write_state_unlocked(state)
        return state["files"]
