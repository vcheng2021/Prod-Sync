# Assessment & Implementation Plans — VIC-16, VIC-17, VIC-18

## Context

The user has asked for a thorough assessment of three Jira tickets in the Vican Kanban project (cloudId: `44b43ba6-7945-4113-8b86-544dbad5776a`), each currently in **To Do** status with **Medium** priority. This assessment covers the current codebase state, the requirements of each ticket, and a detailed implementation and change plan. The output is structured as three separate markdown files to be placed under `plans/` in the project root.

**All three tickets are interrelated:**
- VIC-16 (Bugs) addresses foundational logging, retrieval resilience, and productsload logging.
- VIC-17 (AliExpress Product Page Spec) defines how AliExpress product data is extracted and displayed.
- VIC-18 (Supplier Selection) is the umbrella feature that ties everything together with a supplier dropdown UI.

---

## CONFIRMED USER ANSWERS (from inline Q&A)

The following were confirmed by the user inline in the assessment:

### 1. VIC-18 Scope
- **Vican Visions uses WooCommerce** (not Shopify) — different platform, requires WooCommerce hooks and env variable setup
- **Catalog filtering**: Only show products from active supplier (including product details pane)
- Both suppliers have different formats, columns, product attribute details in different places
- Publishing: Shopify for Cellar, WooCommerce for Vican (based on supplier/product selection)
- **Template file**: `template_aliexpress_presson1.xlsx` — user created it, removed redundant columns
  - Column A → URL to full product details page (for extracting attributes/descriptions)
  - Columns B-F → 5 images for WooCommerce (column B is default main product picture, but user can select any of the 5 as the main image)
  - Column G → product title
  - Columns H (dollars) and I (cents) → combined cost price
  - All to persist in Database
  - Purging/load new data same as Cellar Drive

### 2. VIC-17 AliExpress HTML Parsing
- Sample URLs provided: `aliexpress.com/item/1005010420188480.html` and `aliexpress.com/item/1005008188148384.html`
- HTML parsing is the primary approach (no catalog/JSON API mentioned for AliExpress)

### 3. VIC-16 `productsload.log`
- **BOTH** a UI panel (non-modal dialogue box, accessed via button) AND a separate physical log file

### 4. VIC-16 #3 Image Fallback — **REMOVED from this implementation**
- User explicitly said: "leave this out of this implementation, create a new Jira ticket to work on this later"
- **All references to image fallback from column F removed from VIC-16, VIC-17, and VIC-18 plans**
- New Jira ticket to be created for image fallback in a future phase

### 5. Image Count for Vican Visions
- **5 images** (columns B-F from template)
- Must accommodate multiple images as stated in Jira and confirmed above
- Column B is the default main product picture, but user can select any of the 5 images as the main image

### 7. Main Image Default
- When displaying the image gallery, column B is the default main image
- User can still select any of the 5 images (columns B-F) as the main product picture

### 6. Implementation Priority
- All three tickets in dependency order: **VIC-16 → VIC-17 → VIC-18**
- Must thoroughly test each section before proceeding to the next

---

## Ticket Assessment Summary

| Ticket | Summary | Status | Priority | Key Complexity |
|--------|---------|--------|----------|----------------|
| VIC-16 | eComInt Bugs — logging, partial retrieval, productsload.log | To Do | Medium | Medium — enhances existing systems |
| VIC-17 | AliExpress Product Page Spec — extraction of images, description, specs | To Do | Medium | High — new parsing logic + new UI components |
| VIC-18 | Core — Supplier Selection dropdown with Apply button (WooCommerce) | To Do | Medium | High — architectural change affecting entire app flow |

---

## Current Codebase State (Key Facts)

### Architecture
- **Server**: Express + TypeScript + better-sqlite3, single `DraftStore` owns all SQLite operations
- **Client**: React 19 + Vite, single-file `App.tsx` (~2000+ lines), single `api.ts` fetch wrapper
- **Auth**: Already partially implemented (`server/src/auth/`, `crypto.scryptSync`, HTTP-only cookies)
- **Platform**: Partial abstraction (`server/src/platforms/`, `PlatformClient` interface exists)
- **Standard Format**: 16-column layout defined in `server/src/imports/standardFormat.ts`; `StandardCol` indices: IMAGE_1=0, KEY=9, TITLE=10, SOURCE_URL=11, SOH=12, CASE_PRICE=13, UNIT_PRICE=14, SUPPLIER_TYPE=15
- **Supplier Detection**: `detectSupplier()` in `supplierConfig.ts` uses header matching (AliExpress vs Paramount/Cellar)
- **Transformation**: `transformToStandard()` in `transformWorkbook.ts` converts native workbooks to standard 16-column format before `xlsxParser.ts` processes them

### Existing Enrichment
- `sourcePageFetcher.ts`: Fetches supplier product details via catalog/JSON endpoints then HTML fallback; validates URLs (HTTPS, allowlist, DNS private-IP blocking); `fetchProductDetails()` returns `FetchResult` with status `ready | failed | blocked`
- `productDetailsExtractor.ts`: Cheerio-based HTML extraction; `extractProductDetails()` parses brand, country, region, productType, abv, containerType, style from HTML; `extractSupplierProductDetails()` parses `SupplierProductPayload` from JSON catalog
- `imageDownloader.ts`: Downloads images with validation, redirect handling, size limits; returns `ImageDownloadResult`
- `htmlSanitizer.ts`: Sanitizes HTML before storage/display/Shopify publication

### Existing Logger
- `logger.ts`: `AppLogger` class with `write(event, outcome, details)` and `readIssues(limit)` methods
- Already redacts `token|secret|password|authorization|credential|cookie` keys
- Physical JSON Lines log at `logs/ecomint.log`
- `GET /api/issues?draftId=<id>` returns up to 100 reversed failure records

### Existing Product Types
- `ProductDraft` in `types.ts` has: `imageUrl`, `imageUrls`, `imageStatus`, `sourcePlatform`, `enrichmentStatus`, `enrichmentError`, plus all enrichment fields (brand, country, region, productType, abv, containerType, style), pricing (unitPrice, casePrice, suggestedSalePrice), inventory, Shopify state, validation errors
- No `productAttributes`, `productDescription`, or `supplier` fields exist yet
- No per-image retrieval status (only single `imageStatus`)

### Existing Import Flow
- `POST /api/imports`: uploads .xlsx → `transformToStandard()` → `parseWorkbook()` → `store.mergeWorkbook()`
- `transformToStandard()` detects supplier type, applies mapping, returns standard rows
- `parseWorkbook()` validates rows, creates `ProductDraft` objects
- Merge preserves app-owned fields, refreshes supplier-owned fields

### Existing Retrieval Flow
- `POST /api/drafts/:draftId/products/:productId/retrieve`: fetches source details + downloads image for checked rows
- `POST /api/drafts/:draftId/products/:productId/refresh`: re-fetches source details
- Retrieval merges with pending client edits

---

# Plan 1: VIC-16 — eComInt Bugs

## Ticket Requirements (from Jira)

1. **Log all event failures/issues with meaningful supporting data** to `ecomint.log`, including import and posting issues, authentication errors
2. **For products that failed to retrieve images or metadata**, continue to load what's retrievable and log failed product details in a `productsload.log` file
3. ~~**If image retrieval failed using image column (A), try retrieving a valid image from URL (F)**~~ — **REMOVED** (new Jira ticket to be created)

## Current State Assessment

| Requirement | Current State | Gap |
|-------------|--------------|-----|
| #1 — Comprehensive logging | Logger exists but only logs at key events (merge, save, publish, purge, retrieve). Missing: import validation errors, authentication errors, retrieval per-product failures, enrichment per-field failures | Need to add logging at more granular points |
| #2 — Partial retrieval + productsload.log | `fetchProductDetails()` returns `failed`/`blocked` but the retrieval endpoint fails the entire product. No `productsload.log` exists. No concept of partial enrichment (some fields loaded, some failed) | Need partial enrichment support + separate log file |
| #3 — ~~Image fallback~~ | **REMOVED from scope** per user request. New Jira ticket to be created. | N/A |

## Detailed Implementation Plan

### Phase 1A: Enhanced Logging (VIC-16 #1)

**Goal**: Ensure every meaningful failure event is logged with rich supporting data.

**Changes needed:**

#### 1. `server/src/logging/logger.ts` — Add structured event categories

- Add `writeError()` convenience method that auto-sets `outcome: 'failure'` and includes stack traces for errors
- Add `writeAuthEvent()` method specifically for authentication failures (login failures, token validation failures, session expiry)
- Add `writeImportEvent()` method for import validation errors, row-level import failures
- Add `writePublishEvent()` method for publishing failures with Shopify error details
- Add `writeEnrichmentEvent()` method for per-field enrichment failures
- Ensure all `details` objects include `draftId`, `productId` (where applicable), `supplierProductKey`, and `timestamp`
- Add `writeProductsLoad()` method for the productsload.log functionality (Phase 1B)

**New methods on `AppLogger`:**
```typescript
writeError(event: string, error: Error, details?: Record<string, unknown>): void
writeAuthEvent(event: string, outcome: LogOutcome, details: Record<string, unknown>): void
writeImportEvent(event: string, details: Record<string, unknown>): void
writePublishEvent(event: string, details: Record<string, unknown>): void
writeEnrichmentEvent(event: string, details: Record<string, unknown>): void
writeProductsLoad(entry: ProductsLoadEntry): void
readProductsLoad(limit?: number): ProductsLoadEntry[]
```

#### 2. `server/src/routes/imports.ts` — Add import error logging

- Wrap `parseWorkbook()` call in try-catch; log validation errors with row numbers and error messages via `logger.writeImportEvent()`
- Log authentication-related events in auth middleware (login success/failure, session validation failures)
- Log each row-level import error individually with `rowNumber`, `supplierProductKey`, and `validationErrors`

#### 3. `server/src/routes/publishing.ts` — Add publish error logging

- Log each product's publish result (success/failure/skip) with `shopifyProductId`, `publishError`, and `publishStatus`
- Log Shopify transport errors with extension codes and mutation errors with field paths
- Log partial publish failures (some products succeed, some fail)

#### 4. `server/src/auth/authMiddleware.ts` — Add auth error logging

- Log failed token validation, expired sessions, and authentication errors
- Use `logger.writeAuthEvent()` with details about the failure type

#### 5. `server/src/enrichment/sourcePageFetcher.ts` — Add enrichment failure logging

- Log each field extraction failure (e.g., "Brand not found for URL X")
- Log when HTML fallback is triggered
- Log when source fetch returns shell/no product data

#### 6. `server/src/drafts/draftStore.ts` — Add merge/error logging

- Log merge results per product (added/updated/unchanged/skipped)
- Log validation errors during merge
- Log enrichment status changes

### Phase 1B: Partial Retrieval + productsload.log (VIC-16 #2)

**Goal**: When a product's retrieval partially succeeds, save what's retrievable and log failures separately. **Must have both a UI panel (non-modal dialog) and a separate physical log file.**

**Changes needed:**

#### 1. `server/src/types.ts` — Add partial enrichment support

- Add `enrichmentPartial` flag to `ProductDraft`: `enrichmentPartial: boolean` — true when some fields loaded and some failed
- Add `failedEnrichmentFields` array: `failedEnrichmentFields: string[]` — list of field names that failed
- Add `productsLoadLog` concept: a separate log file tracking products with partial/failed retrieval

#### 2. `server/src/enrichment/sourcePageFetcher.ts` — Modify `fetchProductDetails()` to support partial results

- Change return type to include partial results: if description loads but brand doesn't, still return the description
- Add `partialDetails` to `FetchResult`: `partialDetails: Partial<EnrichedProductDetails>` — what was successfully loaded
- Add `failedFields: string[]` to `FetchResult` — which fields failed to load
- Each field extraction should be wrapped in its own try-catch so one failure doesn't block others

#### 3. `server/src/drafts/draftStore.ts` — Support partial enrichment persistence

- Update `updateProduct()` to accept partial enrichment updates (not all-or-nothing)
- Store `enrichmentPartial`, `failedEnrichmentFields`, and `enrichmentError` (now containing list of failed fields)
- When merging workbooks, preserve partial enrichment state

#### 4. `server/src/logging/logger.ts` — Add `productsload.log` functionality

- Add `productsLoadPath` constructor parameter
- Add `writeProductsLoad(entry)` method that appends to `productsload.log`
- Each entry includes: `timestamp`, `productId`, `supplierProductKey`, `title`, `sourceUrl`, `fieldsLoaded`, `fieldsFailed`, `error`
- Add `readProductsLoad(limit?)` method to read entries from `productsload.log`
- Add `GET /api/productsload?draftId=<id>` endpoint in `server/src/routes/imports.ts` to expose failed product details

#### 5. `server/src/routes/imports.ts` — Add productsload endpoint

- `GET /api/productsload?draftId=<id>`: returns up to 100 products with failed/partial enrichment for the draft
- `POST /api/drafts/:draftId/products/:productId/retrieve`: now logs partial failures to `productsload.log`

#### 6. `client/src/App.tsx` — Add productsload UI panel

- Add a button in the toolbar that opens a **non-modal dialogue box** showing products with failed/partial retrieval
- Fetch data from `GET /api/productsload?draftId=<id>`
- Display: product name, supplier key, which fields loaded, which failed, error details
- Non-modal: user can dismiss and continue working
- Clear visual distinction between fully loaded and partial/failed products

## Files to Modify — VIC-16

| File | Change |
|------|--------|
| `server/src/logging/logger.ts` | Add `writeError()`, `writeAuthEvent()`, `writeImportEvent()`, `writePublishEvent()`, `writeEnrichmentEvent()`, `writeProductsLoad()`, `readProductsLoad()`, `productsLoadPath` |
| `server/src/types.ts` | Add `enrichmentPartial`, `failedEnrichmentFields` to `ProductDraft` |
| `server/src/drafts/draftStore.ts` | Add partial enrichment support, `productsload.log` path |
| `server/src/enrichment/sourcePageFetcher.ts` | Support partial `FetchResult` with `failedFields`, per-field try-catch |
| `server/src/routes/imports.ts` | Add import error logging, auth error logging, productsload endpoint |
| `server/src/routes/publishing.ts` | Add publish event logging with Shopify error details |
| `server/src/auth/authMiddleware.ts` | Add auth failure logging |
| `server/src/index.ts` | Initialize `productsLoadPath`, pass to logger |
| `client/src/App.tsx` | Add productsload UI panel (non-modal dialog button) |

## Verification for VIC-16

1. **Logging**: Trigger an import with invalid rows → verify each error appears in `ecomint.log` with `rowNumber`, `supplierProductKey`, `validationErrors`
2. **Auth logging**: Attempt login with wrong password → verify `ecomint.log` has auth failure entry
3. **Partial retrieval**: For a product where description loads but brand fails → verify `enrichmentPartial=true`, `failedEnrichmentFields` contains the failed field, and `productsload.log` has an entry
4. **productsload endpoint**: `GET /api/productsload?draftId=<id>` returns structured failures
5. **productsload UI**: Button opens non-modal dialog showing failed/partial products
6. **TypeScript**: `npm run typecheck` passes
7. **Build**: `npm run build` succeeds
8. **Thorough testing**: Test each verification item extensively before proceeding to VIC-17

---

# Plan 2: VIC-17 — AliExpress Product Page Spec

## Ticket Requirements (from Jira)

- **Sample**: AliExpress product page (e.g., `https://www.aliexpress.com/item/1005010420188480.html`)
- **Product images on the top left** → extract all product images (**5 images from template columns B-F**)
- **Product description on top middle** → extract and present as editable "product Description" text box
- **Product specifications** (lower in page with header "Specifications") → each product has different table format; common fields are Brand Name, Origin, Number of pieces → extract all text and present as editable "product attributes" text box
- **Save button**: persists changes to SQLite DB
- **Reset button**: reverts back to originally loaded item
- **Include cost price and suggested sale price (editable)**

## Current State Assessment

| Requirement | Current State | Gap |
|-------------|--------------|-----|
| Product images extraction | `imageDownloader.ts` downloads single image from `imageUrl` (column A). No multi-image support from AliExpress page. No image extraction from HTML. | Need to parse AliExpress HTML for 5-image gallery |
| Product description extraction | `extractProductDetails()` in `productDetailsExtractor.ts` extracts description via multiple selectors. Works but doesn't have a dedicated "product Description" field separate from `descriptionHtml`. | Need to split into `productDescription` (from Description section) and `productAttributes` (from Specifications section) |
| Specifications extraction | `findLabeledValue()` looks for labeled values but doesn't specifically target "Specifications" section headers | Need to scope extraction to the "Specifications" section only |
| Save to SQLite | `PATCH /api/drafts/:draftId/products/:productId` works with allowlisted fields | Need to add `productAttributes` and `productDescription` to allowlisted fields |
| Reset to originally loaded | Client-side reset exists but doesn't specifically handle the new fields | Need to ensure original values are preserved for reset |
| Cost price + suggested sale price | `unitPrice` → cost, `suggestedSalePrice` → sale price. Already implemented. | Already handled. **Note**: Vican Visions cost price comes from template columns H (dollars) + I (cents), combined into a single value |
| Multi-image support | Only single `imageUrls` array exists | Must support 5 images from AliExpress template columns B-F |

## Detailed Implementation Plan

### Phase 2A: AliExpress HTML Parsing Enhancement

**Goal**: Parse AliExpress product pages to extract images, description section, and specifications section separately. Support 5 images.

**Changes needed:**

#### 1. `server/src/enrichment/productDetailsExtractor.ts` — Add AliExpress-specific extraction

- Add `extractAliexpressProductDetails(html: string): AliexpressProductDetails` function
- **Image extraction**: Parse AliExpress product page HTML for image gallery. AliExpress images are typically in:
  - `<img>` tags within `.product-image-carousel` or `.zoom-gallery` containers
  - `data-src` or `src` attributes of image elements
  - JSON embedded in page (e.g., `window.__INITIAL_STATE__` or similar)
  - **Support up to 5 images** (from template columns B-F)
- **Description section extraction**: Find the section with heading "Description" and extract all HTML/text content within it. AliExpress uses `.product-description` or similar selectors.
- **Specifications section extraction**: Find the section with heading "Specifications" and parse the table rows. Each row has a label (e.g., "Brand Name", "Origin", "Number of pieces") and a value. AliExpress uses `.specifications` or `.attributes` tables with `<tr><td>label</td><td>value</td></tr>` structure.
- **Return type**:
```typescript
interface AliexpressProductDetails {
  images: string[];        // Up to 5 product images from gallery
  descriptionHtml: string; // Content from "Description" section
  attributesHtml: string;  // Content from "Specifications" section
  attributeFields: Record<string, string>; // Parsed key-value pairs (Brand Name → value, etc.)
}
```

#### 2. `server/src/types.ts` — Add new fields

- Add `productAttributes: string` — raw HTML/text from Specifications section (editable)
- Add `productDescription: string` — raw HTML/text from Description section (editable)
- Add `aliexpressImages: string[]` — array of up to 5 image URLs extracted from AliExpress page
- Add `originalProductAttributes: string` — snapshot for reset functionality
- Add `originalProductDescription: string` — snapshot for reset functionality
- Add `supplier` field to track which supplier the product belongs to (for WooCommerce/Shopify routing)

#### 3. `server/src/enrichment/sourcePageFetcher.ts` — Integrate AliExpress extraction

- In `fetchProductDetails()`, when source URL is AliExpress, call `extractAliexpressProductDetails()` in addition to `extractProductDetails()`
- Merge results: AliExpress images supplement `imageUrls` (up to 5), description section feeds `productDescription`, specifications feed `productAttributes`
- The `EnrichedProductDetails` type needs `productAttributes` and `productDescription` fields (or a separate extraction path)

### Phase 2B: Database & API Changes

**Goal**: Persist the new fields and make them editable via the API.

**Changes needed:**

#### 1. `server/src/drafts/draftStore.ts` — Schema migration + API support

- Add new columns to `products` table:
  - `product_attributes TEXT NOT NULL DEFAULT ''`
  - `product_description TEXT NOT NULL DEFAULT ''`
  - `aliexpress_images TEXT NOT NULL DEFAULT '[]'` (JSON array, up to 5 entries)
  - `original_attributes TEXT NOT NULL DEFAULT ''` (for reset)
  - `original_description TEXT NOT NULL DEFAULT ''` (for reset)
  - `supplier TEXT NOT NULL DEFAULT 'cellar'` (for WooCommerce/Shopify routing)
- Update `mergeWorkbook()` to handle new fields (preserve app-owned, refresh source-owned)
- Update `updateProduct()` to allow `productAttributes`, `productDescription` in the allowlisted fields
- Add migration SQL for new columns

#### 2. `server/src/routes/imports.ts` — Update allowlist

- Add `productAttributes`, `productDescription`, `aliexpressImages`, `supplier` to the allowlisted fields in the bulk Save and single-product patch endpoints
- The `PATCH /api/drafts/:draftId/products` and `PATCH /api/drafts/:draftId/products/:productId` endpoints need to accept these new fields

### Phase 2C: Client-Side Changes

**Goal**: Display the new fields and provide Save/Reset buttons. Support 5-image gallery.

**Changes needed:**

#### 1. `client/src/App.tsx` — New editor sections

- Add **"Product Description"** section: editable text box (textarea or rich text) showing the extracted description from the "Description" section of the AliExpress page
- Add **"Product Attributes"** section: editable text box showing the extracted specifications from the "Specifications" section
- Add **image gallery** display: show up to 5 extracted AliExpress images (not just the primary image). Column B image is the default main product picture, but user can select any of the 5 as the main image
- **Save button**: Persists `productAttributes`, `productDescription`, `aliexpressImages`, and any edited images to SQLite via `PATCH /api/drafts/:draftId/products`
- **Reset button**: Reverts `productAttributes`, `productDescription` to their original values (`originalAttributes`, `originalDescription`). For images, reverts to the originally loaded set.
- The existing cost price (`unitPrice` — now combined from H dollars + I cents for Vican) and suggested sale price (`suggestedSalePrice`) fields already exist and remain editable

#### 2. `client/src/api.ts` — Update API contract

- Add `productAttributes`, `productDescription`, `aliexpressImages`, `supplier` to the `ProductDraft` type in `api.ts`
- Ensure `PATCH` requests can send these fields in the `changes` object

#### 3. `client/src/App.tsx` — Reset logic

- When Reset button is pressed, restore:
  - `productAttributes` → `originalProductAttributes`
  - `productDescription` → `originalProductDescription`
  - Images → `originalImageUrls`
  - `productAttributes` and `productDescription` are NOT supplier-owned; they are app-owned and preserved across merges
  - The reset should NOT revert `unitPrice` or `suggestedSalePrice` (those are already handled separately)

#### 4. `client/src/App.tsx` — Cost price display for Vican Visions

- When Vican Visions is the active supplier, display cost price as combined dollars + cents (from template columns H + I)
- Ensure the combined value is properly stored and editable

## Files to Modify — VIC-17

| File | Change |
|------|--------|
| `server/src/enrichment/productDetailsExtractor.ts` | Add `extractAliexpressProductDetails()`, `AliexpressProductDetails` interface, image gallery parsing, Description section extraction, Specifications section parsing |
| `server/src/types.ts` | Add `productAttributes`, `productDescription`, `aliexpressImages`, `originalProductAttributes`, `originalProductDescription`, `supplier` to `ProductDraft` |
| `server/src/drafts/draftStore.ts` | Add new columns migration, update merge/save to handle new fields, preserve originals for reset |
| `server/src/enrichment/sourcePageFetcher.ts` | Integrate AliExpress extraction into `fetchProductDetails()`, merge results |
| `server/src/routes/imports.ts` | Add new fields to allowlisted fields in PATCH endpoints |
| `client/src/App.tsx` | Add Product Description and Product Attributes sections, 5-image gallery, Save/Reset buttons, cost price display for Vican |
| `client/src/api.ts` | Add new fields to API types |
| `server/src/logging/logger.ts` | Log enrichment extraction results and failures for new fields |

## Verification for VIC-17

1. **AliExpress HTML parsing**: Load an AliExpress product page HTML → verify images are extracted from the gallery (up to 5), Description section content is separated from Specifications section content
2. **Field separation**: Verify "Brand Name", "Origin", "Number of pieces" appear in attributes, not in description
3. **Save**: Edit `productAttributes` text → Save → verify SQLite stores the edited value, not the original
4. **Reset**: After editing → Reset → verify `productAttributes` and `productDescription` revert to original values
5. **Image gallery**: Verify all 5 AliExpress images appear (not just one), user can select main picture
6. **Cost/Sale price**: Verify `unitPrice` and `suggestedSalePrice` remain editable and functional
7. **Merge preservation**: Load a new workbook → verify `productAttributes` and `productDescription` are preserved (app-owned)
8. **TypeScript**: `npm run typecheck` passes
9. **Build**: `npm run build` succeeds
10. **Thorough testing**: Test each verification item extensively before proceeding to VIC-18

---

# Plan 3: VIC-18 — Core — Supplier Selection

## Ticket Requirements (from Jira)

- **Current implementation**: All screens used for current file loading and Excel template must remain exactly as they function now.
- **New feature**: Supplier dropdown at top of screen with **Apply** button next to it.
- **Selection behavior**: The dropdown selection does NOT execute changes until **Apply** is pressed.
- **Two suppliers**:
  - **Cellar Drive**: Uses current implementation architecture (unchanged), Shopify publishing
  - **Vican Visions**: Uses new changes based on the AliExpress format (VIC-17) and a different Excel template, WooCommerce publishing
- **On Apply**: Screens flip between supplier formats while maintaining persistent states
- **Catalog filtering**: Only show products from active supplier (including product details pane)
- **Stop and ask questions**: The ticket says to stop and ask questions for clarification

## Current State Assessment

| Requirement | Current State | Gap |
|-------------|--------------|-----|
| Supplier dropdown UI | No supplier selector exists. The app currently works with the Cellar/Paramount format only. | Need to add dropdown + Apply button to toolbar |
| Format switching | `transformToStandard()` already has `detectSupplier()` and `CELLAR_MAPPING`/`ALIEXPRESS_MAPPING` | The transformation already works; just needs to be triggered by UI selection |
| Persistent state across switch | When switching suppliers, product data, edits, selections, and filters must be preserved | Current app doesn't have a concept of "switching" — it just loads one catalog |
| Vican Visions format | Uses the AliExpress template (different columns). `detectSupplier()` already identifies AliExpress workbooks. | Need to make the UI aware of the active supplier and adjust display accordingly |
| Apply button semantics | Selection should be stored but not applied until Apply is pressed | Need to store pending supplier selection and only switch format on Apply |
| Platform switching | Cellar uses Shopify, Vican uses WooCommerce | Need platform abstraction to route publishing to correct backend |
| Cost price format | Vican uses columns H (dollars) + I (cents) | Need to combine into single cost price value |
| Image count | Vican has 5 images (columns B-F) | Need to display and manage 5 images in UI |
| Catalog filtering | Currently all products shown | Need to filter by active supplier |

## Detailed Implementation Plan

### Phase 3A: Supplier State Management

**Goal**: Add supplier selection state, pending selection, and apply logic.

**Changes needed:**

#### 1. `client/src/App.tsx` — Add supplier state

- Add `activeSupplier` state: `'cellar' | 'vican' | null` (current active supplier)
- Add `pendingSupplier` state: `'cellar' | 'vican' | null` (selected in dropdown, not yet applied)
- Add `showSupplierDropdown` state: boolean (controls dropdown visibility)
- Add `supplierSwitched` flag: boolean (tracks if a switch has occurred, for reset behavior)
- The `activeSupplier` determines which format is displayed and how workbooks are processed
- Default: `null` or `'cellar'` (if a Cellar workbook is loaded) or auto-detect from loaded workbook
- When Vican Visions is active, filter catalog to show only Vican products; when Cellar is active, show only Cellar products

#### 2. `client/src/App.tsx` — Supplier dropdown UI

- Add a **supplier dropdown** at the top of the screen, in the toolbar area, to the left of or right of the existing toolbar buttons
- Dropdown options: "Cellar Drive", "Vican Visions"
- Add an **Apply** button next to the dropdown
- When a supplier is selected in the dropdown, highlight it but don't change anything until Apply is pressed
- When Apply is pressed:
  - Set `activeSupplier = pendingSupplier`
  - Trigger format switch
  - Filter catalog to show only products from the active supplier
  - Maintain all persistent states (selections, edits, filters, pagination, enrichment data) for the filtered set
  - The screen should visually "flip" to show the appropriate format for the selected supplier
- Add `clear all checked` button still works regardless of supplier
- **Disable** the Apply button when no change has been made in the dropdown

#### 3. `client/src/App.tsx` — Persistent state across switch

When switching suppliers, the following MUST be preserved:
- All product data already in the catalog (edits, enrichment, Shopify/WooCommerce state)
- Selection state (checked rows) — for the active supplier's products
- Filter state (all column filters, sort order)
- Pagination state (current page)
- Dirty-field edits in the browser
- Any unsaved changes
- The catalog itself is NOT re-imported — the switch changes how NEW workbooks are interpreted, not what's already loaded
- Products from the non-active supplier are hidden but not deleted

#### 4. `client/src/api.ts` — Add supplier-related API calls

- No new API endpoints needed for supplier selection itself — it's purely client-side state
- But the import/retrieve endpoints need to be aware of the active supplier
- Add `activeSupplier` to request headers or query params when calling import/retrieve endpoints

### Phase 3B: Server-Side Supplier Awareness

**Goal**: Make the server aware of the active supplier so import and processing respect it. Support WooCommerce for Vican Visions.

**Changes needed:**

#### 1. `server/src/routes/imports.ts` — Supplier-aware import

- Modify `POST /api/imports` handler to accept an optional `supplier` query parameter or in the request body
- If `supplier` is provided, pass it to `transformToStandard()` to override auto-detection
- If no supplier provided, use `detectSupplier()` as before
- Log the supplier used for the import
- Store the supplier on the draft

#### 2. `server/src/imports/transformWorkbook.ts` — Allow supplier override

- Modify `transformToStandard(buffer, forceSupplier?)` to accept an optional supplier override
- When `forceSupplier` is provided, use that mapping instead of `detectSupplier()`
- This allows the client to say "this is a Vican Visions workbook" and get the AliExpress mapping directly
- **For Vican Visions template**: Map columns according to `template_aliexpress_presson1.xlsx` (A=URL, B-F=images, G=title, H=cost dollars, I=cost cents)

#### 3. `server/src/drafts/draftStore.ts` — Supplier context

- Add `supplier` field to `drafts` table: `supplier TEXT NOT NULL DEFAULT 'cellar'`
- When merging a workbook, store the supplier on the draft
- When retrieving products, the supplier context determines which fields are displayed
- Support filtering products by supplier

#### 4. `server/src/config.ts` — Add supplier configuration

- Add `SUPPLIER_CELLAR_WORKBOOK` and `SUPPLIER_VICAN_WORKBOOK` config paths (optional, for default templates)
- Add `defaultSupplier` config key
- Add **WooCommerce configuration** for Vican Visions:
  - `WOOCOMMERCE_SITE_URL`
  - `WOOCOMMERCE_CONSUMER_KEY`
  - `WOOCOMMERCE_CONSUMER_SECRET`
  - WooCommerce API endpoint configuration

### Phase 3C: Vican Visions Format Adaptation

**Goal**: When Vican Visions is selected, the UI and data handling adapt to the AliExpress format with WooCommerce publishing.

**Changes needed:**

#### 1. `client/src/App.tsx` — UI adaptation per supplier

When **Vican Visions** is active:
- The product table shows columns relevant to AliExpress format:
  - 5-product-image gallery (from template columns B-F, user selects main picture)
  - Product attributes (from Specifications)
  - Product description (from Description section)
  - Cost price (combined from H dollars + I cents)
  - Suggested sale price
- The import flow expects the Vican template format (different column layout)
- The "Retrieve source data" button fetches AliExpress product page details
- The editor panel shows AliExpress-specific fields
- The platform for publishing is WooCommerce

When **Cellar Drive** is active:
- Current behavior unchanged
- Product table shows Cellar/Paramount columns
- Import expects Cellar format workbook
- Editor panel shows current fields
- The platform for publishing is Shopify

#### 2. `server/src/imports/standardFormat.ts` — Supplier-aware column display

- Add `getVisibleColumns(supplier)` function that returns which columns to display in the UI
- For Cellar: show current columns (image, key, title, source URL, SOH, case price, unit price, type)
- For Vican: show AliExpress template columns (5 images, attributes, description, cost price (H+I), sale price)
- The `StandardCol` indices remain the same; only the display and interpretation changes

#### 3. `server/src/enrichment/sourcePageFetcher.ts` — Supplier-specific retrieval

- When `activeSupplier === 'vican'`, `fetchProductDetails()` uses AliExpress-specific extraction logic
- When `activeSupplier === 'cellar'`, use existing Paramount extraction logic
- The extraction logic is determined at fetch time based on the product's `sourcePlatform` or the active supplier

#### 4. Platform abstraction for publishing

- **Current**: `server/src/shopify/` contains Shopify-specific publishing
- **New**: Need to abstract publishing to support both Shopify and WooCommerce
- `server/src/platforms/` already has `PlatformClient` interface — extend it for WooCommerce
- When Cellar publishes → Shopify; when Vican publishes → WooCommerce
- Publishing decisions are made per-product based on `supplier` field

### Phase 3D: Apply Button Workflow

**Detailed Apply workflow:**

1. User selects "Vican Visions" from dropdown → dropdown highlights, Apply button becomes enabled
2. User clicks Apply → following happens:
   a. `activeSupplier` state updates to `'vican'`
   b. `supplierSwitched` flag becomes `true`
   c. Client sends `PATCH /api/drafts/current/supplier` (or similar) to persist supplier choice on the draft
   d. The UI re-renders with Vican Visions format:
      - Column headers change
      - Editor panel fields change
      - Catalog filters to show only Vican products
      - Import expects Vican template format
      - Publishing platform switches to WooCommerce
   e. All existing data is preserved (no re-import, no data loss)
   f. If a new workbook is then imported, `transformToStandard()` uses the Vican mapping
3. User can switch back to "Cellar Drive" at any time by repeating the process
4. The **Apply** button is disabled when `pendingSupplier === activeSupplier`

## Files to Modify — VIC-18

| File | Change |
|------|--------|
| `client/src/App.tsx` | Add supplier dropdown, Apply button, supplier state management, persistent state logic, catalog filtering by supplier, UI adaptation per supplier, platform-specific UI |
| `server/src/routes/imports.ts` | Accept supplier override in import, add supplier endpoint, support catalog filtering |
| `server/src/imports/transformWorkbook.ts` | Add `forceSupplier` parameter to `transformToStandard()`, Vican template column mapping |
| `server/src/drafts/draftStore.ts` | Add `supplier` column to drafts table, store supplier on merge, support product filtering by supplier |
| `server/src/imports/standardFormat.ts` | Add `getVisibleColumns(supplier)` function |
| `server/src/enrichment/sourcePageFetcher.ts` | Supplier-specific extraction routing |
| `server/src/config.ts` | Add supplier config keys, WooCommerce configuration |
| `server/src/types.ts` | Add `supplier` to `DraftSummary`, `ProductDraft` |
| `client/src/api.ts` | Add supplier-related API support |
| `server/src/platforms/` | Extend `PlatformClient` interface for WooCommerce support |
| `server/src/config.ts` | Add WooCommerce env variable configuration |

## Verification for VIC-18

1. **Dropdown UI**: Supplier dropdown appears in toolbar with Cellar Drive and Vican Visions options
2. **Apply workflow**: Select Vican Visions → Apply → UI flips to Vican format; select Cellar → Apply → UI flips back
3. **Persistent state**: Switch suppliers → verify all product data, edits, selections, filters, pagination preserved
4. **Catalog filtering**: Only products from active supplier are displayed (including details pane)
5. **Import format**: Load Cellar workbook with Cellar active → correct; Load Vican template with Vican active → correct
6. **Format auto-detection**: Import without specifying supplier → `detectSupplier()` still works
7. **Cost price**: Vican cost price correctly combines dollars + cents from template columns H + I
8. **Image count**: Vican products show 5 images from template columns B-F, user can select main picture
9. **Reset behavior**: Reset page clears transient state but not supplier selection (supplier persists across reset)
10. **Purge behavior**: Purge clears catalog but supplier selection can be re-applied when re-importing
11. **TypeScript**: `npm run typecheck` passes
12. **Build**: `npm run build` succeeds

---

# Cross-Ticket Dependencies and Sequencing

## Dependency Graph

```
VIC-16 (Bugs) ────────────────────────────────────────
  ├── Enhanced logging supports VIC-17 and VIC-18
  ├── Partial retrieval supports VIC-17 (AliExpress extraction)
  └── Productsload UI supports VIC-17 and VIC-18

VIC-17 (AliExpress Spec) ─────────────────────────────
  ├── Depends on VIC-16 #2 (partial retrieval)
  ├── Provides the Vican Visions format that VIC-18 needs
  └── 5-image support feeds VIC-18 image gallery

VIC-18 (Supplier Selection) ──────────────────────────
  ├── Depends on VIC-17 (AliExpress format infrastructure)
  ├── Depends on VIC-16 (logging, retrieval resilience)
  └── Ties everything together with the dropdown UI
```

## Recommended Implementation Order

| Phase | Tickets | Reason |
|-------|---------|--------|
| **1** | VIC-16 | Foundation — logging, partial retrieval, productsload UI. These are prerequisites for VIC-17 and VIC-18. |
| **2** | VIC-17 | Builds on VIC-16's partial retrieval. Creates the AliExpress format infrastructure with 5-image support. |
| **3** | VIC-18 | Highest-level feature. Depends on VIC-17's AliExpress infrastructure and VIC-16's resilience improvements. Includes WooCommerce integration. |

## Shared Changes Across All Three

| Shared Area | Details |
|-------------|---------|
| `server/src/types.ts` | VIC-16 adds `enrichmentPartial`, `failedEnrichmentFields`; VIC-17 adds `productAttributes`, `productDescription`, `aliexpressImages`; VIC-18 adds `supplier` — all need to be consolidated |
| `server/src/drafts/draftStore.ts` | All three tickets add columns and migrations — these must be consolidated into a single migration strategy |
| `server/src/logging/logger.ts` | VIC-16 enhances logging; VIC-17 and VIC-18 benefit from enhanced logging |
| `client/src/App.tsx` | All three tickets modify the client — changes must be merged carefully to avoid conflicts |
| `server/src/enrichment/` | VIC-16 modifies retrieval; VIC-17 adds AliExpress parsing; VIC-18 adds supplier routing |
| `server/src/imports/` | VIC-16 adds productsload endpoint; VIC-17 updates allowlist; VIC-18 adds supplier override |
| Database migrations | All three tickets add columns — must plan a single migration sequence (VIC-16 columns, then VIC-17 columns, then VIC-18 columns) |
| Platform abstraction | VIC-18 introduces WooCommerce alongside Shopify — `server/src/platforms/` needs extending |

---

# Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Single-file App.tsx** becomes unmanageable with all three sets of changes | High — the client is already a single 2000+ line file | Plan a future refactoring into custom hooks/components; for now, add changes carefully with clear section markers |
| **Database migration complexity** — 3 tickets each add columns | Medium — multiple migrations could conflict | Consolidate all column additions into a single migration sequence; apply in dependency order |
| **WooCommerce integration** is new and untested | High — no existing WooCommerce codebase in eComInt | Use `server/src/platforms/` `PlatformClient` interface as foundation; add WooCommerce client alongside Shopify client |
| **AliExpress HTML parsing** is fragile (site structure changes) | High — AliExpress frequently changes its HTML structure | Use multiple extraction strategies (Cheerio selectors, JSON embedded state, structured data); log failures clearly |
| **Supplier switching** could lose state if not carefully implemented | High — the ticket explicitly requires persistent state | Write comprehensive state preservation logic; test switching back and forth multiple times |
| **No automated tests** exist | High — all changes must be validated manually | Follow the existing verification checklist; consider adding basic integration tests as a follow-up |
| **Partial enrichment** could break existing save/publish flows | Medium — changing how enrichment data is stored and merged | Ensure backward compatibility; old products without `enrichmentPartial` default to `false`; new fields have safe defaults |
| **Vican template column mapping** may differ from standard format | Medium — template uses non-standard columns (H=cost dollars, I=cost cents) | Follow the confirmed `template_aliexpress_presson1.xlsx` structure; validate against actual template file |

---

# Next Steps

1. **Review this assessment** and confirm all confirmed answers are correct
2. **Create the three MD plan files** under `plans/`:
   - `plans/VIC-16-bug-fixes-plan.md`
   - `plans/VIC-17-aliexpress-product-page-plan.md`
   - `plans/VIC-18-supplier-selection-plan.md`
3. **Create new Jira ticket** for image fallback (VIC-16 #3 removed from this implementation)
4. **Begin implementation** with VIC-16 Phase 1A (enhanced logging)
5. **Run `npm run typecheck` and `npm run build`** after each phase to verify
6. **Thoroughly test** each section before proceeding to the next
7. **Validate** using the verification checklist for each ticket

---

# Notes

- **Image fallback (VIC-16 #3)** is explicitly excluded from this implementation. A new Jira ticket should be created for it in a future phase.
- **WooCommerce** is a new platform for eComInt. The existing Shopify integration (`server/src/shopify/`) should be extended rather than replaced, using the `server/src/platforms/` abstraction.
- **Vican template** (`template_aliexpress_presson1.xlsx`) is the source of truth for Vican Visions column layout. The actual template file should be reviewed to confirm column mappings.
- **Cost price for Vican Visions** is split across two columns (H=dollars, I=cents) and must be combined into a single value in the database.
