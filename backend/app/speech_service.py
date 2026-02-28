from __future__ import annotations

import logging
import os
import tempfile
from functools import lru_cache
from pathlib import Path

from .shared_runtime import settings


LOGGER = logging.getLogger(__name__)


def _resolve_whisper_device(raw_device: str) -> str:
    device = (raw_device or "auto").strip().lower()
    if device in {"cpu", "cuda"}:
        return device
    if device == "auto":
        # GPU when available, otherwise CPU.
        try:
            import torch  # type: ignore

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"
    return "cpu"


@lru_cache(maxsize=1)
def get_whisper_model():
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "faster-whisper is not installed. Install dependencies with `pip install -r requirements.txt`."
        ) from exc

    requested_device = (settings.whisper_device or "auto").strip().lower()
    resolved_device = _resolve_whisper_device(requested_device)

    try:
        return WhisperModel(
            settings.whisper_model_size,
            device=resolved_device,
            compute_type=settings.whisper_compute_type,
        )
    except Exception as exc:  # noqa: BLE001
        # Common on Windows when CUDA runtime/cuBLAS DLLs are missing:
        # "Library cublas64_12.dll is not found or cannot be loaded"
        should_fallback_to_cpu = resolved_device == "cuda" and requested_device in {"auto", "cuda"}
        if not should_fallback_to_cpu:
            raise RuntimeError(f"Failed to initialize Whisper model: {exc}") from exc

        LOGGER.warning(
            "Whisper CUDA init failed (%s). Falling back to CPU with int8.",
            exc,
        )
        try:
            return WhisperModel(
                settings.whisper_model_size,
                device="cpu",
                compute_type="int8",
            )
        except Exception as cpu_exc:  # noqa: BLE001
            raise RuntimeError(
                f"Failed to initialize Whisper model on CUDA and CPU fallback: {cpu_exc}"
            ) from cpu_exc


def transcribe_audio_file(file_path: Path) -> dict[str, str]:
    model = get_whisper_model()
    language = settings.whisper_language or None

    segments, info = model.transcribe(
        str(file_path),
        language=language,
        beam_size=settings.whisper_beam_size,
        vad_filter=settings.whisper_vad_filter,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text).strip()
    detected_language = getattr(info, "language", None) or language or ""
    return {
        "text": text,
        "language": str(detected_language),
        "model": settings.whisper_model_size,
    }


def transcribe_audio_bytes(audio_bytes: bytes, suffix: str = ".webm") -> dict[str, str]:
    if not audio_bytes:
        return {"text": "", "language": "", "model": settings.whisper_model_size}

    safe_suffix = suffix if suffix.startswith(".") else f".{suffix}"
    with tempfile.NamedTemporaryFile(delete=False, suffix=safe_suffix) as tmp_file:
        tmp_file.write(audio_bytes)
        tmp_path = Path(tmp_file.name)

    try:
        return transcribe_audio_file(tmp_path)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
