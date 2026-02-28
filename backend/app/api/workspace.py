from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..schemas import ConsultationRecord, WorkspaceFileListPayload, WorkspaceNotesPayload
from ..shared_runtime import get_workspace_rag_index, now_iso, sanitize_upload_name
from ..workspace_rag import SUPPORTED_UPLOAD_EXTENSIONS, WORKSPACE_UPLOAD_DIR
from ..workspace_store import (
    clear_consultations,
    clear_files,
    remove_consultation,
    remove_file,
    read_consultations,
    read_files,
    read_notes,
    upsert_consultation,
    upsert_files,
    write_files,
    write_notes,
)

router = APIRouter(prefix="/workspace", tags=["workspace"])


@router.get("/consultations")
async def workspace_get_consultations():
    return {"items": read_consultations()}


@router.put("/consultations/upsert")
async def workspace_upsert_consultation(payload: ConsultationRecord):
    items = upsert_consultation(payload.model_dump(by_alias=True), max_items=200)
    return {"items": items}


@router.delete("/consultations")
async def workspace_clear_consultations():
    return {"items": clear_consultations()}


@router.delete("/consultations/{consultation_id}")
async def workspace_delete_consultation(consultation_id: str):
    return {"items": remove_consultation(consultation_id)}


@router.get("/notes")
async def workspace_get_notes():
    return {"notes": read_notes()}


@router.put("/notes")
async def workspace_put_notes(payload: WorkspaceNotesPayload):
    notes = write_notes(payload.notes)
    return {"notes": notes}


@router.get("/files")
async def workspace_get_files():
    return {"items": read_files()}


@router.post("/files/upload")
async def workspace_upload_files(files: list[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="No files received.")

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
        items = upsert_files(uploaded_rows, max_items=200)
    else:
        items = read_files()

    return {"items": items, "uploaded": upload_report, "errors": errors}


@router.put("/files")
async def workspace_put_files(payload: WorkspaceFileListPayload):
    items = write_files(
        [item.model_dump(by_alias=True) for item in payload.items],
        max_items=200,
    )
    return {"items": items}


@router.post("/files/upsert")
async def workspace_upsert_files(payload: WorkspaceFileListPayload):
    items = upsert_files(
        [item.model_dump(by_alias=True) for item in payload.items],
        max_items=200,
    )
    return {"items": items}


@router.delete("/files/{file_id}")
async def workspace_delete_file(file_id: str):
    removed_chunks = get_workspace_rag_index().remove_file(file_id)
    items = remove_file(file_id)
    if WORKSPACE_UPLOAD_DIR.exists():
        prefix = f"{file_id}-"
        for path in WORKSPACE_UPLOAD_DIR.iterdir():
            if path.is_file() and path.name.startswith(prefix):
                path.unlink(missing_ok=True)
    return {"items": items, "removed_chunks": removed_chunks}


@router.delete("/files")
async def workspace_clear_files():
    get_workspace_rag_index().clear()
    if WORKSPACE_UPLOAD_DIR.exists():
        shutil.rmtree(WORKSPACE_UPLOAD_DIR, ignore_errors=True)
    return {"items": clear_files()}

