# eComInt Application Review & Recommendations

> Date: 2026-08-28
> Reviewer: Codebase assessment of the full stack (server + client + Docker).

---

## 1. Executive Summary

eComInt is a well-structured, single-instance internal product workspace. Its core architecture is sound: server-side Shopify token isolation, supplier-owned vs. app-owned field tracking, explicit retrieval gating, SQLite WAL with transactional merges, and redacted JSON-lines logging are all strong design decisions. The application correctly avoids making network requests during import/checkbox-toggle and only fetches supplier data when explicitly requested for checked rows.

However, as a production-internal tool, several areas would benefit from attention before scaling usage or onboarding additional operators:

1. **No automated test suite whatsoever** — the highest-risk gap.
2. **Client state management complexity** — a single 563-line `App.tsx` with convoluted dirty-field / publish-merge logic that is difficult to verify.
3. **Operational robustness** — no graceful shutdown, dead concurrency config, minimal health checks, no rate limiting.
4. **Code hygiene** — dead code, duplicated state-clearing, Vite template CSS carried over, validation-error filtering in the store layer.

The recommendations below are prioritized by impact and grouped by category.

---

## 2. Architecture Assessment

### Strengths

| Area | What's done well |
|---|---|
| Security | Shopify Admin token is server-only; URL allowlist + DNS rebinding protection + redirect limits + size caps on both source and image fetches. |
| Data ownership | Clear supplier-owned vs. app-owned field semantics; suggested-sale-price override detection; source-URL-change enrichment reset. |
| Persistence | SQLite WAL mode; transactional workbook merges and bulk saves; unique partial index on normalized supplier keys. |
| Publish safety | Title-match query with zero/one/multiple semantics; idempotency keys on inventory mutations; `userErrors` checked per mutation; transport errors retain extension codes. |
| Retrieval gating | Import and checkbox toggles make zero network requests; retrieval is explicit for checked rows only. |
| Logging | Append-only JSON Lines; structured redaction of sensitive keys; reverse-chronological failure reader. |
| Docker | Multi-stage build; separate volumes for data, logs, images; healthcheck. |

### Areas for Improvement

#### 2.1 No Test Framework (Critical)

**Finding:** There is no test script in `package.json`, no test framework installed, and no test files anywhere in the repository. The `IMPLEMENTATION_PLAN.md` mentions "operational checks" but these are manual verification steps, not automated tests.

**Impact:** Any future change touches critical paths (workbook parsing, merge logic, Shopify publishing, HTML sanitization, image download validation) with no regression safety net. The dirty-field and publish-merge logic in the client is particularly fragile and difficult to reason about without tests.

**Recommendations:**
1. **Add Vitest for the server** — it's the natural choice for a Vite-based monorepo. Start with unit tests for:
   - `xlsxParser.ts`: column mapping, key normalization, duplicate handling, price calculation, validation error generation.
   - `draftStore.ts`: merge transaction semantics (added/updated/unchanged counts), dirty-field persistence, purge behavior, legacy migration.
   - `productDetailsExtractor.ts`: HTML sanitization against XSS payloads, label matching, description extraction fallback chain.
   - `adminGraphqlClient.ts`: error handling for HTTP failures, GraphQL transport errors, missing data.
   - `productPublisher.ts`: title matching (zero/one/multiple), price/inventory validation, description composition.
   - `sourcePageFetcher.ts`: URL validation (private IPs, localhost, non-HTTPS, redirects), response size limits.
2. **Add Vitest + React Testing Library for the client** — critical for:
   - Dirty-field staging and Save API payload composition.
   - Publish flow: merging staged changes into the publish request, valid/invalid selected product filtering.
   - Filter/sort/pagination behavior with selections preserved.
   - `beforeunload` prompt when unsaved changes exist.
3. **Add a Shopify API contract test** — since `productPublisher.ts` has no real test coverage, mock the GraphQL client and assert the correct mutations fire in the right order with correct arguments (idempotency keys, cost, inventory, price, media).

#### 2.2 Client State Management Complexity (High)

**Finding:** `client/src/App.tsx` is a single 563-line file managing all UI state. The dirty-field map, publish-changes composition, and state-clearing logic are duplicated across `handleSave`, `handlePublish`, `handleImport`, `handleResetPage`, and `handlePurge`.

**Specific issues:**

1. **`handlePublish` changes logic** (`App.tsx:380-385`): The publish request merges `pendingChanges` (a shallow copy of dirty fields) and then adds `selected: true` to every product that appears in `validSelectedProducts`. This is redundant — the server already filters on `product.selected`, and the `changes` array is meant to carry *field edits*, not selection state. The deep-copy + merge is fragile.

2. **`handleSave` dirty-field cleanup** (`App.tsx:216-226`): After a successful save, the code attempts to compute "unresolved" dirty fields by comparing the server response against the original pending changes. This works but is opaque. A server-side validation rejection on one field could silently drop other unrelated pending changes on the same product from the dirty map without the user realizing.

3. **State-clearing duplication** (`App.tsx:265-285`, `App.tsx:292-320`): `resetPageState` and `handlePurge` both list 18 state setters. If a new piece of state is added, one will inevitably be missed.

**Recommendations:**
1. Extract the state-clearing into a single `resetAllTransientState()` function called by both reset and purge.
2. Use `useReducer` or extract a custom hook (e.g., `useWorkspaceState`) for the product-editing and filter state. This would make the dirty-field lifecycle testable in isolation.
3. Simplify the publish flow: the client already has `dirtyFields`; the server's `publishing.ts` already calls `store.updateProducts` before selecting products. The `changes` array should only carry field edits, not `selected: true`. Remove the redundant `selected` injection and the deep-copy.
4. Add a React `ErrorBoundary` component to catch client-side render errors gracefully instead of leaving the user with a blank screen.

#### 2.3 Server: No Graceful Shutdown (Medium)

**Finding:** `server/src/index.ts` calls `app.listen` but never registers `SIGTERM`/`SIGINT` handlers. In Docker, `docker compose stop` sends `SIGTERM`; Express's default behavior in Node 22 will process pending requests but the process may exit mid-request.

**Impact:** During container replacement, in-flight publish operations or workbook merges could be interrupted, leaving the SQLite database in a consistent state (thanks to transactions) but the client unaware of the outcome.

**Recommendation:**
```typescript
const server = app.listen(config.port, () => {
  console.log(`eComInt server listening on http://localhost:${config.port}`);
});
process.on('SIGTERM', () => {
  logger.write('server.shutdown', 'success', { reason: 'SIGTERM' });
  server.close(() => process.exit(0));
});
```

#### 2.4 Dead Configuration: `IMAGE_DOWNLOAD_CONCURRENCY` (Medium)

**Finding:** `config.ts:31` defines `imageDownloadConcurrency: Number(process.env.IMAGE_DOWNLOAD_CONCURRENCY ?? 3)`, and it's passed through `docker-compose.yml`. However, a `Grep` across the entire codebase shows it is **never consumed** anywhere in the server code. The retrieve endpoint (`imports.ts:109-136`) processes a single product at a time via `Promise.all([source, image])` for that one product.

**Impact:** The config is misleading — operators may tune it expecting to control image download parallelism, but it has no effect. The `docker-compose.yml` and `.env.example` both advertise it as a working knob.

**Recommendation:** Either implement it (e.g., use a semaphore in the retrieve endpoint to limit concurrent image downloads across multiple retrieve calls) or remove it from config, `.env.example`, and `docker-compose.yml` to avoid confusion.

#### 2.5 Dead Code: `validateImageUrl` Export (Low)

**Finding:** `sourcePageFetcher.ts:177` exports `validateImageUrl`, but it is never called anywhere. The actual image validation happens inside `downloadProductImage` in `imageDownloader.ts`, which has its own `validateUrl` function.

**Recommendation:** Remove the dead `validateImageUrl` export or wire it into the flow if it was intended to pre-validate before download.

#### 2.6 Store Layer Filters Validation Errors (Low)

**Finding:** `draftStore.ts:352-354` (`toProduct` method) silently filters out two specific validation error strings from what is returned to the client:

```typescript
const validationErrors = (JSON.parse(row.validation_errors) as string[])
  .filter((error) =>
    error !== 'Duplicate title in this import.' &&
    !(row.unit_price === null && error === 'Unit price must be greater than zero (column J).'));
```

**Impact:** The client's product editor and issue log will not show these errors, even though they are stored in SQLite. This makes debugging harder and creates a discrepancy between what is stored and what is displayed. The rationale is unclear from the code — it appears to be a UX decision to hide "duplicate title" warnings (since duplicates are allowed per the spec), but this is implicit.

**Recommendation:** Make this filtering explicit and documented. Consider adding a `hidden` flag to the error object rather than string-matching, or move this filtering to the client layer where presentation decisions belong.

#### 2.7 Vite Template CSS Carried Over (Low)

**Finding:** `client/src/App.css` is still the default Vite + React template CSS (Hero component, `#center`, `#next-steps`, counter styles, etc.). The actual application styles live entirely in `workspace.css`. The `index.css` file also carries the default Vite template styles (`#root`, social links, etc.) that are unused by the application.

**Impact:** No functional issue, but it's 190 lines of dead CSS shipped to every user. Confusing for future developers who expect `App.css` to be the app's stylesheet.

**Recommendation:** Either delete `App.css` and `index.css` contents that are unused, or repurpose them. The `App.tsx` imports both `./App.css` and `./workspace.css`; if `App.css` has no app-relevant styles, remove the import.

#### 2.8 Missing Database Indexes (Medium)

**Finding:** The `products` table has a unique partial index on `(draft_id, supplier_product_key_normalized)`, but queries on `publish_status`, `enrichment_status`, and `validation_errors` are not indexed. The issues view queries failure entries from the log file (not the DB), but the `toSummary` method filters products by `enrichment_status === 'ready'` and `publish_status === 'failed' || 'skipped'` in JavaScript after loading all products for a draft.

**Impact:** For catalogs with thousands of products, loading the current draft (which loads *all* products) and computing summary counts will become slow. Currently the app loads the entire catalog into the browser on startup.

**Recommendation:**
1. Add an index on `(draft_id, publish_status)` and `(draft_id, enrichment_status)` to support summary queries.
2. Consider server-side pagination or count queries for the summary rather than loading all products and filtering in JS.

#### 2.9 No Rate Limiting (Medium)

**Finding:** The Express server has no rate limiting on any API endpoint. While this is an internal single-user app, a misconfigured script or a runaway client loop could issue many concurrent requests.

**Recommendation:** Add `express-rate-limit` or a similar middleware. Even per-IP limits of 100 requests/minute would prevent accidental abuse. This is low-risk for an internal tool.

#### 2.10 Health Check Is Minimal (Low)

**Finding:** `GET /api/health` only checks that Express is responding. It does not verify database connectivity, log directory writability, or image directory writability. The Docker healthcheck is the same.

**Impact:** A container could be marked "healthy" while its SQLite volume is unmounted or unwritable, leading to confusing failures when the operator tries to save or import.

**Recommendation:** Enhance the health endpoint to check:
- Can the server open a read-only connection to SQLite?
- Is the log directory writable?
- Is the image directory writable?

Use a `GET /api/health` for liveness (Express responding) and `GET /api/ready` for readiness (all resources available). Or return a composite status.

#### 2.11 Client-Side Filtering Doesn't Scale (Medium)

**Finding:** All products are loaded into browser memory on startup (`getCurrentDraft`) and all filtering/sorting/pagination is done in the browser (`App.tsx:156-176`). For the default seed (Paramount Liquor workbook), this is likely a few hundred to low thousands of products — fine for now. But the `maxImportRows` config allows up to 10,000.

**Impact:** At 10k products, the browser will render 10k DOM nodes (the table renders all visible products — actually, wait, it does paginate client-side with `PAGE_SIZE = 40`, so only 40 rows render at a time, but the filtering/sorting still processes all 10k in memory). The `useMemo` for `filterOptions` iterates all products for 9 filter fields on every product change.

**Recommendation:** For the current scale (single supplier workbook), this is acceptable. But if the app grows, move filtering to server-side with `GET /api/drafts/:draftId/products?filter=...&page=...`.

#### 2.12 Source Cache Has No TTL (Low)

**Finding:** `draftStore.ts:332-340` caches enrichment results in SQLite with no TTL or expiry. The cache key is `(url, parser_version)`. Once a supplier page is successfully scraped, the result is cached forever unless the `ENRICHMENT_CACHE_VERSION` constant is bumped.

**Impact:** If a supplier updates a product page (fixing a broken description, adding new fields), the operator must either bump the cache version or use the Refresh action (which bypasses cache). For a small operator workflow, this is acceptable, but it could confuse users who expect fresh data.

**Recommendation:** Add an `expires_at` column to `source_cache` (e.g., 7-day TTL) and check it in `getCachedEnrichment`. Or at minimum, add a UI indicator showing when enrichment was last fetched (`enrichmentFetchedAt` is already stored).

#### 2.13 `express.json({ limit: '2mb' })` May Be Too Restrictive (Low)

**Finding:** `index.ts:37` sets `express.json({ limit: '2mb' })` for all non-multipart JSON requests. The bulk Save endpoint (`PATCH /api/drafts/:draftId/products`) sends an array of product changes. For products with large `descriptionHtml` fields (enriched from supplier pages), 2MB could be exceeded if an operator edits many products at once.

**Impact:** Low for typical usage (Save sends only *changed* fields), but worth verifying. The `body-parser` doesn't log when it rejects an oversized body (it just drops the request), which makes debugging harder.

**Recommendation:** Either increase the limit or add a dedicated error handler for payload-too-large from body-parser. Monitor in logs.

#### 2.14 No Request Body Validation on PATCH Endpoints (Medium)

**Finding:** The bulk Save endpoint (`imports.ts:73-86`) validates that the body is an array of `{ id, changes }` objects, and `updateProducts` checks that all fields are in the allowlist. However, the single-product patch endpoint (`imports.ts:65-71`) passes `request.body` directly to `store.updateProduct` with no validation — if `body` is malformed or contains unsupported fields, the error will come from the store layer with a generic message.

**Impact:** Minor — the store does validate, but the error message and HTTP status could be inconsistent. A more disciplined approach would use a validation library (e.g., `zod`) on all request bodies.

**Recommendation:** Add schema validation (Zod or similar) to all PATCH/POST endpoints. This would also make the API self-documenting.

#### 2.15 Publishing Is Sequential (By Design, but Documented Gap) (Low)

**Finding:** `publishing.ts:38-44` publishes products in a sequential `for` loop. This is the correct choice for avoiding Shopify API rate limits and ensuring idempotency keys work correctly, but for large publish batches it could be slow.

**Assessment:** This is the right design decision for v1. Document it clearly in the code and docs. If throughput becomes an issue, consider `Promise.all` with a concurrency limiter (e.g., `p-limit`), but be careful with idempotency key semantics.

---

## 3. Prioritized Recommendations

### Tier 1 — Must Fix (High Risk)

| # | Recommendation | Effort |
|---|---|---|
| 1 | Add Vitest test suite for server core modules (parser, store, publisher, fetcher, extractor) | 3-5 days |
| 2 | Add Vitest + React Testing Library for client dirty-field/save/publish flows | 2-3 days |
| 3 | Implement graceful `SIGTERM` shutdown in the Express server | Hours |
| 4 | Remove or implement `IMAGE_DOWNLOAD_CONCURRENCY` (currently dead config) | Hours |

### Tier 2 — Should Fix (Medium Risk / User Impact)

| # | Recommendation | Effort |
|---|---|---|
| 5 | Add React `ErrorBoundary` to client | Hours |
| 6 | Add database indexes for summary queries | Hours |
| 7 | Add request rate limiting middleware | Hours |
| 8 | Extract shared state-clearing logic to avoid duplication | Hours |
| 9 | Add TTL to `source_cache` table | Hours |
| 10 | Simplify publish-changes logic in `handlePublish` | Days |

### Tier 3 — Nice to Have (Low Risk / Polish)

| # | Recommendation | Effort |
|---|---|---|
| 11 | Remove dead `validateImageUrl` export | Minutes |
| 12 | Clean up Vite template CSS in `App.css` and `index.css` | Hours |
| 13 | Enhance `/api/health` with readiness checks | Hours |
| 14 | Add Zod schema validation to API request bodies | Days |
| 15 | Document that publishing is sequential by design | Minutes |
| 16 | Add request-level IDs to logs for tracing | Days |

---

## 4. Files Referenced

| File | Lines | Concern |
|---|---|---|
| `server/src/index.ts` | 1-59 | No graceful shutdown (p. 3) |
| `server/src/config.ts` | 31 | Dead `imageDownloadConcurrency` (p. 4) |
| `server/src/logging/logger.ts` | 1-56 | Good design, no issues |
| `server/src/drafts/draftStore.ts` | 352-354 | Validation-error filtering (p. 6) |
| `server/src/drafts/draftStore.ts` | 332-340 | No cache TTL (p. 13) |
| `server/src/routes/imports.ts` | 73-86 | Bulk save validation OK; single-patch lacks validation (p. 15) |
| `server/src/routes/publishing.ts` | 38-44 | Sequential publishing (p. 16) |
| `server/src/enrichment/sourcePageFetcher.ts` | 177 | Dead `validateImageUrl` export (p. 5) |
| `server/src/enrichment/imageDownloader.ts` | — | Good security validation |
| `client/src/App.tsx` | 563 | Monolithic, dirty-field complexity, duplicated state clearing (p. 2) |
| `client/src/App.tsx` | 380-385 | Redundant publish changes logic (p. 2) |
| `client/src/App.css` | 1-190 | Vite template CSS dead weight (p. 8) |
| `client/src/index.css` | 1-119 | Vite template CSS, partly unused (p. 8) |

---

## 5. Summary

The eComInt application is architecturally solid for its intended single-instance, internal-operator use case. The core business logic (workbook parsing, field ownership, Shopify publishing with title matching and idempotency) is well-implemented. The main gaps are in **test coverage** (non-existent), **client state management complexity**, and a few **operational robustness** items (graceful shutdown, dead config, health checks).

The highest-value investment would be adding an automated test suite, which would both protect the existing correct behavior and make the client's dirty-field / publish-merge logic safe to refactor.
