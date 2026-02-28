FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SPEECH_ENABLED=false

WORKDIR /app

# Runtime system dependencies:
# - libgomp1: required by faiss CPU wheels
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.runtime.txt ./requirements.runtime.txt
RUN pip install --upgrade pip \
    && pip install -r requirements.runtime.txt

# Application code
COPY backend ./backend

# Keep only retrieval runtime index files in the image (not chunk/embedding build artifacts).
COPY data/index ./data/index

EXPOSE 8000

CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
