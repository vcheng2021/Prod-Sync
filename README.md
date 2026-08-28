# eComInt

Local product workspace for importing supplier Excel data, editing product content, retrieving source details, and publishing approved products to Shopify.

## Quick start

```powershell
npm install
npm install --prefix client
./start.ps1
```

Open `http://127.0.0.1:5173`. Stop local processes with `./stop.ps1`.

The server persists its catalog in SQLite, writes operational events to `logs/ecomint.log`, and stores downloaded images in `productimage`. Copy `.env.example` to `.env` and configure Shopify credentials and `SHOPIFY_LOCATION_ID` before publishing.

## Docker

```powershell
docker compose up -d --build
```

Open `http://localhost:8787`. Check health with:

```powershell
Invoke-WebRequest http://localhost:8787/api/health
docker compose ps
```

Compose persists SQLite data, logs, and downloaded images in named volumes. Stop without removing data with `docker compose down`.

## Documentation

- [Technical architecture](docs/ARCHITECTURE.md)
- [Support runbook](docs/SUPPORT.md)
- [Implementation plan](IMPLEMENTATION_PLAN.md)

This is a single-instance internal application. Do not run multiple containers against the same SQLite volume. Never commit `.env`, Shopify tokens, database files, logs, or downloaded images.
