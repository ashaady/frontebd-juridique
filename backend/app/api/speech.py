from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from ..shared_runtime import settings
from ..speech_service import transcribe_audio_bytes

router = APIRouter(prefix="/speech", tags=["speech"])


@router.post("/transcribe")
async def speech_transcribe(file: UploadFile = File(...)):
    if not settings.speech_enabled:
        raise HTTPException(status_code=503, detail="Speech transcription is disabled.")

    filename = (file.filename or "").strip()
    suffix = Path(filename).suffix.lower() if filename else ".webm"

    allowed_ext = {".webm", ".wav", ".mp3", ".m4a", ".ogg", ".mp4", ".mpeg"}
    if suffix and suffix not in allowed_ext:
        raise HTTPException(status_code=400, detail=f"Unsupported audio format: {suffix}")

    audio_bytes = await file.read()
    await file.close()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio payload.")

    try:
        result = transcribe_audio_bytes(audio_bytes, suffix=suffix or ".webm")
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}")

    text = (result.get("text") or "").strip()
    return {
        "text": text,
        "language": result.get("language") or "",
        "model": result.get("model") or settings.whisper_model_size,
    }

