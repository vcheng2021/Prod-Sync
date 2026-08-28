# eComInt Technical Architecture

## 1. Purpose and operating model

eComInt is a single-instance internal product operations application. It imports supplier Excel workbooks, stores a persistent local catalog in SQLite, enriches selected products from supplier pages, lets an operator edit product content, and publishes confirmed products to one Shopify store.

The application is intentionally stateful. SQLite, the physical event log, and downloaded product images are application data and must be kept on persistent storage. The application is not designed for multiple server instances sharing one SQLite file.

## 2. System context

```text
Operator browser
    |
    | HTTP: React SPA and JSON API
    v
Express server
    |-- workbook parser (XLSX)
    |-- current catalog and merge store (SQLite)
    |-- source fetcher and sanitizer
    |-- image downloader
    |-- Shopify Admin GraphQL client
    |-- redacted physical logger
    |
    |-- /app/data/ecomint.db and SQLite WAL files
    |-- /app/logs/ecomint.log
    |-- /app/productimage/*
    `-- /app/suppliers/sup2_paramountliquor.xlsx
```

The browser never receives the Shopify Admin token. All supplier network requests, Shopify requests, file writes, SQLite mutations, and validation decisions occur on the server.

## 3. Components

### Client

`client/src/App.tsx` owns the workspace interaction model:

- loads the current catalog when the application starts;
- displays searchable, filterable products;
- stages editable fields in a dirty-field map;
- submits only changed fields from the top Save button;
- starts explicit source/image retrieval for checked rows;
- shows publish review and confirmation;
- provides guarded database purge.

`client/src/api.ts` contains the JSON API contract. It must not contain credentials or server-only configuration.

### Server

`server/src/index.ts` creates configuration, the logger, and the SQLite store before registering routes. It performs one-time startup seed/restore handling and serves the built client from `client/dist`.

`server/src/routes/imports.ts` handles current-catalog loading, workbook upload and merge, bulk Save, purge, and source retrieval.

`server/src/routes/publishing.ts` handles export and confirmed publishing. Every product result is persisted before the response is returned.

`server/src/drafts/draftStore.ts` owns schema creation, migrations, transaction boundaries, catalog reads, workbook merge, field updates, enrichment cache, publish history, and purge.

`server/src/imports/xlsxParser.ts` maps the first worksheet to the application model. It preserves raw row data and the original worksheet row number.

`server/src/enrichment/` validates supplier URLs, fetches approved source data, sanitizes HTML, and downloads images only after an operator requests retrieval for a selected row.

`server/src/shopify/` owns Admin GraphQL calls, title matching, product create/update, variant price updates, and inventory quantity updates.

## 4. Product identity and field ownership

Spreadsheet column B is the stable supplier product key. It is stored as trimmed text so leading zeroes survive parsing. A normalized lower-case value is indexed for matching. Missing keys and conflicting duplicate keys in one incoming workbook are import errors and are not silently guessed. Exact duplicate rows are retained once and reported as skipped duplicates.

Supplier-owned fields are refreshed by a matching workbook:

- supplier product key;
- raw worksheet row and row number;
- image URL;
- title;
- supplier source URL;
- supplier stock on hand;
- case price;
- unit price.

Application-owned fields survive a matching workbook merge:

- Shopify inventory quantity;
- manually edited suggested sale price;
- description and manually edited enrichment fields;
- selection state;
- image/source retrieval state unless its source URL changed;
- Shopify IDs, publish status, and publish error history.

A new product gets a suggested sale price of `unit price * 1.25`, rounded to cents, when the unit price is valid. Its Shopify inventory defaults to `1` when supplier SOH is greater than `2`, otherwise `0`. Suggested sale price is the editable Shopify retail price. Unit price remains the supplier cost.

If an existing suggested sale price still equals the previous automatic 25 percent calculation, a changed unit price recalculates it. Once the operator edits the suggested price, it is treated as an override and later workbooks do not replace it.

## 5. Startup, seed, restore, and merge state machine

1. Open or create the configured SQLite database and apply schema migrations.
2. Create the log directory and append a startup record.
3. If the initialization marker is absent and the database has no products, parse the configured default workbook and insert it in a transaction.
4. Mark initialization complete after a successful seed, including a seed with row-level import warnings.
5. If the database already contains products, restore the current catalog and do not re-seed.
6. If the default workbook is missing, keep the application usable for explicit upload and log the condition.
7. On explicit workbook upload, parse and validate the workbook, then merge all valid keys into the current catalog in one SQLite transaction.

The default workbook is a first-run seed, not a recurring synchronization source. After a purge, the database remains initialized and the operator must explicitly select a workbook.

## 6. SQLite model

The store creates these tables:

- `drafts`: the single current catalog metadata and timestamps;
- `products`: supplier identity, supplier fields, user fields, enrichment state, Shopify state, validation errors, and raw row JSON;
- `source_cache`: sanitized source results keyed by URL and parser version;
- `publish_events`: append-only product publish outcomes;
- `app_state`: initialization metadata such as the completed seed marker.

SQLite uses WAL mode. The database file, `-wal`, and `-shm` files must remain in the same persistent directory. Workbook merges and bulk Saves are transactions. A failed transaction rolls back all changes in that operation.

A unique partial index on `(draft_id, supplier_product_key_normalized)` prevents two valid products in the same catalog from sharing a normalized column-B key. On startup, the migration recovers legacy column-B values from the stored raw row data for the active catalog, derives the new fields, removes exact duplicate rows, and leaves conflicting or unrecoverable rows unkeyed with a validation error rather than inventing an identity.

## 7. API contracts

### `GET /api/health`

Returns a lightweight health response and does not call Shopify. Docker uses this endpoint for its health check.

### `GET /api/drafts/current`

Returns the current `DraftResponse`, or `null` when the catalog is empty.

### `POST /api/imports`

Accepts an `.xlsx` multipart field named `workbook`. If the catalog is empty, it inserts the first catalog. Otherwise it merges by normalized column-B key. The response includes the current draft, worksheet metadata, row-level import errors, and added/updated/unchanged/invalid counts.

### `PATCH /api/drafts/:draftId/products`

Accepts:

```json
{
  "products": [
    { "id": "product-id", "changes": { "title": "New title", "inventoryQuantity": 3 } }
  ]
}
```

Only allowlisted editable fields are accepted. The server updates only supplied columns and returns canonical products plus the current draft. The request is transactional.

### `POST /api/drafts/:draftId/products/:productId/retrieve`

Requires the product to be selected. It fetches source details and downloads the image only for that requested row, then persists the results.

### `POST /api/drafts/:draftId/publish`

Requires `confirmed: true` and product IDs. It publishes only selected products, checks Shopify GraphQL errors and mutation `userErrors`, and writes per-product publish outcomes.

### `POST /api/database/purge`

Requires `{ "confirmation": "PURGE" }`. It deletes catalog products, drafts, source cache, and publish history in a transaction. It keeps the schema, initialization marker, and physical log. The server returns the cleanup count. Only image filenames already owned by products are eligible for removal, and path traversal is rejected.

## 8. Source retrieval flow

Import never requests supplier URLs or image URLs. Checking a row never requests them. A selected row's explicit Retrieve action performs the source fetch and image download with configured allowlists, redirect limits, timeouts, content-type checks, and response-size limits.

Successful source details are sanitized before SQLite storage, browser display, or Shopify publication. Cache hits avoid unnecessary network calls but do not create retrieval work for unchecked products. A changed source URL invalidates the prior enrichment state during merge.

## 9. Shopify flow

The publisher normalizes a title and queries Shopify. Exactly one title match updates the existing product, zero matches creates a product, and multiple matches skip automatic publication for manual resolution.

The suggested sale price is sent as the main variant price. The supplier unit price is not used as the retail price. The publisher retrieves the variant inventory item ID, activates it at `SHOPIFY_LOCATION_ID` when necessary, and sets the absolute available quantity from the editable Shopify inventory field.

Publishing requires a server token and a configured location. Product mutations, variant mutations, inventory activation, inventory quantity updates, and media mutations all check returned `userErrors`. A partial failure remains retryable and is recorded in `publish_events`.

## 10. Logging and redaction

The server appends structured JSON lines to `logs/ecomint.log` by default. Events include startup, seed, restore, merge, Save, retrieval, refresh, publish, purge, validation, and unexpected failures.

The logger redacts values whose keys contain token, secret, password, authorization, credential, or cookie. Request bodies and raw Shopify responses are not logged. Never add a token, cookie, full authorization header, or secret environment value to a log message.

The `logs` directory is runtime state and is excluded from Git and the Docker build context. It is mounted separately in Docker so purge does not erase operational history.

## 11. Docker architecture

The root `Dockerfile` has two stages:

1. Builder: installs root and client dependencies, copies source and the default workbook, and builds the Vite client and TypeScript server.
2. Runtime: installs only root production dependencies, copies `client/dist`, `server/dist`, and `suppliers`, and starts `node server/dist/index.js`.

The runtime container uses these persistent paths:

| Container path | Purpose | Required persistence |
| --- | --- | --- |
| `/app/data` | SQLite database and WAL files | Yes |
| `/app/logs` | physical audit log | Yes |
| `/app/productimage` | downloaded images | Yes |
| `/app/suppliers` | read-only seed workbook in image | No |

`docker-compose.yml` mounts named volumes for the three state paths, exposes port 8787, and checks `/api/health`. This is a single-instance deployment. Do not run two application containers against the same SQLite volume.

Secrets are runtime environment variables. The real `.env` file, database, logs, and images are excluded from the image.

## 12. Configuration

Important server variables are:

- `PORT`: HTTP port, default `8787`;
- `DATABASE_PATH`: SQLite path, default `./data/ecomint.db`;
- `PRODUCT_IMAGE_DIRECTORY`: image directory, default `./productimage`;
- `LOG_DIRECTORY`: log directory, default `./logs`;
- `SHOPIFY_STORE_DOMAIN`;
- `SHOPIFY_ADMIN_ACCESS_TOKEN`;
- `SHOPIFY_API_VERSION`;
- `SHOPIFY_LOCATION_ID`;
- source allowlist, timeout, redirect, response-size, image-size, and concurrency settings.

Use `.env.example` as the key reference. The real `.env` is never committed.

## 13. Security and support boundaries

This is an internal single-user application. It has no multi-user authorization or conflict resolution. Protect the host, Docker socket, SQLite volume, log volume, and browser access using the deployment environment.

The purge operation is destructive to local catalog state but does not delete Shopify products. It does not remove the physical log. Shopify deletion is never automatic.

## 14. Extension points

Future work can add a proper migration framework, authentication, multiple catalogs, multi-store inventory, background job queues, remote object storage, structured log shipping, and a managed relational database. Those changes should preserve the column-B identity contract and explicit supplier/user field ownership rules.
