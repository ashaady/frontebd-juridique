# Frontend Next.js

## Prerequis
- Node.js 20+ (Node 22 ok)

## Installation
```bash
cd frontend
npm install
```

## Configuration
Copier le fichier d'exemple:

```bash
cp .env.local.example .env.local
```

Valeur par defaut:
- `NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000`

## Lancer en dev
```bash
npm run dev
```

Interface disponible sur:
- `http://localhost:3000`

Le frontend appelle:
- `POST /chat/stream` du backend FastAPI
