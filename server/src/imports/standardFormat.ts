/** Standard import column layout for all supplier workbooks.
 *
 * All supplier files are transformed into this 11-column layout before
 * parsing. This keeps xlsxParser.ts index-based and avoids per-supplier
 * parsing logic.
 *
 * Columns A–P:
 *   A   image-1          Primary product image URL
 *   B   image-2          Secondary image URL
 *   C   image-3          Tertiary image URL
 *   D   image-4          Image 4 URL
 *   E   image-5          Image 5 URL
 *   F   image-6          Image 6 URL
 *   G   image-7          Image 7 URL
 *   H   image-8          Image 8 URL
 *   I   source           Source platform identifier (e.g. "aliexpress", "paramount")
 *   J   body-xxs         Supplier product key / SKU
 *   K   body-xs          Product title
 *   L   body-xs href     Source page URL
 *   M   heading-xs       Stock on hand
 *   N   heading-xs 2     Case price
 *   O   heading-xs 3     Unit price
 *   P   Type             Supplier type / category
 */
export const STANDARD_HEADERS = [
  'image-1', 'image-2', 'image-3', 'image-4',
  'image-5', 'image-6', 'image-7', 'image-8',
  'source', 'body-xxs', 'body-xs', 'body-xs href',
  'heading-xs', 'heading-xs 2', 'heading-xs 3', 'Type',
] as const;

export const STANDARD_COLUMN_COUNT = STANDARD_HEADERS.length;

/** Indices into the standard 16-column layout used by xlsxParser. */
export const StandardCol = {
  IMAGE_1: 0,
  IMAGE_2: 1,
  IMAGE_3: 2,
  IMAGE_4: 3,
  IMAGE_5: 4,
  IMAGE_6: 5,
  IMAGE_7: 6,
  IMAGE_8: 7,
  SOURCE: 8,
  KEY: 9,
  TITLE: 10,
  SOURCE_URL: 11,
  SOH: 12,
  CASE_PRICE: 13,
  UNIT_PRICE: 14,
  SUPPLIER_TYPE: 15,
} as const;

export type StandardColumn = typeof STANDARD_HEADERS[number];
