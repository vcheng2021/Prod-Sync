# eComInt

Local product workspace for importing supplier Excel data, editing product content, retrieving source details, and publishing approved products to Shopify.

The application uses a React/Vite client and an Express/TypeScript server. SQLite is the source of truth for the current catalog, while the JSON Lines event log records operational failures and outcomes.

## Quick start

```powershell
npm install
npm install --prefix client
./start.ps1
```

Open `http://localhost:5173` (Vite dev server port, configurable via `VITE_DEV_PORT` in `.env`). Stop local processes with `./stop.ps1`.

The server persists its catalog in SQLite, writes operational events to `logs/ecomint.log`, and stores downloaded images in `productimage`. Copy `.env.example` to `.env` and configure Shopify credentials and `SHOPIFY_LOCATION_ID` before publishing. The Shopify token is server-only and must have product and inventory permissions.

## Application workflow

1. Import an `.xlsx` workbook. Column B is the stable supplier product key; matching rows merge into the existing SQLite catalog.
2. Check rows and explicitly retrieve source details or images. Checking a row alone does not make a supplier request.
3. Edit any supported product field. Ordinary edits remain in the browser dirty-field map until **Save changes** is pressed.
4. Open the posting review. The publish request includes the staged field changes and persists them transactionally before Shopify receives the product, so the posted values match the review values. Suggested sale price becomes the Shopify variant retail price; unit price becomes Shopify's inventory-item cost; the app brand becomes the Shopify product vendor, the app product type becomes the Shopify product type, and tags are derived from a non-empty subset of brand, product type, and country.
5. Select the **Posting issues** metric to read failure entries from `logs/ecomint.log`. The view includes timestamps, event names, product IDs, Shopify field paths, and error messages.

The **Reset page** action clears the current screen, filters, selections, messages, issue view, and unsaved browser state without deleting SQLite data. Use **Purge database** only when the local catalog, cache, publish history, and downloaded application-owned images should be deleted.

Shopify API version `2026-07` requires an `@idempotent` key on inventory mutations. The publisher supplies a new key for inventory activation and quantity updates. The installed Shopify app/token must still be reauthorized with `write_inventory` and permission to manage the configured location. Shopify's variant `unitPrice` is calculated from unit-price measurements; the editable Shopify field updated by this app is inventory-item `cost`, displayed as "Cost per item".

### Workspace layout and theme

The product table and details editor expand full-height to the browser viewport. The workspace grid grows to fill the remaining window after the brand bar, heading, toolbar, and filter bar; table content and the editor scroll internally. On narrow screens the layout collapses to a single column. The application uses a warm cellar-shop color palette with amber lighting glows in both light and dark themes.

## Docker

```powershell
docker compose up -d --build
```

Open `http://localhost:8787` (or your `HOST_PORT` from `.env`). Check health with:

```powershell
Invoke-WebRequest http://localhost:$env:HOST_PORT/api/health
docker compose ps
```

Compose persists SQLite data, logs, and downloaded images in named volumes. Stop without removing data with `docker compose down`.

## Documentation

- [Technical architecture](docs/ARCHITECTURE.md)
- [Support runbook](docs/SUPPORT.md)
- [Implementation plan](IMPLEMENTATION_PLAN.md)
- [Change history](CHANGELOG.md)

This is a single-instance internal application. Do not run multiple containers against the same SQLite volume. Never commit `.env`, Shopify tokens, database files, logs, or downloaded images.
