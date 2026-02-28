# OVH VPS Deployment (Backend + RAG + PDF Library)

This guide prepares the backend for a VPS deployment with:
- RAG index (`data/index`)
- legal PDFs (`droit donnees`)
- library endpoints (`/library/...`) usable from web and mobile

## 1) Copy project to the VPS

From your local machine (PowerShell or Git Bash):

```bash
rsync -avz --delete \
  --exclude ".git" \
  --exclude "frontend/node_modules" \
  --exclude "mobile_flutter/build" \
  ./ ubuntu@51.77.211.7:/home/ubuntu/chatbot-juridique/
```

If your legal PDFs are not committed, this step still copies them physically to the VPS.

## 2) Connect and bootstrap runtime

```bash
ssh ubuntu@51.77.211.7
cd /home/ubuntu/chatbot-juridique
chmod +x scripts/vps/*.sh
./scripts/vps/bootstrap_backend.sh
```

If you want ingestion/chunking/embeddings on the VPS too:

```bash
./scripts/vps/bootstrap_backend.sh --with-ingestion
```

## 3) Configure environment

```bash
cp .env.example .env
nano .env
```

Minimum values to check:

```env
APP_ENV=production
LLM_PROVIDER=nvidia
NVIDIA_API_KEY=...
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=deepseek-ai/deepseek-v3.2

RAG_ENABLED=true
RAG_INDEX_DIR=data/index
LEGAL_DATA_DIR=droit donnees

ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:7410,http://127.0.0.1:7410,https://your-frontend-domain.com
TRUSTED_HOSTS=localhost,127.0.0.1,51.77.211.7,backend.example.com
```

## 4) Smoke test on VPS

```bash
./scripts/vps/run_backend.sh
```

In another terminal:

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/ready
```

Expected:
- `/health` returns `status=ok`
- `/ready` returns `status=ready`

## 5) Run as a service (systemd)

```bash
sudo cp deploy/systemd/juridique-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable juridique-backend
sudo systemctl start juridique-backend
sudo systemctl status juridique-backend --no-pager
```

If your project path/user is different, edit the service file first.

## 6) Optional reverse proxy (Nginx)

```bash
sudo apt-get install -y nginx
sudo cp deploy/nginx/juridique-backend.conf /etc/nginx/sites-available/juridique-backend
sudo ln -s /etc/nginx/sites-available/juridique-backend /etc/nginx/sites-enabled/juridique-backend
sudo nginx -t
sudo systemctl reload nginx
```

Then update `server_name` in the nginx file and attach a domain.

## 7) Frontend and mobile against VPS backend

- Web frontend local:
  - set `NEXT_PUBLIC_BACKEND_URL=http://51.77.211.7:8000` in `frontend/.env.local`
- Mobile:
  - run with `--dart-define=BACKEND_URL=http://51.77.211.7:8000`

This keeps PDF reading inside the app via `/library/documents/{id}/view`.
