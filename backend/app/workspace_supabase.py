from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


class SupabaseWorkspaceError(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_positive_float(raw: str, default: float) -> float:
    try:
        value = float(raw.strip())
    except (AttributeError, ValueError):
        return default
    if value <= 0:
        return default
    return value


def _parse_non_empty(value: str | None, default: str) -> str:
    parsed = (value or "").strip()
    return parsed or default


def _to_int(value: Any, default: int = 0) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def _safe_iso(value: Any) -> str:
    parsed = str(value or "").strip()
    return parsed or _now_iso()


def _to_string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    rows: list[str] = []
    for item in value:
        parsed = str(item or "").strip()
        if parsed:
            rows.append(parsed)
    return rows


def _normalize_complexity(value: Any) -> str:
    lowered = str(value or "").strip().lower()
    if lowered == "intermediaire":
        return "Intermediaire"
    if lowered == "avance":
        return "Avance"
    return "Simple"


@dataclass(frozen=True)
class SupabaseWorkspaceConfig:
    url: str
    service_role_key: str
    schema: str
    users_table: str
    consultations_table: str
    notes_table: str
    files_table: str
    templates_table: str
    guest_qa_logs_table: str
    signed_user_qa_logs_table: str
    timeout_sec: float


class SupabaseWorkspaceStore:
    def __init__(self, config: SupabaseWorkspaceConfig) -> None:
        self._config = config
        self._rest_base = f"{config.url.rstrip('/')}/rest/v1"

    @classmethod
    def from_env(cls) -> SupabaseWorkspaceStore | None:
        url = (os.getenv("SUPABASE_URL", "") or "").strip()
        key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY", "") or "").strip()
        if not url or not key:
            return None
        config = SupabaseWorkspaceConfig(
            url=url,
            service_role_key=key,
            schema=_parse_non_empty(os.getenv("SUPABASE_SCHEMA"), "public"),
            users_table=_parse_non_empty(
                os.getenv("SUPABASE_USERS_TABLE"),
                "workspace_users",
            ),
            consultations_table=_parse_non_empty(
                os.getenv("SUPABASE_CONSULTATIONS_TABLE"),
                "workspace_consultations",
            ),
            notes_table=_parse_non_empty(
                os.getenv("SUPABASE_NOTES_TABLE"),
                "workspace_notes",
            ),
            files_table=_parse_non_empty(
                os.getenv("SUPABASE_FILES_TABLE"),
                "workspace_files",
            ),
            templates_table=_parse_non_empty(
                os.getenv("SUPABASE_TEMPLATES_TABLE"),
                "workspace_templates",
            ),
            guest_qa_logs_table=_parse_non_empty(
                os.getenv("SUPABASE_GUEST_QA_LOGS_TABLE"),
                "workspace_guest_qa_logs",
            ),
            signed_user_qa_logs_table=_parse_non_empty(
                os.getenv("SUPABASE_SIGNED_USER_QA_LOGS_TABLE"),
                "workspace_signed_user_qa_logs",
            ),
            timeout_sec=_parse_positive_float(
                os.getenv("SUPABASE_TIMEOUT_SEC", "8"),
                8.0,
            ),
        )
        return cls(config)

    def public_info(self) -> dict[str, Any]:
        hostname = ""
        try:
            hostname = urllib.parse.urlparse(self._config.url).hostname or ""
        except ValueError:
            hostname = ""
        return {
            "url_host": hostname,
            "schema": self._config.schema,
            "users_table": self._config.users_table,
            "consultations_table": self._config.consultations_table,
            "notes_table": self._config.notes_table,
            "files_table": self._config.files_table,
            "templates_table": self._config.templates_table,
            "guest_qa_logs_table": self._config.guest_qa_logs_table,
            "signed_user_qa_logs_table": self._config.signed_user_qa_logs_table,
            "timeout_sec": self._config.timeout_sec,
        }

    def upsert_user_profile(
        self,
        *,
        user_id: str,
        email: str | None = None,
        username: str | None = None,
        display_name: str | None = None,
    ) -> None:
        payload = [
            {
                "user_id": user_id,
                "email": (email or "").strip() or None,
                "clerk_username": (username or "").strip() or None,
                "display_name": (display_name or "").strip() or None,
                "last_seen_at": _now_iso(),
            }
        ]
        self._request_json(
            method="POST",
            table=self._config.users_table,
            query=[("on_conflict", "user_id")],
            payload=payload,
            prefer="resolution=merge-duplicates,return=minimal",
        )

    def append_guest_qa_log(self, *, record: dict[str, Any]) -> bool:
        raw_auth_mode = record.get("auth_mode")
        auth_mode = str(raw_auth_mode).strip() if raw_auth_mode is not None else ""
        auth_mode_lower = auth_mode.lower()
        raw_user_id = record.get("user_id")
        user_id = str(raw_user_id).strip() if raw_user_id is not None else ""
        raw_user_email = record.get("user_email")
        user_email = str(raw_user_email).strip() if raw_user_email is not None else ""
        raw_user_name = record.get("user_name")
        user_name = str(raw_user_name).strip() if raw_user_name is not None else ""
        raw_user_username = record.get("user_username")
        user_username = str(raw_user_username).strip() if raw_user_username is not None else ""
        is_signed_user = bool(user_id) or auth_mode_lower in {"signed-in", "authenticated"}
        target_table = (
            self._config.signed_user_qa_logs_table
            if is_signed_user
            else self._config.guest_qa_logs_table
        )
        normalized_auth_mode = auth_mode or ("signed-in" if is_signed_user else "guest")
        payload = [
            {
                "created_at": _safe_iso(record.get("created_at")),
                "auth_mode": normalized_auth_mode,
                "user_id": user_id if is_signed_user else None,
                "user_email": user_email or None,
                "user_name": user_name or None,
                "user_username": user_username or None,
                "client_ip": str(record.get("client_ip", "")).strip(),
                "question": str(record.get("question", "")).strip(),
                "answer": str(record.get("answer", "")).strip(),
                "rag_note": str(record.get("rag_note", "")).strip(),
                "finish_reason": str(record.get("finish_reason", "")).strip(),
                "rag_source_count": _to_int(record.get("rag_source_count", 0)),
                "provider": str(record.get("provider", "")).strip(),
                "model": str(record.get("model", "")).strip(),
                "metadata": record.get("metadata", {}) if isinstance(record.get("metadata"), dict) else {},
            }
        ]
        self._request_json(
            method="POST",
            table=target_table,
            payload=payload,
            prefer="return=minimal",
        )
        return True

    def _request_json(
        self,
        *,
        method: str,
        table: str,
        query: list[tuple[str, str]] | None = None,
        payload: Any = None,
        prefer: str | None = None,
    ) -> Any:
        query_string = urllib.parse.urlencode(query or [], doseq=True)
        url = f"{self._rest_base}/{table}"
        if query_string:
            url = f"{url}?{query_string}"

        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        request = urllib.request.Request(
            url=url,
            data=body,
            method=method.upper(),
        )
        request.add_header("apikey", self._config.service_role_key)
        request.add_header("Authorization", f"Bearer {self._config.service_role_key}")
        request.add_header("Accept", "application/json")
        if body is not None:
            request.add_header("Content-Type", "application/json")
        if prefer:
            request.add_header("Prefer", prefer)
        if self._config.schema and self._config.schema != "public":
            request.add_header("Accept-Profile", self._config.schema)
            if body is not None:
                request.add_header("Content-Profile", self._config.schema)

        try:
            with urllib.request.urlopen(request, timeout=self._config.timeout_sec) as response:
                raw = response.read().decode("utf-8", errors="replace").strip()
                if not raw:
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            raw_error = exc.read().decode("utf-8", errors="replace").strip()
            detail = raw_error[:600] if raw_error else exc.reason
            raise SupabaseWorkspaceError(
                f"Supabase request failed ({exc.code}) on table '{table}': {detail}"
            ) from exc
        except urllib.error.URLError as exc:
            raise SupabaseWorkspaceError(
                f"Supabase connection failed for table '{table}': {exc.reason}"
            ) from exc
        except json.JSONDecodeError as exc:
            raise SupabaseWorkspaceError(
                f"Supabase returned invalid JSON for table '{table}'."
            ) from exc

    def read_consultations(self, *, user_id: str, max_items: int) -> list[dict[str, Any]]:
        rows = self._request_json(
            method="GET",
            table=self._config.consultations_table,
            query=[
                ("user_id", f"eq.{user_id}"),
                ("order", "updated_at.desc"),
                ("limit", str(max(1, max_items))),
            ],
        )
        if not isinstance(rows, list):
            return []
        result: list[dict[str, Any]] = []
        for raw in rows:
            if not isinstance(raw, dict):
                continue
            consultation_id = str(raw.get("id", "")).strip()
            if not consultation_id:
                continue
            status = "error" if str(raw.get("status", "done")).strip().lower() == "error" else "done"
            result.append(
                {
                    "id": consultation_id,
                    "question": str(raw.get("question", "")).strip(),
                    "answer": str(raw.get("answer", "")).strip(),
                    "status": status,
                    "finishReason": str(raw.get("finish_reason", "")).strip(),
                    "ragNote": str(raw.get("rag_note", "")).strip(),
                    "sourceCount": _to_int(raw.get("source_count", 0)),
                    "createdAt": _safe_iso(raw.get("created_at")),
                    "updatedAt": _safe_iso(raw.get("updated_at")),
                }
            )
        return result

    def upsert_consultation(
        self,
        *,
        user_id: str,
        record: dict[str, Any],
        max_items: int,
    ) -> list[dict[str, Any]]:
        now = _now_iso()
        payload = [
            {
                "user_id": user_id,
                "id": str(record.get("id", "")).strip(),
                "question": str(record.get("question", "")).strip(),
                "answer": str(record.get("answer", "")).strip(),
                "status": (
                    "error"
                    if str(record.get("status", "done")).strip().lower() == "error"
                    else "done"
                ),
                "finish_reason": str(record.get("finishReason", "")).strip(),
                "rag_note": str(record.get("ragNote", "")).strip(),
                "source_count": _to_int(record.get("sourceCount", 0)),
                "created_at": _safe_iso(record.get("createdAt") or now),
                "updated_at": _safe_iso(record.get("updatedAt") or now),
            }
        ]
        self._request_json(
            method="POST",
            table=self._config.consultations_table,
            query=[("on_conflict", "user_id,id")],
            payload=payload,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        return self.read_consultations(user_id=user_id, max_items=max_items)

    def clear_consultations(self, *, user_id: str) -> list[dict[str, Any]]:
        self._request_json(
            method="DELETE",
            table=self._config.consultations_table,
            query=[("user_id", f"eq.{user_id}")],
            prefer="return=minimal",
        )
        return []

    def remove_consultation(
        self,
        *,
        user_id: str,
        consultation_id: str,
        max_items: int,
    ) -> list[dict[str, Any]]:
        self._request_json(
            method="DELETE",
            table=self._config.consultations_table,
            query=[
                ("user_id", f"eq.{user_id}"),
                ("id", f"eq.{consultation_id}"),
            ],
            prefer="return=minimal",
        )
        return self.read_consultations(user_id=user_id, max_items=max_items)

    def read_notes(self, *, user_id: str) -> str:
        rows = self._request_json(
            method="GET",
            table=self._config.notes_table,
            query=[
                ("user_id", f"eq.{user_id}"),
                ("select", "notes"),
                ("limit", "1"),
            ],
        )
        if isinstance(rows, list) and rows:
            row = rows[0]
            if isinstance(row, dict):
                return str(row.get("notes", ""))
        return ""

    def write_notes(self, *, user_id: str, notes: str) -> str:
        payload = [
            {
                "user_id": user_id,
                "notes": str(notes),
                "updated_at": _now_iso(),
            }
        ]
        rows = self._request_json(
            method="POST",
            table=self._config.notes_table,
            query=[("on_conflict", "user_id")],
            payload=payload,
            prefer="resolution=merge-duplicates,return=representation",
        )
        if isinstance(rows, list) and rows:
            row = rows[0]
            if isinstance(row, dict):
                return str(row.get("notes", notes))
        return str(notes)

    def read_files(self, *, user_id: str, max_items: int) -> list[dict[str, Any]]:
        rows = self._request_json(
            method="GET",
            table=self._config.files_table,
            query=[
                ("user_id", f"eq.{user_id}"),
                ("order", "added_at.desc"),
                ("limit", str(max(1, max_items))),
            ],
        )
        if not isinstance(rows, list):
            return []
        result: list[dict[str, Any]] = []
        for raw in rows:
            if not isinstance(raw, dict):
                continue
            file_id = str(raw.get("id", "")).strip()
            file_name = str(raw.get("name", "")).strip()
            if not file_id or not file_name:
                continue
            result.append(
                {
                    "id": file_id,
                    "name": file_name,
                    "size": _to_int(raw.get("size", 0)),
                    "addedAt": _safe_iso(raw.get("added_at")),
                }
            )
        return result

    def write_files(
        self,
        *,
        user_id: str,
        files: list[dict[str, Any]],
        max_items: int,
    ) -> list[dict[str, Any]]:
        self._request_json(
            method="DELETE",
            table=self._config.files_table,
            query=[("user_id", f"eq.{user_id}")],
            prefer="return=minimal",
        )
        if not files:
            return []
        payload: list[dict[str, Any]] = []
        for raw in files[: max(1, max_items)]:
            payload.append(
                {
                    "user_id": user_id,
                    "id": str(raw.get("id", "")).strip(),
                    "name": str(raw.get("name", "")).strip(),
                    "size": _to_int(raw.get("size", 0)),
                    "added_at": _safe_iso(raw.get("addedAt")),
                }
            )
        self._request_json(
            method="POST",
            table=self._config.files_table,
            payload=payload,
            prefer="return=minimal",
        )
        return self.read_files(user_id=user_id, max_items=max_items)

    def upsert_files(
        self,
        *,
        user_id: str,
        files: list[dict[str, Any]],
        max_items: int,
    ) -> list[dict[str, Any]]:
        if not files:
            return self.read_files(user_id=user_id, max_items=max_items)
        payload: list[dict[str, Any]] = []
        for raw in files:
            payload.append(
                {
                    "user_id": user_id,
                    "id": str(raw.get("id", "")).strip(),
                    "name": str(raw.get("name", "")).strip(),
                    "size": _to_int(raw.get("size", 0)),
                    "added_at": _safe_iso(raw.get("addedAt")),
                }
            )
        self._request_json(
            method="POST",
            table=self._config.files_table,
            query=[("on_conflict", "user_id,id")],
            payload=payload,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        return self.read_files(user_id=user_id, max_items=max_items)

    def clear_files(self, *, user_id: str) -> list[dict[str, Any]]:
        self._request_json(
            method="DELETE",
            table=self._config.files_table,
            query=[("user_id", f"eq.{user_id}")],
            prefer="return=minimal",
        )
        return []

    def remove_file(
        self,
        *,
        user_id: str,
        file_id: str,
        max_items: int,
    ) -> list[dict[str, Any]]:
        self._request_json(
            method="DELETE",
            table=self._config.files_table,
            query=[
                ("user_id", f"eq.{user_id}"),
                ("id", f"eq.{file_id}"),
            ],
            prefer="return=minimal",
        )
        return self.read_files(user_id=user_id, max_items=max_items)

    def read_templates(self, *, user_id: str, max_items: int) -> list[dict[str, Any]]:
        rows = self._request_json(
            method="GET",
            table=self._config.templates_table,
            query=[
                ("user_id", f"eq.{user_id}"),
                ("order", "updated_at.desc"),
                ("limit", str(max(1, max_items))),
            ],
        )
        if not isinstance(rows, list):
            return []
        result: list[dict[str, Any]] = []
        for raw in rows:
            if not isinstance(raw, dict):
                continue
            template_id = str(raw.get("id", "")).strip()
            template_name = str(raw.get("name", "")).strip()
            if not template_id or not template_name:
                continue
            fields_raw = raw.get("fields", [])
            fields = fields_raw if isinstance(fields_raw, list) else []
            result.append(
                {
                    "id": template_id,
                    "name": template_name,
                    "category": str(raw.get("category", "Modeles personnalises")).strip()
                    or "Modeles personnalises",
                    "domain": str(raw.get("domain", "Personnalise")).strip() or "Personnalise",
                    "branch": str(raw.get("branch", "Document juridique")).strip()
                    or "Document juridique",
                    "complexity": _normalize_complexity(raw.get("complexity")),
                    "description": str(raw.get("description", "")).strip(),
                    "legalRefs": _to_string_list(raw.get("legal_refs", [])),
                    "requiredFields": _to_string_list(raw.get("required_fields", [])),
                    "optionalFields": _to_string_list(raw.get("optional_fields", [])),
                    "sections": _to_string_list(raw.get("sections", [])),
                    "warning": str(raw.get("warning", "")).strip(),
                    "fields": fields,
                    "createdAt": _safe_iso(raw.get("created_at")),
                    "updatedAt": _safe_iso(raw.get("updated_at")),
                }
            )
        return result

    def write_templates(
        self,
        *,
        user_id: str,
        templates: list[dict[str, Any]],
        max_items: int,
    ) -> list[dict[str, Any]]:
        self._request_json(
            method="DELETE",
            table=self._config.templates_table,
            query=[("user_id", f"eq.{user_id}")],
            prefer="return=minimal",
        )
        if not templates:
            return []
        payload: list[dict[str, Any]] = []
        for raw in templates[: max(1, max_items)]:
            payload.append(
                {
                    "user_id": user_id,
                    "id": str(raw.get("id", "")).strip(),
                    "name": str(raw.get("name", "")).strip(),
                    "category": str(raw.get("category", "")).strip() or "Modeles personnalises",
                    "domain": str(raw.get("domain", "")).strip() or "Personnalise",
                    "branch": str(raw.get("branch", "")).strip() or "Document juridique",
                    "complexity": _normalize_complexity(raw.get("complexity")),
                    "description": str(raw.get("description", "")).strip(),
                    "legal_refs": _to_string_list(raw.get("legalRefs", [])),
                    "required_fields": _to_string_list(raw.get("requiredFields", [])),
                    "optional_fields": _to_string_list(raw.get("optionalFields", [])),
                    "sections": _to_string_list(raw.get("sections", [])),
                    "warning": str(raw.get("warning", "")).strip(),
                    "fields": raw.get("fields", []) if isinstance(raw.get("fields", []), list) else [],
                    "created_at": _safe_iso(raw.get("createdAt")),
                    "updated_at": _safe_iso(raw.get("updatedAt")),
                }
            )
        self._request_json(
            method="POST",
            table=self._config.templates_table,
            payload=payload,
            prefer="return=minimal",
        )
        return self.read_templates(user_id=user_id, max_items=max_items)

    def upsert_template(
        self,
        *,
        user_id: str,
        template: dict[str, Any],
        max_items: int,
    ) -> list[dict[str, Any]]:
        payload = [
            {
                "user_id": user_id,
                "id": str(template.get("id", "")).strip(),
                "name": str(template.get("name", "")).strip(),
                "category": str(template.get("category", "")).strip() or "Modeles personnalises",
                "domain": str(template.get("domain", "")).strip() or "Personnalise",
                "branch": str(template.get("branch", "")).strip() or "Document juridique",
                "complexity": _normalize_complexity(template.get("complexity")),
                "description": str(template.get("description", "")).strip(),
                "legal_refs": _to_string_list(template.get("legalRefs", [])),
                "required_fields": _to_string_list(template.get("requiredFields", [])),
                "optional_fields": _to_string_list(template.get("optionalFields", [])),
                "sections": _to_string_list(template.get("sections", [])),
                "warning": str(template.get("warning", "")).strip(),
                "fields": template.get("fields", []) if isinstance(template.get("fields", []), list) else [],
                "created_at": _safe_iso(template.get("createdAt")),
                "updated_at": _safe_iso(template.get("updatedAt")),
            }
        ]
        self._request_json(
            method="POST",
            table=self._config.templates_table,
            query=[("on_conflict", "user_id,id")],
            payload=payload,
            prefer="resolution=merge-duplicates,return=minimal",
        )
        return self.read_templates(user_id=user_id, max_items=max_items)

    def clear_templates(self, *, user_id: str) -> list[dict[str, Any]]:
        self._request_json(
            method="DELETE",
            table=self._config.templates_table,
            query=[("user_id", f"eq.{user_id}")],
            prefer="return=minimal",
        )
        return []

    def remove_template(
        self,
        *,
        user_id: str,
        template_id: str,
        max_items: int,
    ) -> list[dict[str, Any]]:
        self._request_json(
            method="DELETE",
            table=self._config.templates_table,
            query=[
                ("user_id", f"eq.{user_id}"),
                ("id", f"eq.{template_id}"),
            ],
            prefer="return=minimal",
        )
        return self.read_templates(user_id=user_id, max_items=max_items)
