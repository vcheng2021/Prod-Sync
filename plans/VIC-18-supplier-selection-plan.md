# VIC-18 — Core: Supplier Selection: Implementation Plan

## Overview

VIC-18 adds a supplier dropdown at the top of the screen with an Apply button. Two suppliers: Cellar Drive (current Shopify implementation) and Vican Visions (AliExpress format with WooCommerce publishing). On Apply, screens flip between supplier formats while maintaining persistent states. Only products from the active supplier are displayed.

**Jira Reference**: [VIC-18](https://vicandev1979.atlassian.net/browse/VIC-18)
**Status**: To Do | **Priority**: Medium
**Confirmed**: Vican Visions uses **WooCommerce** (not Shopify). Template: `template_aliexpress_presson1.xlsx` (Column A=URL, B-F=5 images, G=title, H=cost dollars, I=cost cents).

---

## Requirements

- Supplier dropdown at top of screen with Apply button
- Dropdown selection does NOT execute changes until Apply is pressed
- Two suppliers: Cellar Drive (Shopify), Vican Visions (WooCommerce)
- On Apply: screens flip between supplier formats while maintaining persistent states
- Catalog filtering: only show products from active supplier (including product details pane)
- Vican Visions uses AliExpress template format (different columns)
- Cost price for Vican: columns H (dollars) + I (cents) combined

---

## Current State → Target State (Inline Changes)

### 1. `client/src/App.tsx` — Supplier State Management & Dropdown UI

**Current State**: The app works with a single supplier format (Cellar/Paramount). No supplier selector exists. The toolbar has toolbar buttons but no dropdown. All products are displayed regardless of supplier.

**Target State**: Add supplier state, dropdown, Apply button, and catalog filtering.

#### New State Variables

```typescript
// NEW STATE (added to existing App.tsx state):
const [activeSupplier, setActiveSupplier] = useState<'cellar' | 'vican' | null>(null);
const [pendingSupplier, setPendingSupplier] = useState<'cellar' | 'vican' | null>(null);
const [supplierDropdownOpen, setSupplierDropdownOpen] = useState(false);
```

**Change from existing**: 
- `activeSupplier` determines which format is displayed and how products are filtered
- `pendingSupplier` is the dropdown selection before Apply is pressed
- Default: `null` if no catalog loaded, or auto-detected from loaded workbook
- When `activeSupplier === 'cellar'`, show all Cellar products
- When `activeSupplier === 'vican'`, show only Vican products
- When `activeSupplier === null` (initial), show all products or none (based on current behavior)

#### Supplier Dropdown UI

**Location**: Top of screen, in the toolbar area, to the left of or right of existing toolbar buttons

**Components**:
- **Dropdown button**: Shows current active supplier or "Select Supplier"
- **Dropdown menu**: Options "Cellar Drive" and "Vican Visions"
- **Apply button**: Enabled when `pendingSupplier !== activeSupplier`, disabled when they match
- Clicking a dropdown option sets `pendingSupplier` and highlights it — NO format change until Apply

**Change from existing**: The existing toolbar buttons (filter, sort, etc.) remain unchanged. The dropdown and Apply button are added alongside them.

#### Apply Button Workflow

```
User selects "Vican Visions" from dropdown → pendingSupplier = 'vican'
Apply button becomes enabled (pendingSupplier !== activeSupplier)
User clicks Apply → following happens:
  a. activeSupplier = pendingSupplier (set to 'vican')
  b. Catalog filters to show only Vican products
  c. UI re-renders with Vican format (column headers, editor fields, import flow)
  d. All existing data preserved (no re-import, no data loss)
  e. Product details pane shows Vican-specific fields
Apply button disabled when pendingSupplier === activeSupplier
```

**Change from existing**: Current toolbar has no Apply concept. The Apply button is NEW. All existing toolbar functionality (filter, sort, pagination) continues to work and is preserved across supplier switches.

#### Persistent State Across Supplier Switch

When switching suppliers, the following MUST be preserved:
- All product data already in the catalog (edits, enrichment, Shopify/WooCommerce state)
- Selection state (checked rows) for the active supplier's products
- Filter state (all column filters, sort order)
- Pagination state (current page)
- Dirty-field edits in the browser
- Any unsaved changes
- The catalog itself is NOT re-imported — the switch changes how NEW workbooks are interpreted, not what's already loaded

**Change from existing**: Currently there's no concept of "switching" — the app just loads one catalog. The new state management adds a filtering layer on top of the existing catalog. Products from the non-active supplier are hidden but NOT deleted from the database.

#### Catalog Filtering

**Current State**: All products in the catalog are displayed regardless of supplier.

**Target State**: Only products matching `activeSupplier` are displayed. Product details pane shows only the active supplier's products.

```typescript
// Filtered product list:
const visibleProducts = activeSupplier 
  ? catalogProducts.filter(p => p.supplier === activeSupplier)
  : catalogProducts;

// Product details pane shows only visibleProducts
```

**Change from existing**: This is a major UI change. The existing product list rendering is filtered by `activeSupplier`. The existing pagination and sort logic continues to work on `visibleProducts`.

#### Platform-Specific UI Adaptation

When **Vican Visions** is active:
- Product table shows AliExpress columns: 5-image gallery, attributes, description, cost price (H+I), sale price
- Import flow expects Vican template format
- "Retrieve source data" button fetches AliExpress product page details
- Editor panel shows AliExpress-specific fields (Product Description, Product Attributes, image gallery)
- Publishing platform is **WooCommerce**

When **Cellar Drive** is active:
- Current behavior unchanged (Shopify publishing)
- Product table shows Cellar/Paramount columns
- Import expects Cellar format workbook
- Editor panel shows current fields
- Publishing platform is **Shopify**

#### Cost Price Display for Vican Visions

**Current State**: `unitPrice` is a single numeric value.

**Target State**: When Vican Visions is active, cost price is displayed as combined dollars + cents (from template columns H + I). The combined value is stored as `unitPrice`.

**Change from existing**: The `unitPrice` field value is computed differently for Vican products (H*100 + I cents). This is handled in `transformToStandard()` when the Vican template is detected.

#### Reset Page Behavior

**Current State**: Reset page clears visible draft/filters/selections/edits without touching SQLite.

**Target State**: Reset clears transient state (filters, selections, edits) but NOT supplier selection (supplier persists across reset).

**Change from existing**: The supplier selection (`activeSupplier`) is preserved across reset because it's a persistent choice. Only transient UI state is cleared.

#### Purge Behavior

**Current State**: Purge clears catalog products, source cache, publish history, and images.

**Target State**: Purge clears catalog but supplier selection can be re-applied when re-importing.

**Change from existing**: No change — supplier is not persisted to SQLite as a draft property. It's client-side state that needs to be re-applied after purge.

### 2. `server/src/routes/imports.ts` — Supplier-Aware Import

**Current State**: `POST /api/imports` calls `transformToStandard()` which auto-detects supplier. No supplier override possible.

**Target State**: Accept optional `supplier` parameter to override auto-detection.

```typescript
// BEFORE:
const { headers, rows, supplier } = transformToStandard(request.file.buffer);

// AFTER:
const supplierOverride = request.query.supplier as string | undefined;
const { headers, rows, supplier } = transformToStandard(request.file.buffer, supplierOverride);
```

**Change from existing**: The import route is extended with an optional query parameter. If not provided, `detectSupplier()` is used as before (backward compatible).

### 3. `server/src/imports/transformWorkbook.ts` — Supplier Override

**Current State**: `transformToStandard(buffer)` auto-detects supplier from workbook headers.

**Target State**: Accept optional `forceSupplier` parameter.

```typescript
// BEFORE:
export function transformToStandard(buffer: Buffer): { headers: string[]; rows: StandardRow[]; supplier: string }

// AFTER:
export function transformToStandard(buffer: Buffer, forceSupplier?: string): { headers: string[]; rows: StandardRow[]; supplier: string }
```

**Vican Visions template mapping** (`template_aliexpress_presson1.xlsx`):
- Column A → URL to full product details page (source URL)
- Columns B-F → 5 images (user selects main picture, default column B)
- Column G → product title
- Column H → cost price (dollars)
- Column I → cost price (cents)
- Combined: `unitPrice = H + I/100`
- Column G → title

**Change from existing**: The function signature is extended with an optional parameter. When `forceSupplier` is provided, use that mapping instead of `detectSupplier()`. The Vican template mapping is added to `transformToStandard()`.

### 4. `server/src/drafts/draftStore.ts` — Supplier Context

**Current State**: `drafts` table has: `id`, `filename`, `created_at`, `updated_at`, `user_id`. `products` table has `supplier_type` and `source_platform`. No `supplier` column on `drafts`.

**Target State**: Add `supplier` column to `drafts` table. Store supplier on merge. Support filtering products by supplier.

```sql
ALTER TABLE drafts ADD COLUMN supplier TEXT NOT NULL DEFAULT 'cellar';
```

**Changes**:
- Add `supplier` column to `drafts` table (via `addColumnIfMissing`)
- When merging a workbook, store the `supplier` on the draft
- `getCurrentDraft()` returns `supplier` in the response
- Support filtering products by `supplier` field

### 5. `server/src/imports/standardFormat.ts` — Supplier-Aware Column Display

**Current State**: `STANDARD_HEADERS` and `StandardCol` are fixed for all suppliers.

**Target State**: Add `getVisibleColumns(supplier)` function.

```typescript
function getVisibleColumns(supplier: string): StandardColumn[] {
  if (supplier === 'aliexpress' || supplier === 'vican') {
    // AliExpress/Vican columns: 5 images, attributes, description, cost price, sale price
    return [IMAGE_1, IMAGE_2, IMAGE_3, IMAGE_4, IMAGE_5, ...];
  }
  // Cellar/Paramount columns
  return [IMAGE_1, KEY, TITLE, SOURCE_URL, SOH, CASE_PRICE, UNIT_PRICE, SUPPLIER_TYPE];
}
```

**Change from existing**: The existing `STANDARD_HEADERS` and `StandardCol` remain unchanged. `getVisibleColumns()` is a new helper function that determines which columns to display in the UI.

### 6. `server/src/enrichment/sourcePageFetcher.ts` — Supplier-Specific Retrieval

**Current State**: `fetchProductDetails()` uses `extractProductDetails()` (Paramount) for all HTML parsing.

**Target State**: When product is AliExpress/Vican, use `extractAliexpressProductDetails()` instead.

**Change from existing**: The routing logic checks the product's `supplier` or `sourcePlatform` field to determine which extraction function to call. This is consistent with VIC-17 changes.

### 7. Platform Abstraction for WooCommerce Publishing

**Current State**: `server/src/shopify/productPublisher.ts` handles Shopify publishing. `server/src/platforms/` has `PlatformClient` interface.

**Target State**: Extend `PlatformClient` for WooCommerce support.

```typescript
// Extend PlatformClient interface:
interface PlatformClient {
  publishProduct(product: ProductDraft): Promise<PublishResult>;
  // ... existing methods
}

// New WooCommerce client:
class WooCommerceClient implements PlatformClient {
  constructor(private siteUrl: string, private consumerKey: string, private consumerSecret: string) {}
  async publishProduct(product: ProductDraft): Promise<PublishResult> { ... }
}
```

**Change from existing**: `server/src/shopify/` continues to exist unchanged. A new `server/src/woocommerce/` module is added alongside it. The existing Shopify publisher is NOT modified. Publishing decisions are made per-product based on `supplier` field (Cellar → Shopify, Vican → WooCommerce).

### 8. `server/src/config.ts` — WooCommerce Configuration

**Current State**: Config comes from `.env`. Shopify config: `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_LOCATION_ID`.

**Target State**: Add WooCommerce configuration keys.

```env
# WooCommerce (Vican Visions)
WOOCOMMERCE_SITE_URL=
WOOCOMMERCE_CONSUMER_KEY=
WOOCOMMERCE_CONSUMER_SECRET=
```

**Change from existing**: Existing Shopify config unchanged. WooCommerce config is additive. The `config.ts` file is extended with new keys and defaults.

### 9. `server/src/index.ts` — Platform Initialization

**Current State**: Initializes `DraftStore`, runs startup seed/restore, registers route routers.

**Target State**: Initialize WooCommerce client if WooCommerce config is provided. Register publishing router with platform awareness.

**Change from existing**: Minimal changes — platform client initialization is added alongside existing Shopify initialization.

---

## Files to Modify

| File | Change | Notes |
|------|--------|-------|
| `client/src/App.tsx` | Add supplier state, dropdown UI, Apply button, catalog filtering by supplier, persistent state across switch, platform-specific UI adaptation, cost price display for Vican, Reset behavior update | Largest change — major UI additions |
| `server/src/routes/imports.ts` | Accept `supplier` query parameter in import, `GET /api/productsload` endpoint | Extend existing routes |
| `server/src/imports/transformWorkbook.ts` | Add `forceSupplier` parameter, Vican template mapping (A=URL, B-F=images, G=title, H+I=cost) | Extend function signature |
| `server/src/drafts/draftStore.ts` | Add `supplier` column to `drafts`, store supplier on merge, support product filtering by supplier | Uses `addColumnIfMissing()` pattern |
| `server/src/imports/standardFormat.ts` | Add `getVisibleColumns(supplier)` function | New helper — existing `STANDARD_HEADERS` unchanged |
| `server/src/enrichment/sourcePageFetcher.ts` | Route AliExpress URLs to `extractAliexpressProductDetails()` | Extends `fetchProductDetails()` |
| `server/src/config.ts` | Add WooCommerce config keys (`WOOCOMMERCE_SITE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET`) | Additive config |
| `server/src/types.ts` | Add `supplier` to `DraftSummary` | Extend existing types |
| `server/src/index.ts` | Initialize WooCommerce client, platform-aware publishing router | Minimal changes |
| `client/src/api.ts` | Add supplier-related API support | Extend existing API types |
| `server/src/platforms/` | Extend `PlatformClient` interface for WooCommerce | New interface extension |
| `server/src/woocommerce/` | NEW: WooCommerce client module | Entirely new directory |

---

## Verification Checklist

1. **Dropdown UI**: Supplier dropdown appears in toolbar with Cellar Drive and Vican Visions options
2. **Apply workflow**: Select Vican Visions → Apply → UI flips to Vican format; select Cellar → Apply → UI flips back
3. **Apply disabled**: Apply button is disabled when no change has been made in the dropdown
4. **Persistent state**: Switch suppliers → verify all product data, edits, selections, filters, pagination preserved
5. **Catalog filtering**: Only products from active supplier are displayed (including details pane)
6. **Import format**: Load Cellar workbook with Cellar active → correct; Load Vican template with Vican active → correct
7. **Format auto-detection**: Import without specifying supplier → `detectSupplier()` still works
8. **Cost price**: Vican cost price correctly combines dollars + cents from template columns H + I
9. **Default main image**: Column B is default main product picture, user can select any of 5
10. **Reset behavior**: Reset page clears transient state but NOT supplier selection
11. **Purge behavior**: Purge clears catalog but supplier selection can be re-applied
12. **TypeScript**: `npm run typecheck` passes
13. **Build**: `npm run build` succeeds
14. **Thorough testing**: Each verification item tested extensively before proceeding

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Single-file App.tsx** becomes unmanageable | High | Plan future refactoring into hooks/components; add changes carefully with section markers |
| **Supplier switching** could lose state | High | Comprehensive state preservation logic; test switching back and forth multiple times |
| **WooCommerce integration** is new | High | Use `PlatformClient` interface as foundation; add WooCommerce client alongside Shopify |
| **Vican template column mapping** may differ from standard format | Medium | Follow confirmed `template_aliexpress_presson1.xlsx` structure; validate against actual template file |
| **Catalog filtering** might hide products unexpectedly | Medium | Products are hidden but NOT deleted; switching back shows all products again |
| **Database migration complexity** | Medium | `addColumnIfMissing()` pattern proven in codebase; single migration for supplier column |
