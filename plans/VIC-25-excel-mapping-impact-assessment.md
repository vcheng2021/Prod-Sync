# VIC-25: eComInt Excel Mapping — Impact Assessment & Implementation Plan

## Jira Ticket Summary

**Ticket:** VIC-25 (Bug) | **Project:** Vican Kanban | **Status:** To Do | **Priority:** Medium
**Reporter:** Vican | **Created:** 2026-09-12

**Request:** Remap the import spreadsheet column layout for "vican aliexpress" to a new standard template (`aliexpress_presson_template.xlsx`), adding fields for product/sub category, brand (from workbook), and stock, while reducing image columns from 8 to 5 and removing fragmented cost-price columns.

### New VIC-25 Column Mapping

| Native Col | Index | New Meaning |
|---|---|---|
| A | 0 | SourceURI (identity key) |
| B | 1 | ImageA |
| C | 2 | ImageB |
| D | 3 | ImageC |
| E | 4 | ImageD |
| F | 5 | ImageE |
| G | 6 | AttribA → Product Category |
| H | 7 | AttribB → Sub Category |
| I | 8 | AttribC |
| J | 9 | Title |
| K | 10 | PriceA |
| L | 11 | Decimal |
| M | 12 | PriceB |
| N | 13 | Brand |
| O | 14 | Stock |
| P | 15 | AttribD (TBA) |

### Current AliExpress Column Mapping (backward compatibility required)

| Native Col | Index | Current Meaning |
|---|---|---|
| A | 0 | Source/product URL (identity key) |
| B–I | 1–8 | 8 image columns |
| J | 9 | Title |
| K/L/M | 10–12 | Fragmented price |
| H | 7 | Cost dollars |
| I | 8 | Cost cents |

### Acceptance Criteria

- Database fields changed to reflect new column names/fields
- No breakage in links or relationships in database
- Application works 100% with new mappings
- Excel import of vican aliexpress loads to required fields and runs and features with no errors
- Cellar and Vican suppliers still function as expected, 100%
- **Existing Excel files (old AliExpress layout) must still import with no impact to functionality or UI**

---

## Key Design Decision: Dual-Layout Detection

**The implementation must support BOTH the old AliExpress layout (8 images, B-I) and the new VIC-25 layout (5 images, B-F) within the same `vican`/`aliexpress` supplier.**

This is achieved by:
1. **Keeping** `ALIEXPRESS_MAPPING` (old layout) as-is for backward compatibility
2. **Adding** `ALIEXPRESS_VIC25_MAPPING` (new VIC-25 layout) as a new mapping constant
3. **Detecting** which layout is in use by examining workbook header names (e.g., "SourceURI", "ImageA" indicate the new VIC-25 template)
4. **Selecting** the appropriate mapping in `getSupplierMapping()` in `transformWorkbook.ts`

This approach means existing Excel files continue to work unchanged, and new VIC-25 template files use the new column layout. No data migration is required for existing products — new fields default to empty strings.

---

## Impact Assessment

### Architecture: Three-Layer Column Mapping System

The eComInt codebase uses a three-layer column mapping architecture:

1. **Native supplier columns** → `server/src/imports/supplierConfig.ts` `SupplierMapping` objects
2. **Standard 18-column format** → `server/src/imports/standardFormat.ts` (`STANDARD_HEADERS`, `StandardCol`)
3. **Internal `ProductDraft` model** → `server/src/types.ts`

**Pipeline:** `imports.ts` route → `transformWorkbook.ts` (native→standard) → `xlsxParser.ts` (standard→ProductDraft[]) → `draftStore.ts` (SQLite merge)

### Scope of Impact

**Files affected (15 total):**
- **Critical:** `standardFormat.ts`, `supplierConfig.ts`, `transformWorkbook.ts`, `xlsxParser.ts`, `types.ts`, `draftStore.ts`
- **High:** `woocommercePublisher.ts`, `sourcePageFetcher.ts` (enrichment brand preservation)
- **Medium:** `excelExporter.ts`, `App.tsx` (client UI), `authRouter.ts`
- **Low:** `ARCHITECTURE.md`, `SUPPORT.md`, `CHANGELOG.md`

### Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Breaking Cellar import | Low | Critical | Cellar uses separate `CELLAR_MAPPING`. Standard format changes are additive (new columns at end). Cellar mapping only touches indices 0–17. |
| Database migration failure | Low | High | Use `addColumnIfMissing` — idempotent, backward-compatible. Existing products get default empty-string values. |
| Breaking old AliExpress import | **RESOLVED** | N/A | Dual-layout detection: `detectAliExpressLayout()` checks headers. Old workbooks use `ALIEXPRESS_MAPPING`, new ones use `ALIEXPRESS_VIC25_MAPPING`. |
| Brand field ownership conflict | Medium | Medium | Supplier-conditional: AliExpress brand from workbook = supplier-owned; enrichment preserves workbook brand. Cellar brand = enrichment-owned. |
| Cost price for new AliExpress | Medium | Low | `costPrice = null` for new format; WC publisher falls back to `unitPrice`: `(product.costPrice ?? product.unitPrice ?? 0)`. |
| Enrichment overwriting workbook brand | Medium | Medium | `saveEnrichment()` checks supplier — for AliExpress with non-empty workbook brand, preserves it. |
| UI breakage for old products | Low | Low | New fields default to empty string; UI only shows them when populated. No visible change for old products. |

---

## Implementation Plan

### Phase 1: Extend Standard Format (`server/src/imports/standardFormat.ts`)

Add 5 new standard columns at indices 18–22:

```
S (18) = 'product_category'  // AttribA / Column G
T (19) = 'sub_category'      // AttribB / Column H
U (20) = 'attrib_c'          // AttribC / Column I
V (21) = 'brand_workbook'    // Brand / Column N
W (22) = 'attrib_d'          // AttribD / Column P
```

Update `STANDARD_HEADERS` array (now 23 entries), `STANDARD_COLUMN_COUNT`, and `StandardCol` constants. Cost-dollars (Q, 16) and cost-cents (R, 17) remain for backward compatibility with old AliExpress imports.

### Phase 2: Update Supplier Mapping (`server/src/imports/supplierConfig.ts`)

**Extend `SupplierMapping` interface** with 5 new optional fields:
- `productCategoryColumn: number | null`
- `subCategoryColumn: number | null`
- `attribCColumn: number | null`
- `brandColumn: number | null`
- `attribDColumn: number | null`

**Add `ALIEXPRESS_VIC25_MAPPING`** (new layout) — separate constant, NOT replacing `ALIEXPRESS_MAPPING`:
- `imageColumns: [1, 2, 3, 4, 5, -1, -1, -1]` (B-F = 5 images)
- `sourceUrlColumn: 0` (A = SourceURI)
- `titleColumn: 9` (J = Title)
- `sohColumn: 14` (O = Stock)
- `casePriceColumn: null`
- `unitPriceColumn: null` (reconstructed from K/L/M)
- `typeColumn: null`
- `productCategoryColumn: 6` (G)
- `subCategoryColumn: 7` (H)
- `attribCColumn: 8` (I)
- `brandColumn: 13` (N)
- `attribDColumn: 15` (P)

**Update `CELLAR_MAPPING`** to include new optional fields (all `null`).

**Add `detectAliExpressLayout()`** function that examines headers to determine which AliExpress layout is in use:
- If headers contain "SourceURI" or "ImageA" → return the VIC-25 layout mapping
- Otherwise → return the legacy AliExpress mapping

**Update `SUPPLIER_MAPPINGS`** to include both mappings, with `getSupplierMapping()` selecting the right one based on header detection.

### Phase 3: Update Transformation (`server/src/imports/transformWorkbook.ts`)

**Update `getSupplierMapping()`** to use `detectAliExpressLayout()` for AliExpress/Vican suppliers.

**Add extraction for 5 new standard columns** using the extended `SupplierMapping`:
```typescript
// For VIC-25 layout only:
if (mapping.productCategoryColumn !== null) {
  standardValues[StandardCol.PRODUCT_CATEGORY] = nativeValue(nativeRow, mapping.productCategoryColumn);
}
// ...repeat for sub_category, attrib_c, brand_workbook, attrib_d
```

**No change to `reconstructUnitPrice()`** — it already reads native columns K/L/M (indices 10–12) which are PriceA/Decimal/PriceB in the new layout.

**Cost price extraction**: For the VIC-25 layout, do NOT extract cost-dollars/cost-cents (native H/I are now Sub Category and AttribC). The existing `COST_DOLLARS`/`COST_CENTS` extraction (lines 141-144) should only run for the legacy AliExpress layout.

### Phase 4: Update Parser (`server/src/imports/xlsxParser.ts`)

**Add extraction of new fields** from new standard column indices:
```typescript
const productCategory = textValue(valueAt(row, StandardCol.PRODUCT_CATEGORY));
const subCategory = textValue(valueAt(row, StandardCol.SUB_CATEGORY));
const attribC = textValue(valueAt(row, StandardCol.ATTRIB_C));
const brandFromWorkbook = textValue(valueAt(row, StandardCol.BRAND_WORKBOOK));
const attribD = textValue(valueAt(row, StandardCol.ATTRIB_D));
```

**Add new fields to `ProductDraft` construction** — they default to empty strings for old-format imports (since those standard columns will be empty).

**Validation messages**: Current messages reference standard column letters (J, K, O, L, M, N, A). The standard format keeps the same indices for existing columns, so no changes needed. New fields don't have validation requirements per acceptance criteria.

### Phase 5: Update Types (`server/src/types.ts`)

Add to `ProductDraft` interface:
- `productCategory: string`
- `subCategory: string`
- `attribC: string`
- `attribD: string`

Add to `EnrichedProductDetails` (optional):
- `productCategory?: string`
- `subCategory?: string`

### Phase 6: Update DraftStore (`server/src/drafts/draftStore.ts`)

**Schema**: Add 4 new columns via `addColumnIfMissing` (idempotent migrations):
- `product_category TEXT NOT NULL DEFAULT ''`
- `sub_category TEXT NOT NULL DEFAULT ''`
- `attrib_c TEXT NOT NULL DEFAULT ''`
- `attrib_d TEXT NOT NULL DEFAULT ''`

Also add to CREATE TABLE for new databases.

**Insert**: Add 4 new columns to `insertProduct` SQL statement (after existing columns).

**Merge UPDATE**: Add new columns to the `updateProduct` statement in `mergeWorkbook()`. These are supplier-owned for AliExpress (refreshed on merge). For AliExpress, `brand` should be refreshed from workbook (`product.brand`) when it's non-empty. For Cellar, `brand` remains preserved from enrichment.

**Merge logic for Brand**: In `mergeWorkbook()`, the current code preserves `existing.brand` for all suppliers:
```typescript
existing.brand, existing.country, existing.region, existing.product_type, ...
```
Change to: for AliExpress, use `product.brand` (from workbook); for Cellar, use `existing.brand` (from enrichment).

**Allowlist** (`updateProducts` `columns` map): Add new fields:
- `productCategory: 'product_category'`
- `subCategory: 'sub_category'`
- `attribC: 'attrib_c'`
- `attribD: 'attrib_d'`

**Fingerprint** (`supplierFingerprint()`): Add new fields for duplicate detection.

**ToProduct**: Map 4 new DB columns to ProductDraft fields.

**SaveEnrichment**: For AliExpress, do NOT overwrite the workbook-supplied `brand`. Check `product.supplier === 'vican'` or `'aliexpress'` — if the product already has a brand from the workbook, preserve it.

**ProductRow type**: Add 4 new fields.

### Phase 7: Update WooCommerce Publisher (`server/src/platforms/woocommercePublisher.ts`)

- **Cost price fallback**: Change `(product.costPrice ?? 0)` → `(product.costPrice ?? product.unitPrice ?? 0)` (line 446)
- **New meta_data fields**: Add `product_category`, `sub_category`, `attrib_c`, `attrib_d` to `meta_data` array
- **Brand**: Already used in `buildTags()` — now sourced from workbook for AliExpress VIC-25 imports
- **Product category/subcategory**: Could optionally map to WooCommerce categories (currently uses `globalCategoryIds` from config)

### Phase 8: Update Source Fetcher (`server/src/enrichment/sourcePageFetcher.ts`)

In `saveEnrichment()` (draftStore.ts, not sourcePageFetcher.ts):
- For AliExpress VIC-25 products with non-empty `brand` from workbook, preserve it during enrichment
- The `sourcePageFetcher.ts` itself extracts brand from HTML — this value should be used as fallback only

### Phase 9: Update Excel Exporter (`server/src/exports/excelExporter.ts`)

Add to `productToRow()`:
- `Product Category`: product.productCategory
- `Sub Category`: product.subCategory
- `AttribC`: product.attribC
- `AttribD`: product.attribD

### Phase 10: Update Client (`client/src/App.tsx`)

**Update mapping strip** (line 1514–1533): Detect which VIC-25 layout is active and show appropriate column mapping. Since both old and new layouts use supplier='vican', the mapping strip should show both possible layouts or detect based on loaded data.

**Add editable fields in editor panel**: For Vican products, show:
- `Product Category` — read-only (supplier-owned, from workbook)
- `Sub Category` — read-only (supplier-owned, from workbook)
- `Brand` — read-only for AliExpress with workbook-supplied brand (supplier-owned)
- `AttribC` — read-only or editable
- `AttribD` — read-only or editable

These fields display empty ("—") for old products and show values for new VIC-25 imports.

### Phase 11: Update Documentation

- **`docs/ARCHITECTURE.md`**: Update §4 (field ownership — Brand supplier-owned for AliExpress), column mapping table (add new columns), §6 (standard column reference)
- **`docs/SUPPORT.md`**: Update §7 (workbook import/merge) with new column descriptions
- **`CHANGELOG.md`**: Add VIC-25 entry documenting the dual-layout support

---

## Verification Plan

### Code-level checks
1. `npm run typecheck` — TypeScript compiles for server + client
2. `npm run build` — Production build succeeds
3. Verify `STANDARD_HEADERS` has 23 entries, `STANDARD_COLUMN_COUNT = 23`
4. Verify `SupplierMapping` interface has all new optional fields
5. Verify both `ALIEXPRESS_MAPPING` (legacy) and `ALIEXPRESS_VIC25_MAPPING` (new) exist
6. Verify `detectAliExpressLayout()` correctly distinguishes old vs new templates

### End-to-end verification
1. **Cellar import** (regression): Import `sup2_paramountliquor.xlsx` — verify no behavior changes
2. **Old AliExpress import** (backward compat regression): Import existing Vican workbook (8-image layout) — verify products import correctly with same fields as before
3. **New VIC-25 import**: Import `aliexpress_presson_template.xlsx` — verify:
   - SourceURI used as identity key
   - 5 images (B-F) mapped to `imageUrls` and `aliexpressImages`
   - Product Category, Sub Category, Brand, AttribC, AttribD populated from workbook
   - Price reconstructed from K/L/M
   - Stock mapped from column O
4. **Merge/preserve**: Re-import same workbook — verify correct counts. Modify app-owned field between imports — verify preserved.
5. **Cross-layout merge**: Import new-format workbook, then old-format workbook (and vice versa) — verify merge works correctly by identity key
6. **Enrichment**: Retrieve source data for both old and new products — verify workbook brand preserved for new VIC-25 products; enrichment brand used for old products
7. **WooCommerce publish**: Publish products from both old and new formats — verify meta_data includes new fields (empty for old), images work, cost falls back to unit price
8. **Export**: Export to XLSX — verify new fields included (empty for old products)
9. **Database backward compat**: Existing DB with old schema — verify migrations run cleanly, new columns added with defaults
10. **UI regression**: Verify Cellar, old Vican, and new Vican products all display correctly in the editor panel
11. **Docker**: `docker build && docker compose up` — health check passes

### Test commands
```powershell
# Full stack typecheck + build
npm run typecheck
npm run build

# Local dev
./start.ps1
# Import Cellar → verify no regressions
# Import old AliExpress template → verify same behavior
# Import VIC-25 template → verify new fields
# Edit, save, publish → verify
# ./stop.ps1

# Docker
docker build -t ecomint:latest .
docker compose up -d --build
Invoke-WebRequest http://localhost:8787/api/health
```

---

## Open Decisions (Resolved)

1. **Dual layout support** — Implemented via header detection (`detectAliExpressLayout()`). `ALIEXPRESS_MAPPING` (old) and `ALIEXPRESS_VIC25_MAPPING` (new) coexist. No breaking changes to existing imports.

2. **AttribC and AttribD semantics** — Stored as raw string fields (`attribC`, `attribD`). Not sent to platforms yet. AttribC could optionally map to `productType` in the future.

3. **Cost price** — `null` for new VIC-25 imports (no cost-dollars/cents columns). WooCommerce publisher falls back to `unitPrice`. Legacy AliExpress imports continue to use cost from H/I.

4. **Brand ownership** — For AliExpress VIC-25 with workbook-supplied brand: supplier-owned (refreshed on merge). For legacy AliExpress and Cellar: enrichment-owned (preserved on merge). `saveEnrichment` preserves workbook brand.

5. **Supplier ID** — No new supplier type. Existing `'vican'`/`'aliexpress'` uses layout detection at import time. Supplier dropdown and all downstream logic unchanged.

6. **Image count difference** — Old layout: 8 images (B-I). New layout: 5 images (B-F). Standard format still has 8 image columns (IMAGE_1–8); new layout simply leaves IMAGE_6–8 empty. UI image gallery works for both.
