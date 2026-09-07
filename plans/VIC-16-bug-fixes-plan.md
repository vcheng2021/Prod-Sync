# VIC-16 — eComInt Bugs: Implementation Plan

## Overview

VIC-16 addresses three foundational issues in the eComInt system: comprehensive logging, partial retrieval with productsload logging, and productsload UI. This plan implements all three with detailed documentation of changes from existing functionality.

**Jira Reference**: [VIC-16](https://vicandev1979.atlassian.net/browse/VIC-16)
**Status**: To Do | **Priority**: Medium
**Confirmed**: Image fallback (VIC-16 #3) is EXCLUDED from this implementation — a new Jira ticket will be created for it.

---

## Requirements

### VIC-16 #1: Comprehensive Logging
Log all event failures/issues with meaningful supporting data to `ecomint.log`, including import and posting issues, authentication errors.

### VIC-16 #2: Partial Retrieval + productsload.log
For products that failed to retrieve images or metadata, continue to load what's retrievable and log failed product details in a `productsload.log` file. **BOTH a UI panel (non-modal dialog) AND a separate physical log file are required.**

### VIC-16 #3: ~~Image Fallback~~ — **EXCLUDED**
Per user request, image fallback from column F is removed from this implementation. New Jira ticket to be created.

---

## Current State → Target State (Inline Changes)

### 1. `server/src/logging/logger.ts` — Enhanced Logger

**Current State**: `AppLogger` has only `write(event, outcome, details)` and `readIssues(limit)`. All log entries are `failure`-only via `readIssues()`. No structured event categories exist.

**Target State**: Add convenience methods for each domain area and a `productsload.log` system.

| New Method | Purpose | Parameters |
|---|---|---|
| `writeError()` | Auto-sets outcome='failure', includes stack traces | `event`, `error`, optional `details` |
| `writeAuthEvent()` | Authentication failures (login, token validation, session expiry) | `event`, `outcome`, `details` |
| `writeImportEvent()` | Import validation errors, row-level import failures | `event`, `details` |
| `writePublishEvent()` | Publishing failures with Shopify error details | `event`, `details` |
| `writeEnrichmentEvent()` | Per-field enrichment failures | `event`, `details` |
| `writeProductsLoad()` | Productsload.log entries | `entry: ProductsLoadEntry` |
| `readProductsLoad()` | Read productsload.log entries | `limit?` → `ProductsLoadEntry[]` |

**New Types**:
```typescript
// New in logger.ts
interface ProductsLoadEntry {
  timestamp: string;
  productId: string;
  supplierProductKey: string;
  title: string;
  sourceUrl: string;
  fieldsLoaded: string[];
  fieldsFailed: string[];
  error: string;
  draftId: string;
}
```

**Constructor Change**: `constructor(directory: string)` → `constructor(directory: string, productsLoadPath?: string)`. If `productsLoadPath` is provided, `writeProductsLoad()` and `readProductsLoad()` become active.

**Migration path**: The `productsLoadPath` is optional — if not provided, the productsload methods are no-ops. This ensures backward compatibility with existing code.

### 2. `server/src/types.ts` — New ProductDraft Fields

**Current State**: `ProductDraft` has `enrichmentStatus`, `enrichmentError`, `descriptionHtml`, `brand`, `country`, `region`, `productType`, etc. No `enrichmentPartial` or `failedEnrichmentFields` exist.

**Target State**: Add fields for partial enrichment tracking.

```typescript
// Added to ProductDraft:
enrichmentPartial: boolean;     // true when some fields loaded and some failed
failedEnrichmentFields: string[]; // list of field names that failed
```

**Change from existing**: `enrichmentStatus` (`'pending' | 'ready' | 'failed' | 'blocked' | 'not-provided'`) remains the overall status. `enrichmentPartial` is a separate flag that's `true` when the status is `'ready'` but some fields failed (partial success). `enrichmentError` still contains the overall error message, but now also includes the list of failed fields.

### 3. `server/src/enrichment/sourcePageFetcher.ts` — Partial FetchResult

**Current State**: `FetchResult` has `status: 'ready' | 'failed' | 'blocked'`, `details: EnrichedProductDetails`, `error: string`. If any field extraction fails, the entire result fails.

**Target State**: `FetchResult` supports partial results where some fields load and others fail.

```typescript
// Updated FetchResult interface:
interface FetchResult {
  status: 'ready' | 'failed' | 'blocked';
  details: EnrichedProductDetails;
  error: string;
  partialDetails: Partial<EnrichedProductDetails>;  // NEW: what was successfully loaded
  failedFields: string[];                             // NEW: which fields failed to load
}
```

**Change from existing**: Each field extraction in `extractProductDetails()` is now wrapped in its own try-catch. One field failure doesn't block others. If at least some fields load successfully, `status` is `'ready'` and `partialDetails` contains the loaded fields. `failedFields` lists the names of fields that failed.

### 4. `server/src/drafts/draftStore.ts` — Partial Enrichment Persistence

**Current State**: `updateProduct()` accepts `Partial<ProductDraft>` but expects all fields to be complete. `mergeWorkbook()` inserts/updates all fields from the workbook.

**Target State**: Support partial enrichment updates. Preserve `enrichmentPartial`, `failedEnrichmentFields` across merges.

**Changes**:
- Add columns to `products` table via `addColumnIfMissing()`:
  - `enrichment_partial INTEGER NOT NULL DEFAULT 0`
  - `failed_enrichment_fields TEXT NOT NULL DEFAULT '[]'`
- Update `mergeWorkbook()` insert/update SQL to include new fields
- Update `updateProduct()` to handle `enrichmentPartial`, `failedEnrichmentFields`, `partialDetails`
- When merging workbooks, preserve `enrichmentPartial` and `failedEnrichmentFields` (app-owned) unless source URL changed

### 5. `server/src/routes/imports.ts` — Import Error Logging + Productsload Endpoint

**Current State**: Import errors are returned in the HTTP response but not logged. `POST /api/imports` logs only success at `workbook.merge`. `GET /api/issues` returns log failures.

**Target State**: 
- Import errors logged with `logger.writeImportEvent()`
- New `GET /api/productsload?draftId=<id>` endpoint

**Changes to `POST /api/imports`**:
```typescript
// BEFORE:
logger.write('workbook.merge', 'success', { ... });
return response.json({ ... });

// AFTER (with error logging):
try {
  const parsed = parseWorkbook(transformedBuffer, draftId);
  // ... existing logic ...
  logger.write('workbook.merge', 'success', { ... });
} catch (error) {
  logger.writeImportEvent('import.parse.failure', {
    filename: request.file.originalname,
    error: error instanceof Error ? error.message : 'Unknown error',
  });
  throw error;
}
// Log row-level errors:
parsed.importErrors.forEach(err => {
  logger.writeImportEvent('import.row.error', {
    rowNumber: /* extracted */,
    supplierProductKey: /* extracted */,
    validationErrors: err,
  });
});
```

**New endpoint `GET /api/productsload?draftId=<id>`**:
```typescript
router.get('/api/productsload', (request, response, next) => {
  try {
    const draftId = typeof request.query.draftId === 'string' ? request.query.draftId : undefined;
    const entries = logger.readProductsLoad(100).filter(entry => !draftId || entry.draftId === draftId);
    return response.json(entries);
  } catch (error) {
    return next(error);
  }
});
```

### 6. `server/src/routes/publishing.ts` — Publish Error Logging

**Current State**: `logger.write('product.publish', ...)` exists but only logs the final status. Per-product details (shopifyProductId, matchCount) are logged but not consistently.

**Target State**: Add `logger.writePublishEvent()` for each product's publish result with full Shopify error details.

### 7. `server/src/auth/authMiddleware.ts` — Auth Error Logging

**Current State**: Auth errors are caught and returned but not logged with `logger.writeAuthEvent()`.

**Target State**: Log failed token validation, expired sessions, and authentication errors via `logger.writeAuthEvent()`.

### 8. `client/src/App.tsx` — Productsload UI Panel

**Current State**: No productsload UI exists. The toolbar has no productsload button.

**Target State**: Add a button in the toolbar that opens a non-modal dialogue box showing products with failed/partial retrieval.

**UI Details**:
- Button labeled "Product Load Issues" in the toolbar
- Clicking opens a non-modal dialog box (NOT a modal/popup that blocks interaction)
- Dialog fetches data from `GET /api/productsload?draftId=<currentDraftId>`
- Displays table: Product Name, Supplier Key, Fields Loaded, Fields Failed, Error
- User can dismiss and continue working (non-modal)
- Clear visual distinction: green for fully loaded, yellow for partial, red for failed

---

## Files to Modify

| File | Change | Notes |
|------|--------|-------|
| `server/src/logging/logger.ts` | Add `writeError()`, `writeAuthEvent()`, `writeImportEvent()`, `writePublishEvent()`, `writeEnrichmentEvent()`, `writeProductsLoad()`, `readProductsLoad()`, `ProductsLoadEntry` interface, `productsLoadPath` | Existing class extended — no breaking changes |
| `server/src/types.ts` | Add `enrichmentPartial: boolean`, `failedEnrichmentFields: string[]` to `ProductDraft` | New fields with safe defaults |
| `server/src/enrichment/sourcePageFetcher.ts` | Update `FetchResult` to include `partialDetails`, `failedFields`; wrap each field extraction in try-catch | Existing `EnrichedProductDetails` unchanged |
| `server/src/drafts/draftStore.ts` | Add `enrichment_partial`, `failed_enrichment_fields` columns; update `mergeWorkbook()`, `updateProduct()`, `getDraft()` | Uses `addColumnIfMissing()` for migration |
| `server/src/routes/imports.ts` | Add import error logging, auth error logging (via middleware), `GET /api/productsload` endpoint | Existing routes unchanged |
| `server/src/routes/publishing.ts` | Use `logger.writePublishEvent()` | Existing logging enhanced |
| `server/src/auth/authMiddleware.ts` | Use `logger.writeAuthEvent()` | New logging |
| `server/src/index.ts` | Initialize `productsLoadPath`, pass to logger | Small config addition |
| `client/src/App.tsx` | Add productsload UI button + non-modal dialog | New UI component |

---

## Verification Checklist

1. **Import error logging**: Upload a workbook with invalid rows → verify `ecomint.log` has `import.row.error` entries with `rowNumber`, `supplierProductKey`, `validationErrors`
2. **Auth logging**: Attempt login with wrong password → verify `ecomint.log` has auth failure entry via `writeAuthEvent()`
3. **Partial retrieval**: For a product where description loads but brand fails → verify `enrichmentPartial=true`, `failedEnrichmentFields` contains the failed field name
4. **productsload.log**: Verify `logs/productsload.log` has entries for partial/failed products
5. **productsload endpoint**: `GET /api/productsload?draftId=<id>` returns structured failures with fieldsLoaded/fieldsFailed
6. **productsload UI**: Click button → non-modal dialog opens with product load issues
7. **TypeScript**: `npm run typecheck` passes
8. **Build**: `npm run build` succeeds
9. **Thorough testing**: Each verification item tested extensively before proceeding to VIC-17

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| `FetchResult` change breaks existing callers | Medium | `partialDetails` and `failedFields` are new fields — existing code ignores them |
| `addColumnIfMissing` migrations could fail | Low | Existing `addColumnIfMissing()` pattern proven in codebase |
| productsload UI adds complexity to App.tsx | Medium | Non-modal design doesn't block interaction; new UI in dedicated section |
