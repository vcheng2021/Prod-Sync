# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

eComInt is a single-instance internal product workspace: import supplier Excel workbooks, enrich selected rows from supplier source pages, edit product content in a React table, and publish confirmed products to one Shopify store (`cb1710-2.myshopify.com`). The browser never receives the Shopify Admin token — all supplier/Shopify requests, file writes, and SQLite mutations happen server-side. See `docs/ARCHITECTURE.md` (implemented behavior), `docs/SUPPORT.md` (operator runbook), `IMPLEMENTATION_PLAN.md` (design plan), and `CHANGELOG.md` for full detail.

## Project layout

```
.                      # Express/TypeScript server, root config, Docker
  server/src/          # API: index.ts bootstrap, config.ts, types.ts
  server/src/routes/   # imports.ts (import/merge/save/purge/retrieve/issues)
                      #   publishing.ts (export/publish)
  server/src/drafts/   # draftStore.ts — SQLite + schema + migrations + merge
  server/src/imports/  # xlsxParser.ts — maps columns A/B/E/F/G/I/J
  server/src/enrichment/ # sourcePageFetcher, productDetailsExtractor,
                      #   htmlSanitizer, imageDownloader
  server/src/shopify/  # adminGraphqlClient, productPublisher
  server/src/logging/  # logger.ts — redacted JSON Lines, readIssues()
  server/src/exports/  # excelExporter.ts
client/                # React 19 + Vite SPA (single App.tsx, api.ts)
data/                  # SQLite catalog (ecomint.db + WAL) — runtime, gitignored
logs/ecomint.log       # physical audit log — runtime, gitignored
productimage/          # downloaded images — runtime, gitignored
suppliers/             # seed workbook (sup2_paramountliquor.xlsx)
manager-prod/          # Separate Shopify app scaffold (template). Not part of
                      #   eComInt; excluded from .dockerignore and Docker build.
```

## Commands

Windows PowerShell is the primary shell on this machine.

| Task | Command |
|---|---|
| Install deps (root + client) | `npm install`; `npm install --prefix client` |
| Dev (full stack) | `./start.ps1` — server `:8787`, Vite client `:5173` |
| Dev (server only) | `npm run dev:server` → `tsx watch server/src/index.ts` |
| Dev (client only) | `npm run dev:client` → `npm --prefix client run dev` |
| Stop dev processes | `./stop.ps1` |
| Build (client + server) | `npm run build` |
| Typecheck (both) | `npm run typecheck` (`tsc` server + `tsc -b` client) |
| Lint (client) | `npm --prefix client run lint` → `oxlint` |
| Run built server | `npm start` (after `npm run build`) |
| Build Docker image | `docker build -t ecomint:latest .` |
| Run via Compose | `docker compose up -d --build` |
| Health check | `Invoke-WebRequest http://localhost:8787/api/health` |

There is **no test script** — the package.json has no `test` target and no test framework is installed. Validation is described as operational checks in `IMPLEMENTATION_PLAN.md` (§12) and `docs/SUPPORT.md` (§14).

The client proxies `/api` and `/productimage` to `http://localhost:8787` (see `client/vite.config.ts`), so a running server is required when developing the client alone.

## Architecture

### Server (Express + TypeScript + better-sqlite3)

`server/src/index.ts` wires everything: reads config → builds the SQLite `DraftStore` → runs one-time startup seed/restore → registers route routers → serves `client/dist` as static assets (with an SPA fallback that excludes `/api` and `/productimage`).

**Startup state machine** (`docs/ARCHITECTURE.md` §5):
1. Create or migrate the SQLite schema.
2. If the `initial_seed_completed` app-state marker is absent and the DB has no products, seed once from `suppliers/sup2_paramountliquor.xlsx` (no supplier network requests during seed). If products already exist, just restore.
3. The default workbook is a **first-run seed, not a recurring sync**. After a purge, the marker stays set, so restarting leaves the catalog empty — import explicitly.

**Key modules:**
- `config.ts` — all server config comes from `.env` (loaded via `dotenv`). Never hardcode paths, timeouts, the Shopify token, or the URL allowlist in code. Defaults: port 8787, `./data/ecomint.db`, `./logs`, `./productimage`.
- `imports.ts` router — upload/merge, current draft, issues log reader, single-product patch, **bulk Save**, purge, retrieve, refresh.
- `publishing.ts` router — XLSX export and confirmed publish.
- `draftStore.ts` — owns schema creation, column migrations, the workbook merge transaction, dirty-field updates (allowlisted fields only), enrichment/image/publish result persistence, cache, and purge. Uses WAL mode.
- `xlsxParser.ts` — column mapping: **A** image URL, **B** supplier key (preserved as text, normalized for dedup), **E** title, **F** source URL, **G** SOH, **I** case price, **J** unit price. Suggested sale price = unit price × 1.25. Inventory defaults to 1 when SOH > 2, else 0. Missing/conflicting column-B keys are row-level errors, not silent guesses.
- `enrichment/` — `sourcePageFetcher.ts` validates URLs (HTTPS only, allowlist, DNS private-IP blocking, redirect/timeout/size limits), fetches via supplier catalog/JSON endpoints then HTML fallback, with Cheerio extraction (`productDetailsExtractor.ts`) and `sanitize-html` (`htmlSanitizer.ts`, `plainTextToHtml.ts`). Retrieval is **explicit only for checked rows** — import and checkbox toggles never make network requests. Enrichment results merge with pending client edits so source data can't overwrite unsaved manual changes.
- `shopify/` — `adminGraphqlClient.ts` (single `request` method, checks transport errors + `userErrors`), `productPublisher.ts` (title-match query → one match updates, zero matches creates, multiple matches skips). Suggested sale price → variant `price`; unit price → `inventoryItemUpdate` cost; inventory activation + `inventorySetQuantities` with `@idempotent` keys (API 2026-07). Images added only on create.
- `logging/logger.ts` — append-only JSON Lines to `logs/ecomint.log`; `readIssues()` reads reversed failure entries; redacts keys matching `token|secret|password|authorization|credential|cookie`. Request bodies and raw Shopify responses are never logged.

### Client (React 19 + Vite, single-file `App.tsx`)

All UI state lives in `App.tsx`. Ordinary field edits are staged in a **dirty-field map** keyed by product ID; **Save** sends only changed allowlisted fields via `PATCH /api/drafts/:draftId/products`. Publishing sends the same staged changes alongside the selected product IDs; the server persists them **before** reading products for Shopify. Column filters, title sort, and pagination are client-side on the loaded catalog.

`api.ts` is a thin typed `fetch` wrapper — it contains **no credentials and no Shopify configuration**.

### Data ownership and field rules

- **Supplier-owned** (refreshed on matching workbook merge): column B key, raw row, image URL, title, source URL, SOH (G), case price (I), unit price (J).
- **App-owned** (preserved across merges unless source URL changes): Shopify inventory quantity, manually edited suggested sale price (once overridden, never auto-recalculated), description/about enrichment, selection state, retrieval state, Shopify IDs and publish status.
- Supplier SOH (column G) is **not** Shopify inventory — the editable inventory field is the value sent to Shopify.
- Suggested sale price, once operator-edited, is an override; later workbooks recalculate only prices that are still automatic (= unit price × 1.25).

### API surface (full contracts in `docs/ARCHITECTURE.md` §7)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Express liveness (Docker healthcheck). No Shopify. |
| `GET` | `/api/drafts/current` | Current draft or null. |
| `GET` | `/api/drafts/:draftId` | Specific draft + products. |
| `GET` | `/api/issues?draftId=<id>` | Up to 100 reversed failure records from the log for the draft. |
| `POST` | `/api/imports` | Upload/merge workbook (multipart `workbook`). |
| `PATCH` | `/api/drafts/:draftId/products` | Bulk Save (allowlisted fields only). |
| `PATCH` | `/api/drafts/:draftId/products/:productId` | Single-product patch. |
| `POST` | `/api/drafts/:draftId/products/:productId/retrieve` | Explicit source + image retrieval (checked rows only). |
| `POST` | `/api/drafts/:draftId/products/:productId/refresh` | Re-fetch source details. |
| `GET` | `/api/drafts/:draftId/export` | XLSX export of current draft. |
| `POST` | `/api/drafts/:draftId/publish` | Publish confirmed selected products. |
| `POST` | `/api/database/purge` | Destructive purge (`{ confirmation: "PURGE" }`). |

**Reset page** (client-only) clears visible draft/filters/selections/edits without touching SQLite. **Purge database** deletes catalog products, source cache, publish history, and application-owned images — but retains the schema, initialization marker, and physical log; it never deletes Shopify products.

### Shopify integration

- API version **2026-07**. Scope requirements: `read_products`, `write_products`, `read_inventory`, `write_inventory`. The installing user must also manage the configured location. Scope changes require app reauthorization.
- Inventory activation and `inventorySetQuantities` mutations include a unique `@idempotent(key: ...)` directive with a fresh UUID per call.
- Title matching is case-insensitive, trimmed. Multiple matches → skip for manual resolution. Never auto-delete products.
- Check `userErrors` on every mutation (transport errors retain extension codes; mutation errors retain field paths).

### manager-prod/ (separate, not eComInt)

`manager-prod/` is a Shopify app template scaffold (React Router + Prisma + `shopify.app.toml`) with its own `.AGENTS.md` guidance: use the Shopify AI Toolkit for Shopify API/platform work, and the `shopify-dev-mcp` MCP server is configured via `.cursor/mcp.json` and `.mcp.json`. It is excluded from the eComInt Docker context (`.dockerignore`) and is not built or served by the root server. Do not conflate the two projects.

## Local development

`start.ps1` launches both the Vite dev server (5173) and the Express server with `tsx watch` (8787), tracking PIDs in `.ecomint/processes.json` and writing stdout/stderr to `.ecomint/logs/`. `stop.ps1` walks the process tree and kills them. Ports 5173 and 8787 must be free; the script throws if either is occupied.

Run `npm run typecheck` before committing — it checks both the server and the client. `npm run build` produces `client/dist` and `server/dist` for the production server (`npm start`) or Docker.

The `.env` file (gitignored, see `.env.example`) is loaded by the server. Publishing requires `SHOPIFY_ADMIN_ACCESS_TOKEN` and `SHOPIFY_LOCATION_ID`; import and local editing work without them (the publisher returns a clear failure for missing config).
