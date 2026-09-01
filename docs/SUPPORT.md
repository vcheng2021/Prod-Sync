# eComInt Support Runbook

## 1. Scope

This runbook is for operators and maintainers of the local eComInt product workspace. It covers local development and the supported single-instance Docker deployment.

The application stores product data locally in SQLite. A database purge deletes local catalog state but does not delete Shopify products.

> Last updated: 2026-08-30. The runbook covers the current API, issue-log, inventory, reset, version display, and checked-row clearing behavior.

## 2. Prerequisites

Local development requires:

- Node.js 20 or later;
- npm;
- the repository checkout;
- a writable workspace for `data`, `logs`, and `productimage`;
- Shopify Admin credentials only when publishing;
- a Shopify inventory location ID when inventory publishing is enabled.

Docker deployment requires:

- Docker Engine with Compose support;
- persistent storage for the data, logs, and product-image volumes;
- network access to the supplier source and Shopify Admin API when those operations are used.

## 3. Configuration

Copy `.env.example` to `.env` for local use and fill in values that apply. Never commit `.env` or paste the Shopify token into a ticket.

Required for Shopify publishing:

```text
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=<server-only token>
SHOPIFY_API_VERSION=2026-07
SHOPIFY_LOCATION_ID=gid://shopify/Location/...
```

Optional for featured-collection publishing:

```text
SHOPIFY_FEATURED_COLLECTION_ID=gid://shopify/Collection/...
```

When `SHOPIFY_FEATURED_COLLECTION_ID` is provided, products flagged as **Featured** in the editor are added to that collection on publish. When omitted, the publisher searches for a custom collection with handle `featured-collection` and creates one named "Featured Collection" if it does not exist.

`SHOPIFY_COLLECTION_ID` (optional) is a comma-separated list of `Name:ID` pairs for predefined Shopify custom collections, e.g. `SHOPIFY_COLLECTION_ID="Spirits:314155073588,Red Wine:285318578228"`. The parsed list is shown as a **Collections** multiselect in the editor panel and assigned to all checked products at publish time via `collectionAddProducts`. Surrounding quotes on names and IDs are stripped automatically; no additional Shopify scopes are required beyond `read_products` and `write_products`.

The Shopify app/token must have `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_publications`, and `write_publications` access as required by the selected Admin API operations. The installing user must also have permission to update inventory items and activate inventory at the configured location. API version `2026-07` requires an `@idempotent` key on inventory activation and quantity mutations; the application adds those keys automatically. If scopes were added after the token was created, reauthorize or reinstall the app so the token receives the new scopes. Confirm the location ID is the main store location where quantities should be set.

Useful local paths:

- `data/ecomint.db`: SQLite catalog;
- `logs/ecomint.log`: physical application event log;
- `.ecomint/logs`: local process stdout/stderr logs from `start.ps1`;
- `productimage`: downloaded product images;
- `suppliers/sup2_paramountliquor.xlsx`: first-run seed workbook.

## 4. Local start and stop

Install dependencies and run the typechecks/build:

```powershell
npm install
npm install --prefix client
npm run typecheck
npm run build
```

For development on Windows:

```powershell
./start.ps1
```

Open `http://127.0.0.1:<VITE_DEV_PORT>` (default 5173). The API health endpoint is `http://127.0.0.1:<PORT>/api/health` (default 8787). Both ports are configurable via `.env`.

Stop the local processes with:

```powershell
./stop.ps1
```

The root server can also run the compiled build with `npm start` after `npm run build`.

## 5. Docker install and operation

Build the image:

```powershell
docker build -t ecomint:latest .
```

Create a local runtime environment file outside source control. Compose reads variables from `.env`; at minimum set `SHOPIFY_ADMIN_ACCESS_TOKEN` and `SHOPIFY_LOCATION_ID` before publishing.

Start the application:

```powershell
docker compose up -d --build
```

Open `http://localhost:<HOST_PORT>` (default 8787, configurable via `.env`) and check health:

```powershell
Invoke-WebRequest http://localhost:$env:HOST_PORT/api/health

docker compose ps
```

View runtime logs:

```powershell
docker compose logs -f ecomint
```

Stop without deleting persistent volumes:

```powershell
docker compose down
```

Do not use `docker compose down -v` unless the data, logs, and images have been intentionally backed up and destroyed.

## 6. First run and restart behavior

On the first run with a new data volume, the server creates the SQLite schema and imports `suppliers/sup2_paramountliquor.xlsx` once. Source pages and images are not fetched during this seed.

On restart, the server loads the catalog from SQLite. It does not import the seed workbook again. SQLite WAL files remain beside the database in `/app/data`.

If the catalog has been purged, the seed marker remains set. Restarting will leave the catalog empty. Select a workbook explicitly to begin again.

## 7. Workbook import and merge

Select an `.xlsx` workbook in the application. The first worksheet is parsed. Column B is the stable supplier product key and is preserved as text to retain leading zeroes.

For a matching normalized column-B key:

- supplier title, URLs, SOH, case price, unit price, row number, and raw row data are refreshed;
- Shopify inventory is preserved;
- manually changed suggested sale price is preserved;
- a still-automatic suggested sale price follows a changed unit price.

For a new key, a new catalog row is inserted. Suggested sale price starts at unit price plus 25 percent. Shopify inventory starts at 1 when supplier SOH is greater than 2, otherwise 0.

Missing or conflicting duplicate column-B keys are reported as row-level import errors. Exact duplicate supplier rows are retained once and reported as skipped duplicates. Products absent from the new workbook are retained.

The import response reports added, updated, unchanged, and invalid rows. Review warnings before publishing.

## 8. Editing and Save

Edits are staged in the browser. The database is not updated for ordinary field changes until the top Save button is pressed.

The Save operation sends only fields changed since the last load/save. A successful save clears the dirty indicator. A failed save leaves edits staged so the operator can retry. Source retrieval results and publish outcomes are written immediately because they are server operations.

The publish review uses the browser's current values. If the operator posts before pressing Save, the publish request includes every staged field change for the relevant products. The server applies those changes in a SQLite transaction before it reads the selected products, so manually edited title, prices, inventory, description, and About fields are the values sent to Shopify. Retrieval responses are merged with still-unsaved browser edits instead of replacing them.

Suggested sale price is the Shopify variant retail price. Local unit price is written to the Shopify inventory item's `cost` field, shown in the admin as Cost per item. Shopify's variant `unitPrice` is calculated from measurement settings and is not a direct input value. Shopify inventory is separate from supplier SOH and is the absolute quantity sent to the configured Shopify location.

Do not start a new import or close the browser with important unsaved changes.

The toolbar provides **Select visible** (checks all filtered rows), **Clear visible** (unchecks visible rows), and **Clear all checked** (deselects every checked row across the entire catalog, regardless of active filters). Clearing selections does not affect staged edits, filters, or any other state.

In the product detail editor, supplier-owned fields — Product Title, Unit Price, Case Price, and Supplier Stock on Hand — are displayed as read-only with a light gray background. Only Suggested Sale Price and Shopify Inventory are editable in the editor.

**Reset page** clears the visible draft, filters, selections, messages, modal state, issue records, and unsaved browser edits. It does not delete SQLite data. A later browser reload restores the persisted catalog. Use **Purge database** when the local catalog itself must be removed.

## 9. Source retrieval and publishing

Checking a row does not contact the supplier. Pressing Retrieve source data on a checked row fetches the permitted supplier page and image, then stores the result. Failed retrievals show a retry action.

Publishing requires selected and valid rows plus final confirmation. The review displays the suggested sale price and Shopify inventory that will be sent. Product titles are matched case-insensitively:

- zero matches: create;
- one match: update;
- multiple matches: skip and require manual resolution.

In addition to price, cost, and inventory, the publisher maps the app `brand` to the Shopify product `vendor`, the app `productType` to the Shopify `productType`, and derives Shopify `tags` from a non-empty subset of the `brand`, `productType`, and `country` fields. These are standard `Product` attributes covered by the existing `write_products` scope; no additional Shopify permissions are required.

When the editor **Featured** checkbox is set, the publisher adds the product to a Shopify custom collection on publish, or removes it when unchecked on a subsequent publish. The collection is resolved from `SHOPIFY_FEATURED_COLLECTION_ID`, falling back to a handle-based lookup that auto-creates `featured-collection` if absent. Collection-management errors are reported in the posting issues but do not fail the product publish itself.

When the editor **Online Store** checkbox is set (default on), the publisher publishes the product to the Online Store sales channel via `publishablePublish` on publish, or removes it from that publication via `publishableUnpublish` when unchecked on a subsequent publish. The Online Store publication ID is resolved once per server session by querying `publications(first: 25)` and matching the name to "Online Store". Publication-management errors are reported in the posting issues but do not fail the product publish itself. The `read_publications` and `write_publications` scopes are required for these mutations.

The **Collections** multiselect in the editor panel mirrors the configured `SHOPIFY_COLLECTION_ID` entries. Selecting one or more collections and publishing adds the checked products to those collections via `collectionAddProducts`. Collection errors are reported in the posting issues but do not fail the product publish itself.

A Shopify failure is retained on the product and in publish history. The **Posting issues** metric reads the newest failure records for the current draft from `GET /api/issues?draftId=<id>`, backed by `logs/ecomint.log`. Each record includes the event, timestamp, product ID when available, Shopify error text, GraphQL error code, and mutation field path. Product-linked records can be opened from the issue list to return to the product editor. Correct the row and retry. A failed local publish does not justify deleting a product from Shopify.

Inventory publication first updates the inventory item's Cost per item from local unit price, activates the variant inventory item at the configured location when needed, then sends the editable Shopify inventory as an absolute available quantity. Activation and quantity mutations use unique idempotency keys. The token still needs `write_inventory`, and the installing user needs inventory-item and location permission.

## 10. Purge database

Purge is a destructive local action. It removes:

- catalog products and draft metadata;
- source cache;
- publish history;
- application-owned downloaded product images.

It retains the SQLite schema, initialization marker, and `logs/ecomint.log`. It does not delete Shopify products.

Use the top Purge database button, read the warning, and type `PURGE`. After success, import a workbook explicitly. Never use purge as a routine way to refresh a workbook.

## 11. Health and logs

The health endpoint confirms that Express is responding and returns the application version:

```text
GET /api/health
```

The `/api/ready` endpoint returns the version alongside Shopify readiness status (`ok`, `shopifyConfigured`, `storeDomain`, `missing`). The version is also displayed in the brand bar in the upper-right corner of the workspace.

The physical event log is JSON Lines at `logs/ecomint.log` locally or `/app/logs/ecomint.log` in Docker. It records startup, seed/restore, imports, merges, Saves, retrieval, publishing, purge, validation, and failures.

Use `GET /api/issues?draftId=<id>` or click the Posting issues metric in the workspace to read up to 100 newest failure entries for the current draft. The endpoint reads the log in reverse chronological order and returns structured details without raw request bodies or Shopify credentials.

The logger redacts keys that look like tokens, secrets, passwords, authorization values, credentials, or cookies. Still treat logs as operational data. Do not add raw request bodies or Shopify responses to support tickets.

For local process failures inspect `.ecomint/logs/server.out.log` and `.ecomint/logs/server.err.log`.

## 12. Backup and restore

For Docker, stop the application or otherwise ensure no write is in progress before copying volumes. Back up all three state areas together:

- the SQLite database directory, including `.db`, `-wal`, and `-shm` files;
- the log volume;
- the product-image volume.

A simple named-volume inspection sequence is:

```powershell
docker volume ls
docker volume inspect ecomint-data
docker volume inspect ecomint-logs
docker volume inspect ecomint-images
```

For a consistent SQLite backup, prefer SQLite's backup API or a stopped container. Do not copy only `ecomint.db` while it is actively using WAL mode.

Restore by stopping the container, restoring the three data areas to their corresponding volumes or bind mounts, and starting the same application version first. Review `logs/ecomint.log` after startup. Test `/api/health` and load the catalog before changing the image version.

## 13. Upgrade procedure

1. Back up data, logs, and product images.
2. Read the release notes and architecture changes.
3. Build the new image with a new tag.
4. Stop or replace the single running container using the same persistent volumes.
5. Start the new image and watch startup logs.
6. Confirm health, catalog row count, representative product fields, and image access.
7. Run a non-Shopify test Save before publishing.

Schema changes are applied when `DraftStore` starts. Do not run two application versions against the same SQLite volume simultaneously.

## 14. Troubleshooting

### The page is blank or does not load

Check `docker compose ps` and `/api/health`. Inspect container logs. For local development, confirm the client is on `VITE_DEV_PORT` (default 5173) and the server is on `PORT` (default 8787). Rebuild if `client/dist` or `server/dist` is stale.

### The catalog is empty after restart

Confirm the data volume is still mounted and inspect the configured `DATABASE_PATH`. Check the physical log for startup or migration failures. If the database was purged, this is expected; explicitly import a workbook.

### The initial workbook is not imported

Confirm the workbook exists at `suppliers/sup2_paramountliquor.xlsx` locally or `/app/suppliers/sup2_paramountliquor.xlsx` in Docker. Check the log for missing column-B keys, duplicate keys, invalid rows, or a previously completed initialization marker.

### An upload updates the wrong product

Check column B values, including leading zeroes and whitespace. The merge key is normalized trimmed text, not the title. Correct duplicate or missing keys and re-import.

### Save fails

Keep the page open so staged edits are not lost. Check the API response and `product.save` failure event. Confirm the database volume is writable and that only supported editable fields are being submitted. Retry after the underlying error is resolved.

### Posting issue details are missing

Click the **Posting issues** metric. It loads failure records from `logs/ecomint.log` through `/api/issues?draftId=<id>`. If the list is empty, confirm that the selected draft ID matches the log entry and inspect the unfiltered log locally with `Get-Content logs/ecomint.log -Tail 100`. The product editor also shows the persisted `publishError` for the active row.

### Source retrieval fails

Confirm the URL is HTTPS and its host is allowed by `SOURCE_URL_ALLOWLIST`. Check timeout, redirect, response-size, and content-type restrictions. Retry only for a checked row. Do not manually add supplier secrets to the browser.

### Shopify publishing fails

Confirm `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_STORE_DOMAIN`, API version, and `SHOPIFY_LOCATION_ID` are set in the container runtime environment. Confirm the token scopes and location. Inspect the saved publish error and redacted log event. Multiple title matches require manual resolution.

### Featured product is not in the collection

Confirm `SHOPIFY_FEATURED_COLLECTION_ID` is set if you want to target a specific collection. When unset, the publisher auto-creates or searches for a collection with handle `featured-collection`. Check the posting issues for a collection-management error on the affected product. The product itself publishes normally even if collection linking fails; retry after correcting the collection ID or Shopify scopes.

### Product is not published to the Online Store sales channel

Confirm the editor **Online Store** checkbox is checked and that the `read_publications` and `write_publications` Shopify scopes are granted on the token. For "Could not find the Online Store sales channel publication," confirm the Online Store sales channel exists on the store (the publisher searches the first 25 publications for one named "Online Store"). Publication errors are reported in the posting issues without failing the product publish itself; retry after correcting the scopes or channel.

### Inventory does not update

Confirm the editable Shopify inventory is a whole number at least zero and that the configured location ID belongs to the target store. The value sent is Shopify inventory, not supplier SOH. Local unit price is sent separately through `inventoryItemUpdate` as Shopify Cost per item. For `Access denied for inventoryActivate` or `Access denied for inventoryItemUpdate`, grant the app/token `write_inventory`, reauthorize the installation, and confirm the user can manage inventory at that location. For `The @idempotent directive is required`, rebuild/restart the server so the current publisher is running; API version `2026-07` requires the directive and the current implementation supplies a unique key. Check the issue log for the exact cost, activation, or quantity mutation error.

### Reset page did not delete the catalog

This is expected. Reset page is a non-destructive client reset that returns to the import screen while leaving SQLite, logs, and images intact. A startup or browser reload restores the saved catalog. Use Purge database and type `PURGE` only when local catalog state must be deleted.

### Images are missing

Confirm `/app/productimage` is mounted and writable, and that the image volume was not replaced. Check the product's image status and retrieval error. Re-run retrieval for a selected row.

### Container becomes unhealthy

Run `docker compose logs ecomint`, call `/api/health` from inside the container if needed, and inspect disk space and volume permissions. A health failure means the HTTP process is unavailable; Shopify configuration is not required for the health endpoint.

## 15. Safe escalation information

Include:

- application image tag or commit ID;
- operating system and Docker version;
- timestamp and operation type;
- API health result;
- relevant redacted log lines;
- whether the issue reproduces after restart;
- whether a backup exists.

Do not include Shopify tokens, cookies, authorization headers, raw supplier credentials, or unredacted request bodies.

## 16. Known limitations

- SQLite supports one active application instance for this deployment.
- There is no multi-user conflict resolution.
- There is no automatic recurring supplier synchronization.
- Products absent from a later workbook are not deleted.
- Purge affects local state only and does not delete Shopify products.
- Inventory is written to one configured Shopify location.
- The default workbook is imported only on first initialization, not on every restart.
