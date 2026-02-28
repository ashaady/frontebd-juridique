#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f ".env" ]]; then
  echo "[vps] Missing .env file. Create it from .env.example first."
  exit 1
fi

if [[ ! -d ".venv" ]]; then
  echo "[vps] Missing .venv. Run ./scripts/vps/bootstrap_backend.sh first."
  exit 1
fi

source .venv/bin/activate

PORT="${PORT:-8000}"
WORKERS="${UVICORN_WORKERS:-1}"

echo "[vps] Starting backend on 0.0.0.0:${PORT} (workers=${WORKERS})..."
exec uvicorn backend.app.main:app --host 0.0.0.0 --port "$PORT" --workers "$WORKERS"
