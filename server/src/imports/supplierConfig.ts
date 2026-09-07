/** Supplier source definitions and their native column mappings.
 *
 * Each supplier defines how its workbook columns map to the STANDARD format.
 * The transformation layer reads native columns and writes to standard positions.
 */

export interface SupplierMapping {
  /** Column letters in the native workbook → standard column index. */
  imageColumns: [number, number, number, number, number, number, number, number];
  /** Native column index for source platform string (empty = leave blank). */
  sourceColumn: number | null;
  /** Native column index for supplier product key (empty = derive from URL). */
  keyColumn: number | null;
  /** Native column index for product title (empty = none). */
  titleColumn: number | null;
  /** Native column index for source URL (empty = none). */
  sourceUrlColumn: number | null;
  /** Native column index for stock on hand (empty = none). */
  sohColumn: number | null;
  /** Native column index for case price (empty = none). */
  casePriceColumn: number | null;
  /** Native column index for unit price (empty = none). */
  unitPriceColumn: number | null;
  /** Native column index for supplier type (empty = none). */
  typeColumn: number | null;
  /** Default source platform label when sourceColumn is null. */
  defaultSourcePlatform: string;
  /** How to reconstruct unit price when it's fragmented across columns. */
  priceReconstruction?: 'direct' | 'from-fragmented' | 'null';
}

/** Cellar (Paramount Liquor) — native layout: A(image), B(key), E(title), F(source URL), G(SOH), I(case), J(unit), K(type) */
export const CELLAR_MAPPING: SupplierMapping = {
  imageColumns: [0, -1, -1, -1, -1, -1, -1, -1],
  sourceColumn: null, // Will be set to "paramount" by transformation
  keyColumn: 1,
  titleColumn: 4,
  sourceUrlColumn: 5,
  sohColumn: 6,
  casePriceColumn: 8,
  unitPriceColumn: 9,
  typeColumn: 10,
  defaultSourcePlatform: 'paramount',
  priceReconstruction: 'direct',
};

/** AliExpress (Vican) — native layout: A(product URL), B-F(images), I/J(title), K/L/M(fragmented price) */
export const ALIEXPRESS_MAPPING: SupplierMapping = {
  imageColumns: [0, 1, 2, 3, 4, 5, -1, -1],
  sourceColumn: null, // Will be set to "aliexpress" by transformation
  keyColumn: null, // Derived from URL item ID
  titleColumn: null, // Will use columns I/J from native
  sourceUrlColumn: null, // Will use column A from native
  sohColumn: null,
  casePriceColumn: null,
  unitPriceColumn: null, // Will reconstruct from K/L/M
  typeColumn: null,
  defaultSourcePlatform: 'aliexpress',
  priceReconstruction: 'from-fragmented',
};

/** Map of known supplier identifiers to their mappings. */
export const SUPPLIER_MAPPINGS: Record<string, SupplierMapping> = {
  cellar: CELLAR_MAPPING,
  paramount: CELLAR_MAPPING,
  vican: ALIEXPRESS_MAPPING,
  aliexpress: ALIEXPRESS_MAPPING,
};

/** Detect supplier type from the workbook headers (first data row or header names). */
export function detectSupplier(headers: string[]): string {
  const headerText = headers.map((h) => h.toLocaleLowerCase()).join(' ');

  // AliExpress indicators — checked first
  if (headerText.includes('detailurl') || headerText.includes('itemid')) {
    return 'aliexpress';
  }
  if (headerText.includes('image') && headerText.includes('item') && headerText.includes('price')) {
    return 'aliexpress';
  }

  // Paramount/Cellar indicators — has heading-xs based column names
  if (headerText.includes('heading-xs')) {
    return 'paramount';
  }
  if (headerText.includes('stock') || headerText.includes('soh')) {
    return 'paramount';
  }
  if (headerText.includes('case') && headerText.includes('unit')) {
    return 'paramount';
  }

  // Default fallback — cellar format matches the existing sup2_paramountliquor.xlsx
  return 'cellar';
}
