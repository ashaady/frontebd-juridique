from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"


def resolve_from_project_root(value: str | None, *, default_relative: str) -> Path:
    raw = (value or "").strip()
    target = Path(raw) if raw else Path(default_relative)
    target = target.expanduser()
    if not target.is_absolute():
        target = PROJECT_ROOT / target
    return target.resolve()


def data_path(*parts: str) -> Path:
    return (DATA_DIR.joinpath(*parts)).resolve()


LEGAL_DATA_DIR = resolve_from_project_root(
    os.getenv("LEGAL_DATA_DIR", "droit donnees"),
    default_relative="droit donnees",
)
