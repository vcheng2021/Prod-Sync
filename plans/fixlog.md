# Fix Log: "40 values for 42 columns" Import Error

## Date
2026-09-07

## Symptom
When selecting/uploading a workbook for import, the server returned `{"error":"40 values for 42 columns"}`. The error originated in `server/src/drafts/draftStore.ts` from the `insertProduct` prepared statement.

## Root Cause
The `INSERT INTO products` SQL statement in `DraftStore.mergeWorkbook()` had an **mismatched column/values count**:

- The **column list** (lines 221–224) listed 42 columns, including `enrichment_partial` and `failed_enrichment_fields` that were previously added to support partial enrichment tracking.
- The **`VALUES` clause** had only 40 `?` placeholders.
- The **`insertProduct.run()` call** passed 42 values (including `product.enrichmentPartial` and `JSON.stringify(product.failedEnrichmentFields)`), but the SQL didn't declare those columns.

`better-sqlite3` validates that the number of `?` placeholders matches the number of columns listed, producing the error "40 values for 42 columns" (42 columns declared but 40 placeholders).

## Changes Made

### `server/src/drafts/draftStore.ts`

| Change | Detail |
|---|---|
| Schema | Added 8 new columns to `CREATE TABLE products`: `enrichment_partial`, `failed_enrichment_fields`, `supplier`, `product_attributes`, `product_description`, `aliexpress_images`, `original_product_attributes`, `original_product_description` |
| Migration | Added `addColumnIfMissing` calls for all 8 new columns (backward-compatible for existing databases) |
| SQL column list | Added `enrichment_partial, failed_enrichment_fields` to the INSERT column list → now 42 columns |
| VALUES clause | Had 42 `?` placeholders (already fixed in previous session; confirmed match) |
| `insertProduct.run()` | Added `product.enrichmentPartial ? 1 : 0, JSON.stringify(product.failedEnrichmentFields ?? []),` between `enrichmentFetchedAt` and `selected` → now 42 values |
| `saveEnrichment` | Updated signature to accept optional `enrichmentPartial` and `failedFields`; updated UPDATE SQL and `.run()` to persist these fields |
| `toProduct()` | Added mappings for all 8 new columns from `ProductRow` to `ProductDraft` |
| `toSummary()` | Added `supplier: products[0]?.supplier ?? 'cellar'` field |
| `ProductRow` type | Added 8 new fields: `enrichment_partial`, `failed_enrichment_fields`, `supplier`, `product_attributes`, `product_description`, `aliexpress_images`, `original_product_attributes`, `original_product_description` |

### `server/src/routes/imports.ts`
- Removed 4 debug `console.log` statements from the import route handler.

### `server/src/imports/xlsxParser.ts`
- Removed 3 debug `console.log` statements from `parseWorkbook()`.

## Verification
- `npm run typecheck` passes with zero TypeScript errors.
- Server starts successfully and `/api/health` returns `{"ok":true,"version":"0.1.0"}`.
- Import of `suppliers/sup2_paramountliquor.xlsx` no longer throws the column count error.

## Notes
- The 8 new columns (`enrichment_partial`, `failed_enrichment_fields`, `supplier`, `product_attributes`, `product_description`, `aliexpress_images`, `original_product_attributes`, `original_product_description`) were pre-defined in `server/src/types.ts` (`ProductDraft` interface) but never had corresponding database columns. The fix completes the schema-to-type alignment.
- All columns use appropriate defaults (`INTEGER NOT NULL DEFAULT 0` for booleans, `TEXT NOT NULL DEFAULT ''` for strings, `TEXT NOT NULL DEFAULT '[]'` for JSON arrays) so existing rows and new inserts work without providing these values.
