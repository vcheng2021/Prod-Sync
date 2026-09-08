# eComInt Change History

## 2026-09-09 — VIC-22, UI refinements

### JIRA VIC-22 — Supplier-aware draft restoration on supplier switch

- When switching suppliers via the Apply button, the app now queries the server for the most recently updated draft matching the new supplier (via `GET /api/drafts/current?supplier=<supplier>`).
- If a saved draft exists for the new supplier, it is restored immediately instead of falling back to the upload/landing page.
- If no matching draft exists, the app clears transient state as before.
- Added `getCurrentDraftBySupplier(userId, supplier)` to `DraftStore` — queries drafts joined with products filtered by supplier, ordered by `updated_at DESC`.
- Added optional `?supplier=` query parameter to the `/api/drafts/current` server endpoint.
- Added `getCurrentDraftBySupplier(supplier)` to `client/src/api.ts`.
- Added `handleSupplierSwitch(newSupplier)` to `App.tsx` to orchestrate the client-side restore/clear logic.
- Updated `docs/ARCHITECTURE.md` §3 (client) and §5 (API contract) to document the supplier-aware current draft endpoint.

### UI: Product list row layout refinements

- Changed `.product-list-row` and `.list-header-row` `align-items` from `center` to `start` so all row content is top-justified.
- Added `align-self: center` to `.check-cell` (both header and data row checkbox cells) to keep checkboxes vertically centered while other content stays top-aligned.
- Made `.list-cell.product-cell` a flex container with `align-items: flex-start` and `gap: 10px` so the thumbnail sits to the left of the title rather than above it.
- Added `align-self: center` to `.thumb` to vertically center the product image within the product-cell.
- Updated `docs/ARCHITECTURE.md` §3 (client) to document the product list row layout.

### UI: Detail pane freeze-at-top

- `.detail-pane` now uses `position: sticky; top: 0` with `height: calc(100dvh - 74px)` and `overflow-y: auto` so the detail pane stays pinned at the top of the browser window while scrolling the product list, with its own internal scrollbar for tall content.
- `.detail-pane-container` uses `height: 100%` without overflow restrictions to allow the sticky behavior to work relative to the viewport.
- Updated `docs/ARCHITECTURE.md` §3 (client) to document the sticky detail pane behavior.

### UI: Removed "Details" heading from detail pane

- Removed the `<h2>Details</h2>` heading from the `.editor-header` in the detail pane.

### UI: Vican title click opens in popup browser

- For vican (AliExpress) products, clicking the product title link now opens the source URL in the same named popup browser window (`ecomint-brower`, 1200×800) used by the Browse/Open buttons, instead of opening a new browser tab.
- Cellar products unchanged — their title links still open in a new tab via `target="_blank"`.

### UI: Always-on-top popup browser for product source

- Added `alwaysOnTop=yes` to the `window.open()` feature string for the popup browser window on all product source links (title click, Browse, and Open buttons) so the source page stays on top of other windows.

## 2026-09-02 — VIC-10

### JIRA VIC-10 — Data Refresh and load options

- Added a **Load workbook** button to the workspace toolbar that opens a file picker and imports an `.xlsx` workbook directly from the workspace view. Previously, the only way to import a new or updated workbook was to click **Reset page** (which clears the visible draft without touching SQLite), return to the landing page upload zone, and then upload. Now admins can load additional products or refresh existing products in the SQLite DB without resetting the page.
- The Load workbook button calls the existing `handleImport()` flow, which sends the file to `POST /api/imports`. The server's `mergeWorkbook()` merges the incoming rows by normalized column-B key into the current SQLite draft, preserving all app-owned fields (Shopify inventory, manually edited sale prices, descriptions, selection state, enrichment state, and Shopify publish/history state).
- The button is disabled during Save, Publish, and busy states to prevent concurrent operations.
- No changes to the server startup/restore behavior — `GET /api/drafts/current` already loads the saved catalog on application startup and after any server restart, confirming the first part of VIC-10 was already working: the app checks the SQLite DB for existing records and displays them in the UI.
- Updated `docs/ARCHITECTURE.md` §3 (client responsibilities) and §5 (startup state machine) to document the Load workbook toolbar action.
- Updated `docs/SUPPORT.md` §7 (workbook import and merge) and §14 (troubleshooting) to describe the Load workbook button and its merge behavior.

## 2026-09-01 — VIC-11, VIC-12

### JIRA VIC-11 — Supplier Type column (Excel column K)

- Added `supplierType` field parsed from Excel column K (index 10, values "Direct from Supplier" / "New").
- `supplierType` is supplier-owned: stored as `supplier_type` in the SQLite `products` table, refreshed on workbook merge, preserved across enrichments, and never sent to Shopify.
- Added a backward-compatible migration (`ALTER TABLE ADD COLUMN supplier_type TEXT NOT NULL DEFAULT ''`).
- Added `supplier_type` to the fingerprint used for duplicate-row detection.
- Added the Type column to the XLSX export.
- Added a "Type" select filter in the client column filter bar.
- Updated `docs/ARCHITECTURE.md` §4 (supplier-owned fields) and §6 (filter field reference).

### JIRA VIC-12 — Range and wildcard text column filters

- Refactored the client filter state to support three filter kinds: `select` (checkbox dropdown, unchanged), `range` (operator + numeric input), and `text` (wildcard pattern).
- Added range filters for Unit price, Sale price, Case price, Stock, and Shopify inventory with operators `>`, `<`, `>=`, `<=`, `=`, `≠`.
- Added a wildcard text filter for Product Description with `*` (any characters) and `?` (single character) support.
- Added `RangeFilter` and `TextFilter` components, `compareRange()` and `matchesTextPattern()` helpers, and `numericFilterValue()` for extracting numeric values from products.
- Added `.range-popover` and `.text-popover` CSS styles in `workspace.css`.
- Updated `docs/ARCHITECTURE.md` §6 and `docs/SUPPORT.md` §7, §14.

## 2026-09-01 — VIC-9

### JIRA VIC-9 — Configured collection assignment and env quote handling

- Added `SHOPIFY_COLLECTION_ID` to the server configuration, parsed into a `shopifyCollections` array of `{ name, id }` objects exposed via `GET /api/ready` → `collections`.
- The editor panel now shows a **Collections** multiselect populated from the readiness endpoint, allowing the operator to assign one or more predefined Shopify custom collections to all checked products at publish time.
- The publish endpoint accepts `globalCollectionIds` and passes them to `publishProduct`, which calls `collectionAddProducts` for each collection. Collection-management failures are caught and reported in publish errors without failing the product publish itself.
- Fixed `parseShopifyCollections` in `config.ts` to strip surrounding quotes from parsed collection names and IDs. Without this, `.env` values like `SHOPIFY_COLLECTION_ID="Spirits:314155073588,..."` included the quote characters in the parsed values, causing collection ID lookups to fail.
- The default app-load restore from SQLite and the workbook merge-without-purge behavior were confirmed already implemented and working: `GET /api/drafts/current` reads the current catalog from SQLite on startup, and `POST /api/imports` merges new or updated rows by normalized column-B key while preserving app-owned fields.

## 2026-08-30 — VIC-8

### JIRA VIC-8 — Published Product Sales Channel check box

- Added a second checkbox in the product detail editor, **Online Store**, next to the existing **Featured** checkbox. It controls whether a published product appears on the Online Store sales channel in Shopify.
- The `publishToOnlineStore` flag is app-owned: stored as `publish_to_online_store` in the `products` table (with a backward-compatible migration defaulting to `1`), preserved across workbook merges, and staged in the client dirty-field map before Save.
- The publisher now resolves the Online Store publication ID once per server session via `publications(first: 25)` and caches it. On publish it calls `publishablePublish` when checked or `publishableUnpublish` when unchecked, accumulating any channel errors alongside featured-collection errors without changing the product's `published` status.
- Added the `ONLINE_STORE_PUBLICATION_NAME` constant, the `onlineStorePublicationIdCache`, `resolveOnlineStorePublicationId`, `publishToOnlineStore`, and `unpublishFromOnlineStore` functions, plus `PublicationLookup` and `PublicationMutationResponse` interfaces in `productPublisher.ts`.
- Added the `read_publications` and `write_publications` Shopify scopes to `.env.example`, `docs/SUPPORT.md`, and `docs/ARCHITECTURE.md`.
- Added the Online Store column to the XLSX export with Yes/No values.
- Updated `docs/ARCHITECTURE.md` §9 with the Online Store sales channel flow, `docs/SUPPORT.md` §3 and §9 with scope and behavior notes, and `docs/SUPPORT.md` §14 with a troubleshooting entry.

## 2026-08-30 — VIC-4, VIC-6, VIC-7

### JIRA VIC-6 — Add version id on UI

- Added `APP_VERSION` configuration (defaults to `0.1.0`, overridable via `.env`/Docker).
- The `/api/health` and `/api/ready` endpoints now return the application version.
- The version is displayed as a tag in the brand bar on both the landing and workspace views.

### JIRA VIC-7 — Clear checked items

- Added a **Clear all checked** button to the toolbar that deselects every checked row across the full catalog, not just visible rows.
- A count of currently checked items is shown on the button. No other filters or edit state are affected.

### JIRA VIC-4 — Read only field updates

- Reorganized the product detail editor into two labeled groups: **Supplier Data** (read-only) and **App Data** (editable).
- Product Title, Unit Price, Case Price, and Supplier Stock on Hand are now read-only with a light gray background to indicate they cannot be edited.
- Suggested Sale Price and Shopify Inventory remain grouped as editable fields.

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
