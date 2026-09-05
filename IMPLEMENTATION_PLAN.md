# eComInt Implementation Plan

> Status: Core import, editing, retrieval, issue reporting, and Shopify publishing workflows are implemented.
> Last updated: 2026-08-28.

## Goal

Build a local internal web app for importing supplier products, reviewing and editing them, selecting products with checkboxes, and publishing only confirmed products to the Shopify store `cb1710-2.myshopify.com`.

The app will use the workbook at `suppliers/sup2_paramountliquor.xlsx` as its initial supplier source.

## Current implementation notes

- Ordinary product edits are staged in the React client by product ID. Save sends only changed allowlisted fields to SQLite.
- The application version is configured via `APP_VERSION` and displayed in the brand bar; it is also returned by `/api/health` and `/api/ready`.
- The toolbar includes a **Clear all checked** button that deselects all checked rows across the full catalog regardless of active filters.
- The `featured` flag is an app-owned boolean toggle in the editor panel. It is staged in the dirty-field map alongside other edits and sent to Shopify as collection membership (custom collection + collect) during publish.
- Publishing accepts the staged field changes with the selected IDs and persists them before loading the products for Shopify. This keeps manually edited title, price, inventory, description, and About fields from reverting to their originally imported values.
- Source retrieval merges its response with pending client edits so enrichment cannot overwrite an unsaved manual change.
- The Posting issues metric reads the newest current-draft failure entries from `logs/ecomint.log` through `GET /api/issues?draftId=<id>` and displays structured error details.
- Reset page clears the visible client workspace and transient status without deleting SQLite, log, or image data. Purge database remains the explicit destructive reset.
- The publisher sends suggested sale price to the Shopify variant `price` and local unit price to the inventory item's `cost` field, shown as Cost per item. Shopify's variant `unitPrice` remains a calculated measurement-based value.
- A product can be flagged as **featured** via a checkbox in the editor panel. When published, the product is added to a Shopify custom collection (resolved from `SHOPIFY_FEATURED_COLLECTION_ID` or auto-created with handle `featured-collection`). The `featured` flag is app-owned and preserved across workbook merges.
- Shopify API version `2026-07` requires unique `@idempotent` keys for inventory activation and quantity updates. The token must still have `write_inventory` and the installing user must have permission to manage the configured location.

## Spreadsheet Mapping

| Spreadsheet column | Meaning | Shopify/app behavior |
| --- | --- | --- |
| A | Image URL | Store the URL on import; download and save the image only when a checked row's `Retrieve source data` button is pressed |
| B | Supplier product key | Required stable identity; preserve as text and use a normalized value to merge workbook rows |
| E | Product title | Editable title; used to match existing Shopify products |
| F | Supplier product URL | Fetch source details and description server-side |
| G | Supplier stock on hand | Display and edit in the app; used only to initialize Shopify inventory for new products |
| I | Case price | Display and edit in the app; stored as supplier data and not used as the Shopify retail price |
| J | Unit price | Supplier cost; used to calculate the initial suggested sale price and update Shopify Cost per item |
| K | Supplier type | Supplier-owned classification such as "Direct from Supplier" or "New"; refreshed on merge, displayed as read-only, never sent to Shopify |

The product detail editor groups supplier fields (title, unit price, case price, supplier stock on hand, supplier type) as read-only and app-editable fields (suggested sale price, Shopify inventory) as editable. The UI also stores an editable suggested sale price and a separate Shopify inventory quantity. New rows start with a suggested sale price equal to unit price plus 25%, rounded to cents. Shopify inventory starts at 1 when supplier SOH is greater than 2, otherwise 0. Column B is required; missing or duplicate keys are row-level import errors.

The parser must preserve the original spreadsheet row number and raw row data. Missing keys and conflicting duplicate keys should be reported individually rather than silently discarded. Exact duplicate supplier rows may be skipped and reported in the import summary.

## Source URL Enrichment

For each valid HTTPS URL in column F, the server will retrieve and normalize the following only when the checked row's `Retrieve source data` button is pressed:

- Brand
- Country
- Region
- Product Type
- ABV %
- Container Type
- Style
- Product description

These values will appear in an editable `About this product` area. The same area will also show the retrieved column A image, its source URL, saved local filename, and retrieval status. The fetched description and labeled details will be included in the visible Shopify product description when published.

- Do not request column F source URLs during workbook import, when a row is unchecked, or when a row is merely checked.
- A checked row exposes a `Retrieve source data` button. Pressing it starts the source-page fetch and image download for that row; unchecking does not start retrieval.
- Fetch only from approved supplier hosts or an explicit configured allowlist.
- For supplier URLs shaped like `/products/{identifier}`, use the configured same-origin catalog endpoint to map the identifier to product fields, use the configured product-description endpoint for About text when available, then fall back to the same-origin GraphQL endpoint and HTML extractor.
- Block malformed URLs, non-HTTPS URLs, private IP ranges, localhost, metadata endpoints, and unsafe redirects.
- Apply connection and total request timeouts, redirect limits, content-type checks, and response-size limits.
- Sanitize fetched HTML before storing, displaying, or sending it to Shopify.
- Cache successful results with source URL and fetch timestamp, but do not let cached data trigger a new network request for an unchecked row.
- Show loading, successful, failed, blocked, and stale states in the UI.
- Maintain a physical JSON Lines log capturing all events and actions, successful and failed. Store it in the `logs` directory and expose only filtered failure records through the issues API.
- The `Retrieve source data` button becomes `Retry source data` after a failure and can be pressed again only for a checked row.
- Never overwrite a user edit during refresh without explicit confirmation.
- Do not invent missing product facts; missing fields remain editable and visibly unresolved.
- Do not request column A image URLs during workbook import, when a row is unchecked, or when a row is merely checked. Pressing `Retrieve source data` on a checked row downloads the image into `productimage` and persists its status.
- Image downloads use the configured concurrency and timeout limits and expose visible loading/failed states. One slow image source is isolated to its product request.

## Application Workflow

1. Upload the `.xlsx` supplier workbook.
2. Parse the first worksheet and show import totals and row-level errors.
3. Keep column A and F URLs as references during import; checking a row only marks it for publishing, while its `Retrieve source data` button explicitly retrieves and populates the image and source details.
4. Display products in a searchable, filterable editable table.
5. Show per-row selection checkboxes, select-all, clear-selection, and validation states. Place a `Retrieve source data` button next to each row; disable it until that row is checked.
6. Provide a filtering dropdown for every visible column. Each dropdown supports searching and multi-selecting unique values, and active filters combine across columns.
7. Provide title sorting with ascending and descending options while preserving checkbox selections and edits.
8. Restore the current catalog from SQLite on app startup. Keep ordinary UI edits staged in the browser and persist only changed fields when the top-level Save button is pressed.
9. Allow loading a new or updated workbook from the workspace toolbar via the Load workbook button, merging new and existing rows into the current SQLite draft while preserving app-owned fields.
10. Show a publish review containing selected rows, changed fields, validation warnings, and Shopify create/update decisions.
11. Require a final checkbox confirmation before posting.
12. Publish only checked and valid rows to Shopify, persisting any staged changes before the server reads the selected products.
13. Show per-row pending, success, failed, skipped, and retry states.
14. Persist a publish history with timestamps, source rows, Shopify IDs, outcomes, and error details. Surface physical log failures from the Posting issues metric.
15. Provide a guarded Purge database action that clears local catalog content, cached source data, publish history, and application-owned downloaded images while retaining the SQLite schema and physical log.
16. Provide a non-destructive Reset page action that clears the client screen, filters, selections, messages, modal state, and unsaved edits.
17. Package the app as a single-instance production Docker image with persistent database, log, and image storage.

## Shopify Integration

Use a server-side Shopify Admin GraphQL client. The Shopify Admin token must never be sent to the browser, included in frontend assets, or written to logs.

All configurable values will come from the project-root `.env` file at `C:\ProjectsVC\AI_Proj\eComInt\.env`, loaded server-side with `dotenv`. The committed `.env.example` documents the keys and safe defaults but contains no credentials. The real root `.env` is ignored by Git and must never be sent to the browser or committed.

Configuration keys include:

- `SHOPIFY_STORE_DOMAIN=cb1710-2.myshopify.com`
- `SHOPIFY_ADMIN_ACCESS_TOKEN=<server-only token>`
- `SHOPIFY_API_VERSION=2026-07`
- `SOURCE_URL_ALLOWLIST=<approved supplier hosts>`
- `APP_VERSION`, `PORT`, `DATABASE_PATH`, `PRODUCT_IMAGE_DIRECTORY`, and `MAX_IMPORT_ROWS`
- `LOG_DIRECTORY`, `SHOPIFY_LOCATION_ID`, and `SHOPIFY_FEATURED_COLLECTION_ID` (optional — targets a specific custom collection for featured products)
- Source and image timeout, redirect, response-size, byte-limit, and concurrency settings

The server must fail clearly for Shopify publishing when `SHOPIFY_ADMIN_ACCESS_TOKEN` is missing, while still allowing spreadsheet import and local editing without credentials. No Shopify URL, token, credential, timeout, file path, row limit, or source allowlist may be hardcoded in frontend code.

Required initial Shopify scopes:

- `read_products`
- `write_products`
- `read_inventory`
- `write_inventory`

The app installation must be reauthorized after scope changes. The installing user also needs permission to update inventory items and activate inventory at the configured location. For API version `2026-07`, inventory activation and quantity mutations must include a unique `@idempotent(key: ...)` directive.

Shopify behavior:

- Normalize titles by trimming whitespace and comparing case-insensitively.
- If exactly one existing product matches, prepare an update.
- If no product matches, prepare a create.
- If multiple products match, require manual resolution and skip automatic publishing for that row.
- Use the editable suggested sale price as the main product variant price; keep column J unit price as supplier cost and write it to the inventory item's Shopify `cost` field.
- Map the app `brand` field to the Shopify product `vendor`.
- Map the app `productType` field to the Shopify product `productType`.
- Set the Shopify product `tags` to a non-empty subset of `[brand, productType, country]`, trimmed and filtered for missing values.
- Retrieve the variant inventory item, update its `cost`, activate it at `SHOPIFY_LOCATION_ID` when needed, and set its absolute inventory quantity from the editable Shopify inventory field. Include unique idempotency keys in the activation and quantity mutations.
- Include the edited About this product content in `descriptionHtml`.
- Import the downloaded column A image only for checked rows whose `Retrieve source data` action completed successfully. Never request or download images for unchecked or merely checked rows.
- Keep supplier column G separate from the editable Shopify inventory field.
- Keep column I case price as supplier data and do not use it as the Shopify retail price.
- Never delete products automatically.
- Publish selected products only after final review and confirmation.
- Check GraphQL transport errors and `userErrors` for every mutation, including successful HTTP responses. Preserve error codes and field paths in the issue log when Shopify supplies them.
- When a product's `featured` flag is set, add it to the configured or auto-created Featured Collection via `collectCreate`; remove it via `collectDelete` when the flag is cleared. Collection-management failures are reported but do not prevent the product publish.

## Implemented Technical Structure

The application is implemented as a Node.js and TypeScript project with:

- React frontend for the upload, product workspace, About this product editor, publish review, issue log, and Reset page.
- Node.js server API for file parsing, source-page fetching, sanitization, drafts, and Shopify calls.
- SQLite for local drafts, enrichment cache, publish status, and audit history.
- XLSX parser for workbook input.
- HTML parser and sanitizer for supplier pages.
- Server-only environment configuration for Shopify credentials, store URL, API version, URL policy, file paths, limits, timeouts, and concurrency.
- Redacted append-only physical event logger writing to `logs/ecomint.log`.
- Log reader and `GET /api/issues` endpoint for reverse-chronological failure inspection without exposing raw request bodies or credentials.
- Multi-stage Docker image and Compose deployment with persistent `/app/data`, `/app/logs`, and `/app/productimage` volumes.
- Detailed `docs/ARCHITECTURE.md`, `docs/SUPPORT.md`, `CHANGELOG.md`, and root/client README documentation.

Suggested server areas:

- `server/src/config.ts`
- `server/src/imports/xlsxParser.ts`
- `server/src/enrichment/sourcePageFetcher.ts`
- `server/src/enrichment/productDetailsExtractor.ts`
- `server/src/enrichment/htmlSanitizer.ts`
- `server/src/shopify/adminGraphqlClient.ts`
- `server/src/shopify/productPublisher.ts`
- `server/src/drafts/draftStore.ts`
- `server/src/routes/imports.ts`
- `server/src/routes/publishing.ts`
- `server/src/logging/logger.ts`
- `Dockerfile`, `docker-compose.yml`, and `.dockerignore`
- `docs/ARCHITECTURE.md`, `docs/SUPPORT.md`, and `README.md`

Implemented frontend areas:

- `client/src/App.tsx`
- `client/src/api.ts`
- `client/src/App.css`
- `client/src/workspace.css`

## Validation and Safety

Before publishing a row:

- Title must be present.
- Unit price must be numeric and greater than zero, and suggested sale price must be numeric and greater than zero before publishing.
- Column B supplier product key must be present; conflicting duplicate keys are invalid and exact duplicate rows are reported as skipped.
- Shopify inventory must be a non-negative whole number.
- Duplicate titles inside the current import are allowed; Shopify matches remain subject to the existing multiple-match review rule.
- Ambiguous Shopify title matches must be resolved manually.
- Image failures must be visible after a checked row's `Retrieve source data` action and provide a retry state. Unchecked or merely checked rows must not have a downloaded image or an image retrieval job.
- Source-page fetch failures must be visible after a checked row's `Retrieve source data` action and provide a retry state. Unchecked or merely checked rows must not have a source-page fetch job.
- Source-page fetches that return only a site shell or no product-specific fields must be marked failed with the source error; no fabricated details should be published.
- HTML must be sanitized server-side.

For failed publishing:

- Keep the row in the draft.
- Store the Shopify error and source row.
- Allow correction and retry without re-importing the workbook.
- Show the saved `publishError` in the product editor and the physical log issue view.
- Do not retry indefinitely or duplicate products after a successful create.

## Testing and Verification

1. Verify workbook sheet names, dimensions, headers, and sample rows.
2. Assert A/E/F/G/I/J map to image URL/title/source URL/stock/case price/unit price, and assert import plus checkbox selection make zero image or source-page requests.
3. Test malformed URLs, disallowed hosts, private IPs, redirects, timeouts, oversized responses, and invalid content types.
4. Test extraction of all seven requested source-page fields and the description.
5. Test HTML sanitization against scripts, event handlers, iframes, unsafe links, and unsafe styles.
6. Test retrieval gating: import and checkbox selection make no remote requests; pressing `Retrieve source data` on one checked row makes one image download and one source-page fetch; unchecked rows cannot retrieve.
7. Test import, selection, editing, dirty-field persistence through the top Save button, publish-before-Save persistence, retrieval merge behavior, retry behavior, and preservation of manual edits.
8. Test every-column multi-select filtering, filter search, combined filters, empty results, and title ascending/descending sorting with selections preserved.
9. Test title matching for zero, one, and multiple Shopify matches.
10. Use an unpublished test product for an end-to-end Shopify create/update smoke test.
11. Confirm suggested sale price is published as the Shopify variant price, unit price is published as Shopify inventory-item cost, brand is published as the Shopify vendor, productType is published as the Shopify product type, tags are derived from a non-empty subset of brand, productType, and country, configured-location inventory is updated, the retrieved selected-row image is imported correctly, and supplier SOH G is not used as the Shopify quantity.
12. Test partial publish failures, retries, audit records, issue-log filtering, Reset page state clearing, and token non-exposure.
13. Run the production build and verify the workflow at desktop and mobile widths.
14. Build and validate the Docker image, verify the health check, and confirm database, logs, and product images survive container replacement.
15. Review and exercise `docs/ARCHITECTURE.md`, `docs/SUPPORT.md`, and `CHANGELOG.md`, including backup/restore, upgrade, troubleshooting, logging, reset, and purge procedures.

## Scope Boundaries for Version 1

- Single store only.
- Internal/local app only.
- Manual workbook upload, not an automatic file watcher.
- One Shopify inventory location per deployment, using the configured `SHOPIFY_LOCATION_ID`.
- Single-instance Docker deployment; no horizontal scaling against the same SQLite volume.
- No automatic deletion.
- No multi-store support.
- No public OAuth installation flow.
- No multi-user conflict resolution.
- No automatic recurring supplier synchronization.
- No case-price Shopify metafield unless added later.
- Purge clears local catalog content and application-owned images but does not delete Shopify products or physical logs.
