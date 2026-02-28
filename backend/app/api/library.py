from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..library_catalog import list_legal_pdf_documents, resolve_document_path

router = APIRouter(prefix="/library", tags=["library"])


def _resolve_document_or_404(document_id: str) -> dict[str, Any]:
    rows = list_legal_pdf_documents()
    selected = next((row for row in rows if row.get("id") == document_id), None)
    if selected is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return selected


@router.get("/documents")
async def library_list_documents(
    q: str = "",
    category: str = "",
):
    rows = list_legal_pdf_documents()
    query = q.strip().lower()
    category_filter = category.strip().lower()

    filtered: list[dict[str, Any]] = []
    for row in rows:
        if query:
            haystack = " ".join(
                [
                    str(row.get("title", "")),
                    str(row.get("description", "")),
                    str(row.get("folder", "")),
                    str(row.get("fileName", "")),
                    str(row.get("category", "")),
                ]
            ).lower()
            if query not in haystack:
                continue

        if category_filter:
            row_category = str(row.get("category", "")).strip().lower()
            if row_category != category_filter:
                continue

        filtered.append(
            {
                **row,
                "viewUrl": f"/library/documents/{row['id']}/view",
                "rawUrl": f"/library/documents/{row['id']}/raw",
                "downloadUrl": f"/library/documents/{row['id']}/download",
            }
        )

    return {"items": filtered, "total": len(filtered)}


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
