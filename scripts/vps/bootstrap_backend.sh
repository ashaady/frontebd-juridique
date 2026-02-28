#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

REQ_FILE="requirements.runtime.txt"
if [[ "${1:-}" == "--with-ingestion" ]]; then
  REQ_FILE="requirements.txt"
fi

echo "[vps] Installing system packages..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  python3 \
  python3-venv \
  python3-pip \
  build-essential \
  libgomp1 \
  tesseract-ocr \
  tesseract-ocr-fra \
  ffmpeg \
  poppler-utils

if [[ ! -d ".venv" ]]; then
  echo "[vps] Creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

python -m pip install --upgrade pip
python -m pip install -r "$REQ_FILE"

echo "[vps] Bootstrap complete."
echo "[vps] Installed dependencies from: $REQ_FILE"
echo "[vps] Next steps:"
echo "  1) cp .env.example .env"
echo "  2) edit .env"
echo "  3) ./scripts/vps/run_backend.sh"
