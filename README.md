# Chatbot Juridique - Backend MVP

This repo now includes step 1 and step 2:
- Step 1: secret management via environment variables
- Step 2: FastAPI backend with health check and streaming chat endpoint

## 1) Security first (required)

The NVIDIA key previously posted must be revoked and replaced.

1. Revoke the exposed key in NVIDIA Integrate portal.
2. Generate a new key.
3. Create `.env` from `.env.example` and set the new key.

Example `.env`:

```env
NVIDIA_API_KEY=your_new_key_here
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=deepseek-ai/deepseek-v3.2
ALLOWED_ORIGINS=http://localhost:3001,http://127.0.0.1:3001
ALLOWED_ORIGIN_REGEX=
```

DeepSeek official API (local test only) example:

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=your_deepseek_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

## 2) Install and run

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn backend.app.main:app --reload --port 8000
```

## 3) Endpoints

- `GET /health`
- `GET /ready`
- `POST /chat` (JSON final, non-streaming)
- `POST /chat/stream` (SSE)

### `/health` example

```bash
curl http://localhost:8000/health
```

### `/ready` example

```bash
curl http://localhost:8000/ready
```

### `/chat/stream` example

```bash
curl -N -X POST "http://localhost:8000/chat/stream" ^
  -H "Content-Type: application/json" ^
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Bonjour\"}]}"
```

SSE events sent by backend:
- `meta`
- `reasoning`
- `token`
- `done`
- `error`

### `/chat` example (final text only)

```bash
curl -X POST "http://localhost:8000/chat" ^
  -H "Content-Type: application/json" ^
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Bonjour\"}]}"
```

## 4) Ingestion (steps 1 to 4 of RAG prep)

This command performs:
- step 1: OCR environment check (tesseract + language)
- step 2: source inventory and `manifest.jsonl`
- step 3: native extraction (`.pdf`)
- step 4: OCR fallback on low-text PDF pages

```bash
python -m backend.ingestion.run --input-dir "droit donnees" --output-dir "data/ingestion" --tessdata-dir "data/ocr/tessdata"
```

Useful options:

```bash
python -m backend.ingestion.run ^
  --input-dir "droit donnees" ^
  --output-dir "data/ingestion" ^
  --min-native-chars 1 ^
  --ocr-lang fra ^
  --ocr-dpi 200 ^
  --workers 8 ^
  --tessdata-dir "data/ocr/tessdata"
```

Docling parser (recommended for complex layouts/tables):

```bash
python -m backend.ingestion.run ^
  --input-dir "droit donnees" ^
  --output-dir "data/ingestion" ^
  --pdf-parser docling
```

Auto mode (default): uses Docling if installed, otherwise native parser + OCR fallback.

Artifacts generated in `data/ingestion`:
- `manifest.jsonl`
- `pages.jsonl`
- `doc_report.jsonl`
- `ingestion_report.json`

If OCR does not run, install Tesseract and ensure language `fra` is available.
You can place `fra.traineddata` in `data/ocr/tessdata` and pass `--tessdata-dir`.
`tqdm` progress bar is shown while processing documents.

## 5) Article-First Chunking

Build RAG-ready chunks from `data/ingestion/pages.jsonl`:

```bash
python -m backend.chunking.run ^
  --pages-path "data/ingestion/pages.jsonl" ^
  --output-path "data/chunks/chunks.jsonl" ^
  --report-path "data/chunks/chunking_report.json" ^
  --max-tokens 900 ^
  --overlap-tokens 120 ^
  --min-chunk-chars 120
```

Strict mode (one detected article per chunk):

```bash
python -m backend.chunking.run ^
  --pages-path "data/ingestion/pages.manual.cleaned.jsonl" ^
  --output-path "data/chunks/chunks.jsonl" ^
  --report-path "data/chunks/chunking_report.json" ^
  --max-tokens 900 ^
  --overlap-tokens 120 ^
  --min-chunk-chars 120 ^
  --max-page-span 6 ^
  --strict-article-chunks
```

Chunk outputs:
- `data/chunks/chunks.jsonl`
- `data/chunks/chunking_report.json`

Chunking strategy:
- Article-first segmentation (`Article ...` / `Art. ...`)
- Keep article chunks intact when possible
- Split only long article blocks with overlap
- Preserve metadata for citation (`relative_path`, `page_start`, `page_end`, `article_hint`)

Validation (check one-article-per-chunk constraints):

```bash
python -m backend.chunking.validate_article_chunks ^
  --chunks-path "data/chunks/chunks.jsonl" ^
  --max-headers-per-chunk 1
```

Optional stricter check (may fail on compilations that reuse article numbers):

```bash
python -m backend.chunking.validate_article_chunks ^
  --chunks-path "data/chunks/chunks.jsonl" ^
  --max-headers-per-chunk 1 ^
  --enforce-unique-doc-article
```

## 7) Embeddings (Step 1 before Vector Index)

Generate embeddings from `chunks.jsonl`:

```bash
python -m backend.embeddings.run ^
  --chunks-path "data/chunks/chunks.jsonl" ^
  --output-path "data/embeddings/embeddings.jsonl" ^
  --report-path "data/embeddings/embedding_report.json" ^
  --provider "sentence-transformers" ^
  --model "Snowflake/snowflake-arctic-embed-l-v2.0" ^
  --batch-size 16
```

NVIDIA provider (API) example:

```bash
python -m backend.embeddings.run ^
  --chunks-path "data/chunks/chunks.jsonl" ^
  --output-path "data/embeddings/embeddings.jsonl" ^
  --report-path "data/embeddings/embedding_report.json" ^
  --provider "nvidia" ^
  --model "your-embedding-model" ^
  --input-type passage ^
  --max-input-tokens 512 ^
  --batch-size 32
```

You can set the model once in `.env`:

```env
NVIDIA_EMBEDDING_MODEL=your-embedding-model
```

Then run without `--model`:

```bash
python -m backend.embeddings.run
```

## 8) Aggressive Reranking (Hybrid + Cross-Encoder)

The backend now supports aggressive reranking on top of hybrid retrieval.

`.env` settings:

```env
RAG_RERANKER_ENABLED=true
RAG_RERANKER_MODEL=BAAI/bge-reranker-v2-m3
RAG_RERANKER_DEVICE=cuda
RAG_RERANKER_BATCH_SIZE=16
RAG_RERANKER_POOL_SIZE=50
RAG_DOMAIN_FILTER_ENABLED=true
RAG_TARGET_MIN_CHUNKS=8
RAG_TARGET_MAX_CHUNKS=10
RAG_ADAPTIVE_THRESHOLD_ENABLED=true
RAG_ADAPTIVE_THRESHOLD_FLOOR=0.22
RAG_ADAPTIVE_THRESHOLD_STEP=0.03
RAG_MIN_SOURCE_CITATIONS=3
RAG_NEUTRAL_FALLBACK_MAX=2
```

Behavior:
- Hybrid retrieval (dense + BM25) builds a candidate pool.
- Article-aware rerank reorders candidates.
- Cross-encoder rerank scores top pool and keeps final `RAG_TOP_K`.
- Domain filter prioritizes chunks from the legal branch detected in the question (e.g. travail vs penal).

## 6) Manual Text Override (No OCR)

If a PDF has broken native text extraction (control characters), you can inject
a manually corrected text for that document and keep the rest unchanged.

1. Put the corrected plain text in a file, for example:
- `data/manual_overrides/code_secutrite_sociale.txt`

2. Apply override to `pages.jsonl`:

```bash
python -m backend.ingestion.apply_manual_override ^
  --pages-path "data/ingestion/pages.jsonl" ^
  --relative-path "code securite social/code_secutrite_sociale.pdf" ^
  --text-path "data/manual_overrides/code_secutrite_sociale.txt" ^
  --output-pages-path "data/ingestion/pages.manual.jsonl" ^
  --report-path "data/ingestion/manual_override_report.json"
```

PowerShell alternative (read text directly from clipboard):

```bash
Get-Clipboard | python -m backend.ingestion.apply_manual_override ^
  --pages-path "data/ingestion/pages.jsonl" ^
  --relative-path "code securite social/code_secutrite_sociale.pdf" ^
  --text-path "-" ^
  --output-pages-path "data/ingestion/pages.manual.jsonl" ^
  --report-path "data/ingestion/manual_override_report.json"
```

3. Rebuild chunks from the overridden pages file:

```bash
python -m backend.chunking.run ^
  --pages-path "data/ingestion/pages.manual.jsonl" ^
  --output-path "data/chunks/chunks.manual.jsonl" ^
  --report-path "data/chunks/chunking_report.manual.json" ^
  --max-tokens 900 ^
  --overlap-tokens 120 ^
 --min-chunk-chars 120 ^
  --max-page-span 6
```

## 8) Local Vector Index + Retrieval (RAG)

After embeddings are generated, build a local index used by the chat API:

```bash
python -m backend.retrieval.build_index ^
  --embeddings-path "data/embeddings/embeddings.jsonl" ^
  --chunks-path "data/chunks/chunks.jsonl" ^
  --index-dir "data/index" ^
  --metric "cosine"
```

Artifacts generated in `data/index`:
- `index.faiss` (FAISS index, exact search)
- `meta.jsonl` (chunk text + citation metadata aligned with vectors)
- `index_report.json`

RAG config (in `.env`):

```env
RAG_ENABLED=true
RAG_INDEX_DIR=data/index
RAG_TOP_K=5
RAG_MAX_CONTEXT_CHARS=12000
RAG_EMBEDDING_MODEL=Snowflake/snowflake-arctic-embed-l-v2.0
RAG_EMBEDDING_DEVICE=cuda
```

When enabled, `POST /chat/stream` will:
- embed the latest user query with `RAG_EMBEDDING_MODEL`
- retrieve dense candidates from the FAISS index
- overfetch candidates then apply article-aware reranking (`L.18` vs `L.180`/`L.181`)
- inject the retrieved context into the system prompt before LLM generation

## 9) Next.js Frontend (MVP)

A simple frontend is available in `frontend/`:
- ask a legal question
- display final answer
- display retrieved RAG sources
- mark feedback (`Correct`, `Incomplet`, `Faux`)

Run:

```bash
cd frontend
npm install
npm run dev
```

The app runs on:
- `http://localhost:3001`

If needed, set backend URL in `frontend/.env.local`:

```env
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000
```

## 10) Production deployment checklist

OVH VPS step-by-step guide:
- `docs/DEPLOY_VPS_OVH.md`

### Backend environment (required)

Use `.env` with production-safe values:

```env
APP_ENV=production
LLM_PROVIDER=nvidia
NVIDIA_API_KEY=your_real_key
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=deepseek-ai/deepseek-v3.2

ALLOWED_ORIGINS=https://your-frontend-domain.com
ALLOWED_ORIGIN_REGEX=https://.*\.vercel\.app
TRUSTED_HOSTS=your-api-domain.com
API_DOCS_ENABLED=false
REQUEST_MAX_BODY_MB=25
GZIP_ENABLED=true
GZIP_MIN_SIZE=500
RATE_LIMIT_ENABLED=true
RATE_LIMIT_REQUESTS_PER_MINUTE=120

RAG_ENABLED=true
RAG_INDEX_DIR=data/index
LEGAL_DATA_DIR=droit donnees
RAG_EMBEDDING_MODEL=Snowflake/snowflake-arctic-embed-l-v2.0

SPEECH_ENABLED=false
```

Notes:
- `TRUSTED_HOSTS` must match your API host(s).
- Use `ALLOWED_ORIGIN_REGEX` to authorize Vercel preview domains.
- `LEGAL_DATA_DIR` controls where downloadable PDF files are discovered (recursive scan).
- Keep `SPEECH_ENABLED=false` unless your server is sized for Whisper.
- Ensure `data/index/index.faiss` and `data/index/meta.jsonl` exist on the server.

### Render blueprint

The repository now includes `render.yaml` for one-click backend deployment on Render.
You still need to set sensitive values in Render dashboard:
- `NVIDIA_API_KEY`
- `ALLOWED_ORIGINS`
- `TRUSTED_HOSTS`

### Railway deployment (ready)

The repository now includes:
- `railway.toml`
- `Procfile`

Both point to the same backend start command:

```bash
uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}
```

Minimal Railway variables to set:
- `APP_ENV=production`
- `LLM_PROVIDER=nvidia`
- `NVIDIA_API_KEY=...`
- `NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1`
- `NVIDIA_MODEL=deepseek-ai/deepseek-v3.2`
- `ALLOWED_ORIGINS=https://your-frontend-domain.com`
- `TRUSTED_HOSTS=your-railway-domain.up.railway.app`
- `RAG_ENABLED=true`
- `RAG_INDEX_DIR=data/index`
- `LEGAL_DATA_DIR=droit donnees`

Optional (recommended for browser testing from multiple origins):
- `ALLOWED_ORIGIN_REGEX=^https?://(localhost|127\\.0\\.0\\.1|.*\\.railway\\.app|.*\\.vercel\\.app)(:\\d+)?$`

### Backend run command (Linux production)

```bash
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --workers 2
```

### Frontend build/start (production)

```bash
cd frontend
npm ci
npm run build
npm run start:fast
```

Set frontend env:

```env
NEXT_PUBLIC_BACKEND_URL=https://your-api-domain.com
```

### Readiness validation before traffic

```bash
curl https://your-api-domain.com/health
curl https://your-api-domain.com/ready
```

Expected:
- `/health` returns `status=ok`
- `/ready` returns `status=ready`
