# eComInt Change History

## 2026-08-29 — VIC-1

### JIRA VIC-1 — Centralized port configuration

- All application ports are now configurable via a single `.env` file: `PORT` (Express API server, default `8787`), `HOST_PORT` (Docker host-facing port, default matches `PORT`), and `VITE_DEV_PORT` (Vite dev server, default `5173`).
- `client/vite.config.ts` now loads the project-root `.env` and uses `PORT` as the proxy target instead of a hardcoded `8787`.
- `docker-compose.yml` reads `PORT` and `HOST_PORT` from `.env` for the container environment, port mapping, and healthcheck (previously hardcoded `8787`).
- `Dockerfile` `HEALTHCHECK` now reads `process.env.PORT` instead of hardcoding `8787`.
- `start.ps1` and `stop.ps1` both parse `.env` to determine `PORT` and `VITE_DEV_PORT` for availability checks and health probing.
- Updated `.env.example`, `CLAUDE.md`, `README.md`, `client/README.md`, `docs/ARCHITECTURE.md`, and `docs/SUPPORT.md` to reflect the centralized, `.env`-driven port configuration.
- Verified: `npm run typecheck` passes; `./start.ps1` starts API on `PORT` (8002) and Vite on `VITE_DEV_PORT` (5173) with both health endpoints responding `200`; `docker compose config` resolves `PORT=8002` and the dynamic healthcheck correctly.

## 2026-08-28 — VIC-3

### JIRA VIC-3 — Featured product flag and Shopify collection

- Added a **Featured** checkbox to the product details editor panel. When checked, the product is added to a Shopify custom collection on publish.
- The `featured` flag is app-owned: stored as `is_featured` in the `products` table (with a backward-compatible migration), preserved across workbook merges, and staged in the client dirty-field map before Save.
- Added `FEATURED_COLLECTION_TITLE` and `FEATURED_COLLECTION_HANDLE` constants and four new functions in `productPublisher.ts`: `resolveFeaturedCollectionId`, `addProductToCollection`, `removeProductFromCollection`, and `manageFeaturedCollection`.
- The featured collection is resolved from the optional `SHOPIFY_FEATURED_COLLECTION_ID` environment variable, falling back to a handle-based lookup (`featured-collection`) with auto-creation if absent.
- `collectCreate` and `collectDelete` mutations are idempotent: existing collects are checked before creation, and removal only targets the matching collect.
- Collection-management failures are caught and appended to the publish result's error string without changing the product's publish status from `published`.
- Updated `docs/ARCHITECTURE.md`, `docs/SUPPORT.md`, `IMPLEMENTATION_PLAN.md`, `.env.example`, and `docker-compose.yml`.

## 2026-08-28 — VIC-2

### JIRA VIC-2 — Table view and toolbar

- Added a **Sale price** column to the product table. Each row displays the product's suggested sale price, which is either app-calculated (`unit price × 1.25`) on import or a manually overridden value preserved across workbook merges.
- Moved the **Export all data** button from the workspace heading into the top toolbar, adjacent to the **Reset page** button.
- Updated `CHANGELOG.md` to record these changes.

## 2026-08-28

### Bug fixes

- Removed the invalid `ignoreCompareQuantity` field from the `inventorySetQuantities` input in `productPublisher.ts`. The field is not defined on `InventorySetQuantitiesInput` in Admin API `2026-07`; the compare-and-swap check is already skipped via `changeFromQuantity: null`. This error caused the entire `updateInventory` call (and therefore the whole publish operation) to fail, which also prevented images from being posted.
- Cleared `logIssues` and `issuesOpen` in `clearTransientState` so the Reset page action flushes stale posting-issue panel state alongside the draft and filters.

### Product editing and publishing

- Fixed the publish path so staged browser edits are included in `POST /api/drafts/:draftId/publish` and persisted through `DraftStore.updateProducts` before the server reads products for Shopify.
- Covered all supported editable fields, including title, unit price, case price, supplier stock, suggested sale price, Shopify inventory, description, and About fields.
- Preserved pending browser edits when a source retrieval response is merged into the client draft.
- Kept manually edited suggested sale prices as overrides during later workbook merges while still recalculating prices that remain automatic.
- Mapped the local supplier unit price to Shopify's inventory-item `cost` field through `inventoryItemUpdate`, which appears in Shopify as Cost per item. The suggested sale price remains the variant retail `price`; Shopify's calculated variant `unitPrice` is not overwritten.
- Mapped the app `brand` field to the Shopify product `vendor`, the app `productType` field to the Shopify `productType`, and derived Shopify `tags` from a non-empty subset of `[brand, productType, country]` — no additional Shopify scopes are required since `write_products` already covers these standard product fields.

### UI layout and theme

- Made the product table and product details editor full-height: the `.workspace-shell` is now a flex column and `.workspace-grid` grows to fill the remaining viewport height, so both panels expand dynamically to the browser height. The table content scrolls internally within `.table-wrap`; the editor panel scrolls vertically. Both panels collapse to natural height on screens narrower than 1050 px.
- Refined the app background to a warm cellar-shop theme: adjusted `--paper` and `--panel` tokens and replaced the diagonal gradient pair with radial lighting glows that evoke amber cellar lighting in both light and dark modes.

### Shopify inventory

- Added unique `@idempotent(key: ...)` directives and UUID keys to `inventoryActivate` and `inventorySetQuantities` for Admin API version `2026-07`.
- Preserved Shopify GraphQL transport error codes and mutation field paths in publish errors where Shopify supplies them.
- Documented the required `write_inventory` scope and the installing user's permission to activate inventory at the configured location. Scope changes require app reauthorization or reinstall.

### Issues and reset behavior

- Added `GET /api/issues?draftId=<id>`, which reads reverse-chronological failure records from `logs/ecomint.log` and returns up to 100 entries for the requested draft.
- Added a clickable Posting issues metric that displays event names, timestamps, product IDs, Shopify errors, field paths, and structured log details.
- Added the Reset page action. It clears the visible client draft, filters, selections, messages, issue state, modal state, and unsaved browser edits without deleting SQLite, logs, or images.
- Kept Purge database as the explicit destructive action for clearing persisted catalog state.

### Verification

- `npm run typecheck` passes.
- `npm run build` passes for the Vite client and TypeScript server.
- The live `/api/issues` endpoint returns structured failure records without exposing credentials.
