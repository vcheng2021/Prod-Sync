# VIC-17 — AliExpress Product Page Spec: Implementation Plan

## Overview

VIC-17 defines how AliExpress product data is extracted and displayed: product images (5 from template columns B-F), product description (from "Description" section), product attributes (from "Specifications" section), and cost price + suggested sale price. Save persists to SQLite, Reset reverts to original values.

**Jira Reference**: [VIC-17](https://vicandev1979.atlassian.net/browse/VIC-17)
**Status**: To Do | **Priority**: Medium
**Sample URLs**: `aliexpress.com/item/1005010420188480.html`, `aliexpress.com/item/1005008188148384.html`

---

## Requirements

- Product images on the top left → extract up to 5 images
- Product description on top middle → editable "Product Description" text box
- Product specifications → editable "Product Attributes" text box
- Save button persists to SQLite DB
- Reset button reverts to originally loaded item
- Cost price and suggested sale price (editable)
- Column B is the default main product picture, but user can select any of the 5

---

## Current State → Target State (Inline Changes)

### 1. `server/src/types.ts` — New Fields

**Current State**: `ProductDraft` has `descriptionHtml`, `brand`, `country`, `region`, `productType`, `abv`, `containerType`, `style`. No `productAttributes`, `productDescription`, `aliexpressImages`, `originalProductAttributes`, `originalProductDescription`, or `supplier` fields.

**Target State**:

```typescript
// Added to ProductDraft:
productAttributes: string;      // Raw HTML/text from Specifications section (editable)
productDescription: string;     // Raw HTML/text from Description section (editable)
aliexpressImages: string[];     // Up to 5 image URLs from AliExpress page
originalProductAttributes: string;  // Snapshot for reset functionality
originalProductDescription: string; // Snapshot for reset functionality
supplier: string;               // 'cellar' | 'aliexpress' | 'paramount' — for WooCommerce/Shopify routing
```

**Change from existing**: 
- `descriptionHtml` is the existing general description field (from enrichment)
- `productDescription` is specifically the content from the AliExpress "Description" section
- `productAttributes` is specifically the content from the AliExpress "Specifications" section
- `descriptionHtml` and `productDescription` may overlap — `productDescription` is a more specific field for the AliExpress use case
- `originalProductAttributes` and `originalProductDescription` are snapshots set at retrieval time for reset
- `supplier` determines publishing platform (Shopify for Cellar, WooCommerce for AliExpress/Vican)

### 2. `server/src/enrichment/productDetailsExtractor.ts` — AliExpress-Specific Extraction

**Current State**: `extractProductDetails()` parses brand, country, region, productType, abv, containerType, style from HTML using multiple selectors. `extractSupplierProductDetails()` parses `SupplierProductPayload` from JSON catalog.

**Target State**: Add `extractAliexpressProductDetails()` that specifically extracts:
- **Image gallery**: Up to 5 images from AliExpress HTML
- **Description section**: Content from the "Description" section of the page
- **Specifications section**: Content from the "Specifications" section, parsed into key-value pairs

```typescript
interface AliexpressProductDetails {
  images: string[];                 // Up to 5 product images from gallery
  descriptionHtml: string;          // Content from "Description" section
  attributesHtml: string;           // Content from "Specifications" section
  attributeFields: Record<string, string>; // Parsed key-value pairs (Brand Name → value, etc.)
}
```

**Change from existing**: The existing `extractProductDetails()` continues to work for Paramount/Cellar. The new `extractAliexpressProductDetails()` is AliExpress-specific. Both functions coexist — the caller routes based on source platform.

**Image extraction strategy**: AliExpress images are typically in `<img>` tags within `.product-image-carousel` or `.zoom-gallery` containers, `data-src` attributes, or embedded JSON (`window.__INITIAL_STATE__`). Multiple extraction strategies are used with fallback.

**Specifications extraction strategy**: Find the section with heading "Specifications" and parse `<tr><td>label</td><td>value</td></tr>` rows. Common fields: Brand Name, Origin, Number of pieces. Each product has a different table format, so the parser must be flexible.

### 3. `server/src/enrichment/sourcePageFetcher.ts` — AliExpress Integration

**Current State**: `fetchProductDetails()` tries supplier catalog/JSON endpoints, then falls back to HTML parsing with `extractProductDetails()`. Returns `FetchResult` with `EnrichedProductDetails`.

**Target State**: When source URL is AliExpress, call `extractAliexpressProductDetails()` and merge results.

```typescript
// In fetchProductDetails():
// After HTML fetch:
const htmlDetails = extractProductDetails(html);           // existing Paramount extraction
const aliexpressDetails = extractAliexpressProductDetails(html); // NEW: AliExpress extraction

// Merge: AliExpress images supplement imageUrls
// AliExpress description feeds productDescription
// AliExpress specifications feed productAttributes
```

**Change from existing**: The existing `fetchProductDetails()` return structure is extended with `productAttributes`, `productDescription`, and `aliexpressImages`. These are populated when the source URL is AliExpress. For Paramount, they remain empty strings/arrays.

### 4. `server/src/drafts/draftStore.ts` — Schema Migration + API Support

**Current State**: `products` table has: `description_html`, `brand`, `country`, `region`, `product_type`, `supplier_type`, `source_platform`, `abv`, `container_type`, `style`, `enrichment_status`, `enrichment_error`. `mergeWorkbook()` and `updateProduct()` handle these fields.

**Target State**: Add new columns and update insert/update logic.

```sql
-- New columns (via addColumnIfMissing):
ALTER TABLE products ADD COLUMN product_attributes TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN product_description TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN aliexpress_images TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN original_attributes TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN original_description TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN supplier TEXT NOT NULL DEFAULT 'cellar';
```

**Changes to `mergeWorkbook()`**:
- Add new fields to `insertProduct.run()` and `updateProduct.run()` parameter lists
- Preserve `productAttributes`, `productDescription`, `aliexpressImages` across merges (app-owned)
- `supplier` is refreshed from workbook merge (source-owned)
- `originalAttributes` and `originalDescription` are set at retrieval time, NOT during merge

**Changes to `updateProduct()`**:
- Add `productAttributes`, `productDescription`, `aliexpressImages` to allowlisted fields
- `originalAttributes` and `originalDescription` are NOT editable via PATCH (they're reset references)

**Changes to `getDraft()` / serialization**: Include new fields in the response.

### 5. `server/src/routes/imports.ts` — Allowlist Update

**Current State**: `PATCH /api/drafts/:draftId/products` and `PATCH /api/drafts/:draftId/products/:productId` accept a subset of `ProductDraft` fields based on an allowlist.

**Target State**: Add `productAttributes`, `productDescription`, `aliexpressImages`, `supplier` to the allowlist.

### 6. `client/src/App.tsx` — New Editor Sections & Image Gallery

**Current State**: The client displays product fields in a single-panel layout. No Product Description, Product Attributes, or image gallery sections exist.

**Target State**: Add new UI sections when an AliExpress product is selected.

**New UI Sections**:

#### Product Description Section
- Editable textarea showing `productDescription` content
- Changes are staged in dirty-field map (keyed by product ID)
- Save persists to SQLite via `PATCH /api/drafts/:draftId/products`

#### Product Attributes Section
- Editable textarea showing `productAttributes` content
- Displays extracted specifications (Brand Name, Origin, Number of pieces, etc.)
- Changes are staged in dirty-field map
- Save persists to SQLite via `PATCH /api/drafts/:draftId/products`

#### Image Gallery
- Display up to 5 images from `aliexpressImages`
- Column B image is the **default main product picture**
- User can click any image to set it as the main picture
- Visual indicator showing which image is currently the main picture
- Changes are staged in dirty-field map

#### Save Button
- Persists `productAttributes`, `productDescription`, `aliexpressImages` (including main image selection) to SQLite via `PATCH /api/drafts/:draftId/products`
- Uses the existing bulk save mechanism

#### Reset Button
- Reverts `productAttributes` → `originalProductAttributes`
- Reverts `productDescription` → `originalProductDescription`
- Reverts images → original `imageUrls` (with column B as default)
- `originalAttributes` and `originalDescription` are NOT supplier-owned — they are app-owned and preserved across merges
- Reset should NOT revert `unitPrice` or `suggestedSalePrice` (already handled separately)

#### Cost Price Display for Vican Visions
- When AliExpress/Vican is the active supplier, display cost price as combined value
- Cost price = H (dollars) + I (cents) from the template format
- The combined value is editable

### 7. `client/src/api.ts` — Updated API Contract

**Current State**: `ProductDraft` type includes existing fields. `PATCH` changes accept a subset of fields.

**Target State**: Add `productAttributes`, `productDescription`, `aliexpressImages`, `supplier` to the API type.

### 8. `server/src/logging/logger.ts` — Enrichment Extraction Logging

**Current State**: `logger.writeEnrichmentEvent()` method is added in VIC-16.

**Target State**: Use `writeEnrichmentEvent()` to log AliExpress-specific extraction results and failures (e.g., "Specifications section not found for URL X").

---

## Files to Modify

| File | Change | Notes |
|------|--------|-------|
| `server/src/types.ts` | Add `productAttributes`, `productDescription`, `aliexpressImages`, `originalProductAttributes`, `originalProductDescription`, `supplier` to `ProductDraft` | New fields with safe defaults |
| `server/src/enrichment/productDetailsExtractor.ts` | Add `extractAliexpressProductDetails()`, `AliexpressProductDetails` interface | NEW function — existing code unchanged |
| `server/src/enrichment/sourcePageFetcher.ts` | Route AliExpress URLs to `extractAliexpressProductDetails()`, merge results | Extends `fetchProductDetails()` |
| `server/src/drafts/draftStore.ts` | Add 6 new columns migration, update `mergeWorkbook()`, `updateProduct()`, `getDraft()` | Uses `addColumnIfMissing()` pattern |
| `server/src/routes/imports.ts` | Add `productAttributes`, `productDescription`, `aliexpressImages`, `supplier` to allowlist | Extend existing allowlist |
| `client/src/App.tsx` | Add Product Description section, Product Attributes section, 5-image gallery, main image selection (column B default), Save/Reset buttons, cost price display for Vican | Major UI addition |
| `client/src/api.ts` | Add new fields to API types | Extend existing types |
| `server/src/logging/logger.ts` | Log enrichment extraction results/failures for new fields | Uses VIC-16 `writeEnrichmentEvent()` |

---

## Verification Checklist

1. **AliExpress HTML parsing**: Load an AliExpress product page → verify images (up to 5) are extracted, Description section content is separated from Specifications section content
2. **Field separation**: Verify "Brand Name", "Origin", "Number of pieces" appear in attributes, not in description
3. **Default main image**: Column B image is displayed as default main product picture
4. **Image selection**: User can click any of the 5 images to set as main picture
5. **Save**: Edit `productAttributes` text → Save → verify SQLite stores the edited value, not the original
6. **Reset**: After editing → Reset → verify `productAttributes` and `productDescription` revert to original values
7. **Cost price**: Vican cost price correctly combines dollars + cents from template
8. **Merge preservation**: Load a new workbook → verify `productAttributes` and `productDescription` are preserved (app-owned)
9. **TypeScript**: `npm run typecheck` passes
10. **Build**: `npm run build` succeeds
11. **Thorough testing**: Each verification item tested extensively before proceeding to VIC-18

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| AliExpress HTML parsing is fragile (site structure changes) | High | Use multiple extraction strategies (Cheerio selectors, JSON embedded state, structured data); log failures clearly via `writeEnrichmentEvent()` |
| `productAttributes`/`productDescription` overlap with `descriptionHtml` | Medium | `descriptionHtml` remains for existing enrichment; `productDescription` is the AliExpress-specific field; both can coexist |
| Reset logic might revert unsaved edits | Medium | `originalProductAttributes`/`originalProductDescription` are set at retrieval time; edits are staged separately in dirty-field map; Reset only reverts original values |
| 5-image gallery adds complexity to UI | Medium | Gallery is a separate section; existing single-image display still works for Cellar |
