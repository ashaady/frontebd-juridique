from __future__ import annotations

import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .paths import data_path
from .workspace_supabase import SupabaseWorkspaceError, SupabaseWorkspaceStore

WORKSPACE_STATE_PATH = data_path("app_state", "workspace_state.json")

_STATE_LOCK = threading.Lock()
_LOGGER = logging.getLogger("backend.app.workspace_store")
_USER_ID_RE = re.compile(r"[^a-zA-Z0-9_.:@-]+")
_MAX_ITEMS_DEFAULT = 200

_WORKSPACE_STORAGE_BACKEND = (
    os.getenv("WORKSPACE_STORAGE_BACKEND", "json").strip().lower() or "json"
)


def _build_supabase_store() -> SupabaseWorkspaceStore | None:
    if _WORKSPACE_STORAGE_BACKEND not in {"supabase", "auto"}:
        return None
    store = SupabaseWorkspaceStore.from_env()
    if store is None and _WORKSPACE_STORAGE_BACKEND == "supabase":
        _LOGGER.warning(
            "WORKSPACE_STORAGE_BACKEND=supabase mais SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY "
            "manquants. Fallback vers stockage JSON local."
        )
    return store


_SUPABASE_STORE = _build_supabase_store()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_user_id(user_id: str | None) -> str:
    raw = str(user_id or "").strip()
    if not raw:
        return "anonymous"
    normalized = _USER_ID_RE.sub("_", raw).strip("._:-")
    if not normalized:
        return "anonymous"
    return normalized[:128]


def _normalize_profile_text(value: str | None, *, max_len: int = 320) -> str | None:
    parsed = str(value or "").strip()
    if not parsed:
        return None
    return parsed[:max_len]


def workspace_storage_summary() -> dict[str, Any]:
    if _SUPABASE_STORE is not None:
        return {
            "backend": "supabase",
            "fallback": "json-file",
            "path": "data/app_state/workspace_state.json",
            "supabase": _SUPABASE_STORE.public_info(),
        }
    return {
        "backend": "json-file",
        "path": "data/app_state/workspace_state.json",
    }


def register_user_context(
    *,
    user_id: str | None,
    email: str | None = None,
    username: str | None = None,
    display_name: str | None = None,
) -> None:
    normalized_user_id = _normalize_user_id(user_id)
    if normalized_user_id == "anonymous":
        return
    if _SUPABASE_STORE is None:
        return
    _try_supabase(
        "upsert_user_profile",
        lambda: _SUPABASE_STORE.upsert_user_profile(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            email=_normalize_profile_text(email),
            username=_normalize_profile_text(username),
            display_name=_normalize_profile_text(display_name),
        ),
    )


def _default_user_state() -> dict[str, Any]:
    return {
        "consultations": [],
        "notes": "",
        "files": [],
        "templates": [],
    }


def _default_state() -> dict[str, Any]:
    return {
        "users": {},
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


def _normalize_template_field(raw: dict[str, Any]) -> dict[str, Any]:
    key = str(raw.get("key", "")).strip()
    label = str(raw.get("label", "")).strip()
    if not key or not label:
        return {}
    raw_type = str(raw.get("type", "text")).strip().lower()
    field_type = raw_type if raw_type in {"text", "textarea", "date", "number", "select"} else "text"
    options_raw = raw.get("options", [])
    options: list[dict[str, str]] = []
    if isinstance(options_raw, list):
        for item in options_raw:
            if not isinstance(item, dict):
                continue
            value = str(item.get("value", "")).strip()
            label_value = str(item.get("label", "")).strip() or value
            if not value:
                continue
            options.append({"value": value, "label": label_value})
    return {
        "key": key,
        "label": label,
        "required": bool(raw.get("required", False)),
        "placeholder": str(raw.get("placeholder", "")).strip() or None,
        "type": field_type,
        "options": options if field_type == "select" and options else None,
        "hint": str(raw.get("hint", "")).strip() or None,
    }


def _normalize_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    rows: list[str] = []
    for item in value:
        parsed = str(item or "").strip()
        if parsed:
            rows.append(parsed)
    return rows


def _normalize_template(raw: dict[str, Any]) -> dict[str, Any]:
    now = _now_iso()
    template_id = str(raw.get("id", "")).strip()
    name = str(raw.get("name", "")).strip()
    if not template_id or not name:
        return {}
    complexity_raw = str(raw.get("complexity", "Simple")).strip().lower()
    complexity = "Simple"
    if complexity_raw == "intermediaire":
        complexity = "Intermediaire"
    elif complexity_raw == "avance":
        complexity = "Avance"

    fields: list[dict[str, Any]] = []
    fields_raw = raw.get("fields", [])
    if isinstance(fields_raw, list):
        for row in fields_raw:
            if not isinstance(row, dict):
                continue
            normalized = _normalize_template_field(row)
            if normalized:
                fields.append(normalized)

    return {
        "id": template_id,
        "name": name,
        "category": str(raw.get("category", "Modeles personnalises")).strip() or "Modeles personnalises",
        "domain": str(raw.get("domain", "Personnalise")).strip() or "Personnalise",
        "branch": str(raw.get("branch", "Document juridique")).strip() or "Document juridique",
        "complexity": complexity,
        "description": str(raw.get("description", "")).strip(),
        "legalRefs": _normalize_string_list(raw.get("legalRefs")),
        "requiredFields": _normalize_string_list(raw.get("requiredFields")),
        "optionalFields": _normalize_string_list(raw.get("optionalFields")),
        "sections": _normalize_string_list(raw.get("sections")),
        "warning": str(raw.get("warning", "")).strip(),
        "fields": fields,
        "createdAt": str(raw.get("createdAt", now)) or now,
        "updatedAt": str(raw.get("updatedAt", now)) or now,
    }


def _sort_templates(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        items,
        key=lambda item: _parse_timestamp(str(item.get("updatedAt", ""))),
        reverse=True,
    )


def _coerce_user_state(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return _default_user_state()

    consultations_raw = raw.get("consultations", [])
    files_raw = raw.get("files", [])
    notes_raw = raw.get("notes", "")
    templates_raw = raw.get("templates", [])

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

    templates: list[dict[str, Any]] = []
    if isinstance(templates_raw, list):
        for item in templates_raw:
            if isinstance(item, dict):
                normalized = _normalize_template(item)
                if normalized.get("id"):
                    templates.append(normalized)

    notes = str(notes_raw) if isinstance(notes_raw, str) else ""
    return {
        "consultations": _sort_consultations(consultations),
        "notes": notes,
        "files": _sort_files(files),
        "templates": _sort_templates(templates),
    }


def _read_state_unlocked() -> dict[str, Any]:
    if not WORKSPACE_STATE_PATH.exists():
        return _default_state()
    try:
        raw = json.loads(WORKSPACE_STATE_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _default_state()

    if not isinstance(raw, dict):
        return _default_state()

    users_payload = raw.get("users")
    users: dict[str, dict[str, Any]] = {}

    if isinstance(users_payload, dict):
        for raw_user_id, user_state in users_payload.items():
            user_id = _normalize_user_id(str(raw_user_id))
            if not user_id:
                continue
            users[user_id] = _coerce_user_state(user_state)
    else:
        # Backward compatibility: old single-workspace format.
        users["anonymous"] = _coerce_user_state(raw)

    return {"users": users}


def _write_state_unlocked(state: dict[str, Any]) -> None:
    _ensure_parent_dir(WORKSPACE_STATE_PATH)
    temp_path = WORKSPACE_STATE_PATH.with_suffix(".tmp")
    payload = json.dumps(state, ensure_ascii=False, indent=2)
    temp_path.write_text(payload, encoding="utf-8")
    temp_path.replace(WORKSPACE_STATE_PATH)


def _read_user_state_unlocked(state: dict[str, Any], user_id: str) -> dict[str, Any]:
    users = state.get("users")
    if not isinstance(users, dict):
        users = {}
        state["users"] = users
    raw_user_state = users.get(user_id)
    user_state = _coerce_user_state(raw_user_state)
    users[user_id] = user_state
    return user_state


def _try_supabase(action: str, op: Any) -> Any | None:
    if _SUPABASE_STORE is None:
        return None
    try:
        return op()
    except SupabaseWorkspaceError as exc:
        _LOGGER.warning(
            "[workspace] Supabase %s failed (%s). Fallback JSON local.",
            action,
            exc,
        )
        return None


def read_consultations(user_id: str | None = None) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    remote = _try_supabase(
        "read_consultations",
        lambda: _SUPABASE_STORE.read_consultations(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            max_items=_MAX_ITEMS_DEFAULT,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        return _sort_consultations(user_state["consultations"])


def upsert_consultation(
    record: dict[str, Any],
    *,
    user_id: str | None = None,
    max_items: int = _MAX_ITEMS_DEFAULT,
) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    normalized = _normalize_consultation(record)
    if not normalized["id"]:
        return read_consultations(normalized_user_id)

    remote = _try_supabase(
        "upsert_consultation",
        lambda: _SUPABASE_STORE.upsert_consultation(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            record=normalized,
            max_items=max_items,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        existing = user_state["consultations"]

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
        user_state["consultations"] = ordered
        _write_state_unlocked(state)
        return ordered


def clear_consultations(user_id: str | None = None) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    remote = _try_supabase(
        "clear_consultations",
        lambda: _SUPABASE_STORE.clear_consultations(  # type: ignore[union-attr]
            user_id=normalized_user_id,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        user_state["consultations"] = []
        _write_state_unlocked(state)
        return []


def remove_consultation(
    consultation_id: str,
    *,
    user_id: str | None = None,
) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    normalized_id = str(consultation_id).strip()
    if not normalized_id:
        return read_consultations(normalized_user_id)

    remote = _try_supabase(
        "remove_consultation",
        lambda: _SUPABASE_STORE.remove_consultation(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            consultation_id=normalized_id,
            max_items=_MAX_ITEMS_DEFAULT,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        user_state["consultations"] = [
            row for row in user_state["consultations"] if str(row.get("id")) != normalized_id
        ]
        user_state["consultations"] = _sort_consultations(user_state["consultations"])
        _write_state_unlocked(state)
        return user_state["consultations"]


def read_notes(user_id: str | None = None) -> str:
    normalized_user_id = _normalize_user_id(user_id)
    remote = _try_supabase(
        "read_notes",
        lambda: _SUPABASE_STORE.read_notes(user_id=normalized_user_id),  # type: ignore[union-attr]
    )
    if isinstance(remote, str):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        return str(user_state.get("notes", ""))


def write_notes(notes: str, *, user_id: str | None = None) -> str:
    normalized_user_id = _normalize_user_id(user_id)
    remote = _try_supabase(
        "write_notes",
        lambda: _SUPABASE_STORE.write_notes(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            notes=notes,
        ),
    )
    if isinstance(remote, str):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        user_state["notes"] = str(notes)
        _write_state_unlocked(state)
        return user_state["notes"]


def read_files(user_id: str | None = None) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    remote = _try_supabase(
        "read_files",
        lambda: _SUPABASE_STORE.read_files(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            max_items=_MAX_ITEMS_DEFAULT,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        return _sort_files(user_state["files"])


def write_files(
    files: list[dict[str, Any]],
    *,
    user_id: str | None = None,
    max_items: int = _MAX_ITEMS_DEFAULT,
) -> list[dict[str, Any]]:
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
    normalized_user_id = _normalize_user_id(user_id)

    remote = _try_supabase(
        "write_files",
        lambda: _SUPABASE_STORE.write_files(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            files=ordered,
            max_items=max_items,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        user_state["files"] = ordered
        _write_state_unlocked(state)
        return ordered


def upsert_files(
    files: list[dict[str, Any]],
    *,
    user_id: str | None = None,
    max_items: int = _MAX_ITEMS_DEFAULT,
) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    normalized_payload: list[dict[str, Any]] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        row = _normalize_file(item)
        if row["id"] and row["name"]:
            normalized_payload.append(row)

    remote = _try_supabase(
        "upsert_files",
        lambda: _SUPABASE_STORE.upsert_files(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            files=normalized_payload,
            max_items=max_items,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        dedup: dict[str, dict[str, Any]] = {
            item["id"]: item for item in user_state["files"] if item.get("id")
        }
        for row in normalized_payload:
            dedup[row["id"]] = row

        ordered = _sort_files(list(dedup.values()))[: max(1, max_items)]
        user_state["files"] = ordered
        _write_state_unlocked(state)
        return ordered


def clear_files(user_id: str | None = None) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    remote = _try_supabase(
        "clear_files",
        lambda: _SUPABASE_STORE.clear_files(user_id=normalized_user_id),  # type: ignore[union-attr]
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        user_state["files"] = []
        _write_state_unlocked(state)
        return []


def remove_file(
    file_id: str,
    *,
    user_id: str | None = None,
) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    normalized_id = str(file_id).strip()
    if not normalized_id:
        return read_files(normalized_user_id)

    remote = _try_supabase(
        "remove_file",
        lambda: _SUPABASE_STORE.remove_file(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            file_id=normalized_id,
            max_items=_MAX_ITEMS_DEFAULT,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        user_state["files"] = [row for row in user_state["files"] if str(row.get("id")) != normalized_id]
        user_state["files"] = _sort_files(user_state["files"])
        _write_state_unlocked(state)
        return user_state["files"]


def read_templates(user_id: str | None = None) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    remote = _try_supabase(
        "read_templates",
        lambda: _SUPABASE_STORE.read_templates(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            max_items=_MAX_ITEMS_DEFAULT,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        return _sort_templates(user_state.get("templates", []))


def write_templates(
    templates: list[dict[str, Any]],
    *,
    user_id: str | None = None,
    max_items: int = _MAX_ITEMS_DEFAULT,
) -> list[dict[str, Any]]:
    normalized_rows: list[dict[str, Any]] = []
    for item in templates:
        if not isinstance(item, dict):
            continue
        row = _normalize_template(item)
        if row.get("id"):
            normalized_rows.append(row)

    dedup: dict[str, dict[str, Any]] = {}
    for item in normalized_rows:
        dedup[str(item["id"])] = item
    ordered = _sort_templates(list(dedup.values()))[: max(1, max_items)]
    normalized_user_id = _normalize_user_id(user_id)

    remote = _try_supabase(
        "write_templates",
        lambda: _SUPABASE_STORE.write_templates(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            templates=ordered,
            max_items=max_items,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        user_state["templates"] = ordered
        _write_state_unlocked(state)
        return ordered


def upsert_template(
    template: dict[str, Any],
    *,
    user_id: str | None = None,
    max_items: int = _MAX_ITEMS_DEFAULT,
) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    normalized = _normalize_template(template)
    if not normalized.get("id"):
        return read_templates(normalized_user_id)

    remote = _try_supabase(
        "upsert_template",
        lambda: _SUPABASE_STORE.upsert_template(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            template=normalized,
            max_items=max_items,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        existing = user_state.get("templates", [])
        dedup: dict[str, dict[str, Any]] = {
            str(item.get("id")): item for item in existing if isinstance(item, dict) and item.get("id")
        }
        dedup[str(normalized["id"])] = normalized
        ordered = _sort_templates(list(dedup.values()))[: max(1, max_items)]
        user_state["templates"] = ordered
        _write_state_unlocked(state)
        return ordered


def clear_templates(user_id: str | None = None) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    remote = _try_supabase(
        "clear_templates",
        lambda: _SUPABASE_STORE.clear_templates(user_id=normalized_user_id),  # type: ignore[union-attr]
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        user_state["templates"] = []
        _write_state_unlocked(state)
        return []


def remove_template(
    template_id: str,
    *,
    user_id: str | None = None,
) -> list[dict[str, Any]]:
    normalized_user_id = _normalize_user_id(user_id)
    normalized_id = str(template_id).strip()
    if not normalized_id:
        return read_templates(normalized_user_id)

    remote = _try_supabase(
        "remove_template",
        lambda: _SUPABASE_STORE.remove_template(  # type: ignore[union-attr]
            user_id=normalized_user_id,
            template_id=normalized_id,
            max_items=_MAX_ITEMS_DEFAULT,
        ),
    )
    if isinstance(remote, list):
        return remote

    with _STATE_LOCK:
        state = _read_state_unlocked()
        user_state = _read_user_state_unlocked(state, normalized_user_id)
        user_state["templates"] = [
            row for row in user_state.get("templates", []) if str(row.get("id")) != normalized_id
        ]
        user_state["templates"] = _sort_templates(user_state["templates"])
        _write_state_unlocked(state)
        return user_state["templates"]
