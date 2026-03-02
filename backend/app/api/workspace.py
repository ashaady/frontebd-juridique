from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, Request, UploadFile

from ..schemas import (
    ConsultationRecord,
    WorkspaceFileListPayload,
    WorkspaceNotesPayload,
    WorkspaceTemplateListResponse,
    WorkspaceTemplateRecord,
)
from ..shared_runtime import get_workspace_rag_index, now_iso, sanitize_upload_name
from ..workspace_rag import SUPPORTED_UPLOAD_EXTENSIONS, WORKSPACE_UPLOAD_DIR
from ..workspace_store import (
    clear_consultations,
    clear_files,
    register_user_context,
    remove_consultation,
    remove_file,
    read_consultations,
    read_files,
    read_notes,
    read_templates,
    remove_template,
    upsert_template,
    upsert_consultation,
    upsert_files,
    clear_templates,
    write_files,
    write_notes,
)

router = APIRouter(prefix="/workspace", tags=["workspace"])

_WORKSPACE_USER_HEADER_CANDIDATES = (
    "x-user-id",
    "x-clerk-user-id",
    "x-client-user-id",
)


def _workspace_user_id(request: Request) -> str:
    for header in _WORKSPACE_USER_HEADER_CANDIDATES:
        raw = request.headers.get(header)
        if raw and raw.strip():
            return raw.strip()
    return "anonymous"


def _workspace_register_user_context(request: Request, user_id: str) -> None:
    register_user_context(
        user_id=user_id,
        email=request.headers.get("x-user-email"),
        username=request.headers.get("x-user-username"),
        display_name=request.headers.get("x-user-name"),
    )


@router.get("/consultations")
async def workspace_get_consultations(request: Request):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    return {"items": read_consultations(user_id=user_id)}


@router.put("/consultations/upsert")
async def workspace_upsert_consultation(request: Request, payload: ConsultationRecord):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    items = upsert_consultation(
        payload.model_dump(by_alias=True),
        user_id=user_id,
        max_items=200,
    )
    return {"items": items}


@router.delete("/consultations")
async def workspace_clear_consultations(request: Request):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    return {"items": clear_consultations(user_id=user_id)}


@router.delete("/consultations/{consultation_id}")
async def workspace_delete_consultation(request: Request, consultation_id: str):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    return {"items": remove_consultation(consultation_id, user_id=user_id)}


@router.get("/notes")
async def workspace_get_notes(request: Request):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    return {"notes": read_notes(user_id=user_id)}


@router.put("/notes")
async def workspace_put_notes(request: Request, payload: WorkspaceNotesPayload):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    notes = write_notes(payload.notes, user_id=user_id)
    return {"notes": notes}


@router.get("/files")
async def workspace_get_files(request: Request):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    return {"items": read_files(user_id=user_id)}


@router.post("/files/upload")
async def workspace_upload_files(request: Request, files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="No files received.")

    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    WORKSPACE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    rag_index = get_workspace_rag_index()

    uploaded_rows: list[dict[str, Any]] = []
    upload_report: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    max_size_bytes = 20 * 1024 * 1024

    for upload in files:
        try:
            original_name = (upload.filename or "document").strip() or "document"
            extension = Path(original_name).suffix.lower()
            if extension not in SUPPORTED_UPLOAD_EXTENSIONS:
                errors.append(
                    {
                        "filename": original_name,
                        "detail": f"Unsupported extension: {extension or 'none'}",
                    }
                )
                continue

            payload = await upload.read()
            if not payload:
                errors.append({"filename": original_name, "detail": "Empty file."})
                continue
            if len(payload) > max_size_bytes:
                errors.append(
                    {
                        "filename": original_name,
                        "detail": "File too large. Max 20MB.",
                    }
                )
                continue

            file_id = f"wf-{uuid4().hex[:12]}"
            safe_base = sanitize_upload_name(Path(original_name).stem)
            safe_name = f"{safe_base}{extension}"
            disk_name = f"{file_id}-{safe_name}"
            disk_path = WORKSPACE_UPLOAD_DIR / disk_name
            disk_path.write_bytes(payload)

            relative_path = f"workspace_uploads/{safe_name}"
            try:
                chunk_count = rag_index.ingest_file(
                    file_id=file_id,
                    file_name=safe_name,
                    source_path=disk_path,
                    relative_path=relative_path,
                )
            except Exception as exc:  # noqa: BLE001
                if disk_path.exists():
                    disk_path.unlink()
                errors.append(
                    {
                        "filename": original_name,
                        "detail": f"Ingestion failed: {type(exc).__name__}: {exc}",
                    }
                )
                continue

            if chunk_count <= 0:
                rag_index.remove_file(file_id)
                if disk_path.exists():
                    disk_path.unlink()
                errors.append(
                    {
                        "filename": original_name,
                        "detail": "No extractable text found.",
                    }
                )
                continue

            uploaded_at = now_iso()
            uploaded_rows.append(
                {
                    "id": file_id,
                    "name": safe_name,
                    "size": len(payload),
                    "addedAt": uploaded_at,
                }
            )
            upload_report.append(
                {
                    "id": file_id,
                    "name": safe_name,
                    "size": len(payload),
                    "chunk_count": chunk_count,
                    "relative_path": relative_path,
                }
            )
        finally:
            await upload.close()

    if uploaded_rows:
        items = upsert_files(uploaded_rows, user_id=user_id, max_items=200)
    else:
        items = read_files(user_id=user_id)

    return {"items": items, "uploaded": upload_report, "errors": errors}


@router.put("/files")
async def workspace_put_files(request: Request, payload: WorkspaceFileListPayload):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    items = write_files(
        [item.model_dump(by_alias=True) for item in payload.items],
        user_id=user_id,
        max_items=200,
    )
    return {"items": items}


@router.post("/files/upsert")
async def workspace_upsert_files(request: Request, payload: WorkspaceFileListPayload):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    items = upsert_files(
        [item.model_dump(by_alias=True) for item in payload.items],
        user_id=user_id,
        max_items=200,
    )
    return {"items": items}


@router.delete("/files/{file_id}")
async def workspace_delete_file(request: Request, file_id: str):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    removed_chunks = get_workspace_rag_index().remove_file(file_id)
    items = remove_file(file_id, user_id=user_id)
    if WORKSPACE_UPLOAD_DIR.exists():
        prefix = f"{file_id}-"
        for path in WORKSPACE_UPLOAD_DIR.iterdir():
            if path.is_file() and path.name.startswith(prefix):
                path.unlink(missing_ok=True)
    return {"items": items, "removed_chunks": removed_chunks}


@router.delete("/files")
async def workspace_clear_files(request: Request):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    removed_chunks = 0
    existing_files = read_files(user_id=user_id)
    rag_index = get_workspace_rag_index()

    for row in existing_files:
        file_id = str(row.get("id", "")).strip()
        if not file_id:
            continue
        removed_chunks += rag_index.remove_file(file_id)
        if WORKSPACE_UPLOAD_DIR.exists():
            prefix = f"{file_id}-"
            for path in WORKSPACE_UPLOAD_DIR.iterdir():
                if path.is_file() and path.name.startswith(prefix):
                    path.unlink(missing_ok=True)

    # If no files remain, clean up the now-empty upload folder.
    if WORKSPACE_UPLOAD_DIR.exists():
        has_files = any(path.is_file() for path in WORKSPACE_UPLOAD_DIR.iterdir())
        if not has_files:
            shutil.rmtree(WORKSPACE_UPLOAD_DIR, ignore_errors=True)

    return {
        "items": clear_files(user_id=user_id),
        "removed_chunks": removed_chunks,
    }


@router.get("/templates", response_model=WorkspaceTemplateListResponse)
async def workspace_get_templates(request: Request):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    return {"items": read_templates(user_id=user_id)}


@router.put("/templates/upsert", response_model=WorkspaceTemplateListResponse)
async def workspace_upsert_template(request: Request, payload: WorkspaceTemplateRecord):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    items = upsert_template(
        payload.model_dump(by_alias=True),
        user_id=user_id,
        max_items=200,
    )
    return {"items": items}


@router.delete("/templates/{template_id}", response_model=WorkspaceTemplateListResponse)
async def workspace_delete_template(request: Request, template_id: str):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    return {"items": remove_template(template_id, user_id=user_id)}


@router.delete("/templates", response_model=WorkspaceTemplateListResponse)
async def workspace_clear_templates(request: Request):
    user_id = _workspace_user_id(request)
    _workspace_register_user_context(request, user_id)
    return {"items": clear_templates(user_id=user_id)}
