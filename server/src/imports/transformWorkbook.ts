import * as XLSX from 'xlsx';
import { detectSupplier, detectAliExpressLayout, SUPPLIER_MAPPINGS, ALIEXPRESS_VIC25_MAPPING, type SupplierMapping } from './supplierConfig.js';
import { STANDARD_HEADERS, StandardCol, type StandardColumn } from './standardFormat.js';

interface StandardRow {
  /** All columns as strings. */
  values: string[];
  /** Native row index (for error messages). */
  nativeRowIndex: number;
}

/** Detect supplier type and get its mapping from workbook headers. */
function getSupplierMapping(headers: string[], forceSupplier?: string): { mapping: SupplierMapping; supplier: string } {
  const supplier = forceSupplier ?? detectSupplier(headers);
  // For AliExpress/Vican, check if the VIC-25 template layout is in use
  if ((supplier === 'aliexpress' || supplier === 'vican') && detectAliExpressLayout(headers)) {
    return { mapping: ALIEXPRESS_VIC25_MAPPING, supplier: 'vican' };
  }
  const mapping = SUPPLIER_MAPPINGS[supplier] ?? SUPPLIER_MAPPINGS.cellar;
  return { mapping, supplier };
}

/** Read a cell value from a native row, returning empty string for out-of-bounds. */
function nativeValue(row: unknown[], index: number | null): string {
  if (index === null || index < 0 || index >= row.length) return '';
  const value = row[index];
  return value === null || value === undefined ? '' : String(value).trim();
}

/** Reconstruct unit price from fragmented AliExpress price columns. */
function reconstructUnitPrice(row: unknown[], mapping: SupplierMapping): string {
  if (mapping.priceReconstruction !== 'from-fragmented') {
    return nativeValue(row, mapping.unitPriceColumn);
  }
  // AliExpress fragments price across K/L/M: e.g. K="71", L=".", M="19" → "71.19"
  // Or K="2", L=",", M="256" → "2,256" (thousands separator)
  const priceText = [10, 11, 12]
    .map((col) => (col < row.length && row[col] !== null && row[col] !== undefined) ? String(row[col]).trim() : '')
    .join('');
  return priceText;
}

/** Transform a native workbook into the standard column format.
 *
 * If `forceSupplier` is provided, it overrides the auto-detected supplier and
 * uses the corresponding column mapping (VIC-18 supplier selection override).
 */
export function transformToStandard(buffer: Buffer, forceSupplier?: string): { headers: string[]; rows: StandardRow[]; supplier: string } {
  const headersMutable = [...STANDARD_HEADERS];
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('The workbook does not contain a worksheet.');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });

  if (rows.length < 2) {
    throw new Error('The workbook must contain a header row and at least one data row.');
  }

  const headerRow = rows[0] ?? [];
  const headers = headerRow.map((value) => {
    const text = value === null || value === undefined ? '' : String(value).trim();
    return text || `Column ${headerRow.indexOf(value) + 1}`;
  });

  const { mapping, supplier } = getSupplierMapping(headers, forceSupplier);

  const standardRows: StandardRow[] = [];

  rows.slice(1).forEach((nativeRow, nativeRowIndex) => {
    // Skip completely empty rows
    if (!nativeRow.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== '')) {
      return;
    }

    const standardValues: string[] = new Array(STANDARD_HEADERS.length).fill('');

    // Images: map native image columns to standard image columns
    for (let i = 0; i < 8; i++) {
      const nativeCol = mapping.imageColumns[i];
      if (nativeCol >= 0 && nativeCol < nativeRow.length) {
        standardValues[i] = nativeValue(nativeRow, nativeCol);
      }
    }

    // Source platform
    if (mapping.sourceColumn !== null) {
      standardValues[StandardCol.SOURCE] = nativeValue(nativeRow, mapping.sourceColumn);
    } else {
      standardValues[StandardCol.SOURCE] = supplier;
    }

    // Supplier product key
    if (mapping.keyColumn !== null) {
      standardValues[StandardCol.KEY] = nativeValue(nativeRow, mapping.keyColumn);
    }

    // Title
    if (mapping.titleColumn !== null) {
      standardValues[StandardCol.TITLE] = nativeValue(nativeRow, mapping.titleColumn);
    }
    // For AliExpress, title is in column J (native index 9)
    if ((supplier === 'aliexpress' || supplier === 'vican') && standardValues[StandardCol.TITLE] === '') {
      const aliTitle = nativeValue(nativeRow, 9);
      if (aliTitle) standardValues[StandardCol.TITLE] = aliTitle;
    }

    // Source URL
    if (mapping.sourceUrlColumn !== null) {
      standardValues[StandardCol.SOURCE_URL] = nativeValue(nativeRow, mapping.sourceUrlColumn);
    }
    // For AliExpress, source URL is in column A (product URL)
    if ((supplier === 'aliexpress' || supplier === 'vican') && standardValues[StandardCol.SOURCE_URL] === '') {
      standardValues[StandardCol.SOURCE_URL] = nativeValue(nativeRow, 0);
    }

    // SOH
    if (mapping.sohColumn !== null) {
      standardValues[StandardCol.SOH] = nativeValue(nativeRow, mapping.sohColumn);
    }

    // Case price
    if (mapping.casePriceColumn !== null) {
      standardValues[StandardCol.CASE_PRICE] = nativeValue(nativeRow, mapping.casePriceColumn);
    }

    // Unit price
    standardValues[StandardCol.UNIT_PRICE] = reconstructUnitPrice(nativeRow, mapping);

    // Supplier type
    if (mapping.typeColumn !== null) {
      standardValues[StandardCol.SUPPLIER_TYPE] = nativeValue(nativeRow, mapping.typeColumn);
    } else if (supplier === 'aliexpress' || supplier === 'vican') {
      standardValues[StandardCol.SUPPLIER_TYPE] = 'AliExpress';
    } else if (supplier === 'paramount') {
      standardValues[StandardCol.SUPPLIER_TYPE] = 'Paramount';
    }

    // VIC-17: Legacy AliExpress cost price from native columns H (dollars=7) and I (cents=8).
    // VIC-25 layout does NOT have cost columns here — G/H/I are product category, sub
    // category, and attribc. Only extract cost for the legacy mapping.
    if ((supplier === 'aliexpress' || supplier === 'vican') && mapping.priceReconstruction === 'from-fragmented' && mapping.brandColumn === undefined) {
      standardValues[StandardCol.COST_DOLLARS] = nativeValue(nativeRow, 7);
      standardValues[StandardCol.COST_CENTS] = nativeValue(nativeRow, 8);
    }

    // VIC-25: Extract workbook brand, product category (→productType), and sub category (→containerType)
    if (mapping.brandColumn !== undefined && mapping.brandColumn !== null) {
      standardValues[StandardCol.BRAND] = nativeValue(nativeRow, mapping.brandColumn);
    }
    if (mapping.productCategoryColumn !== undefined && mapping.productCategoryColumn !== null) {
      standardValues[StandardCol.PRODUCT_TYPE] = nativeValue(nativeRow, mapping.productCategoryColumn);
    }
    if (mapping.subCategoryColumn !== undefined && mapping.subCategoryColumn !== null) {
      standardValues[StandardCol.CONTAINER_TYPE] = nativeValue(nativeRow, mapping.subCategoryColumn);
    }

    standardRows.push({ values: standardValues, nativeRowIndex: nativeRowIndex + 2 });
  });

  return { headers: headersMutable, rows: standardRows, supplier };
}

/** Convert standard rows to xlsx-compatible data for xlsxParser consumption.
 * Preserves all 18 standard columns including AliExpress cost columns. */
export function standardRowsToXlsxRows(standardRows: StandardRow[]): unknown[][] {
  return standardRows.map((row) => {
    const values: unknown[] = [...row.values];
    // Ensure cost columns are included even when empty
    while (values.length < STANDARD_HEADERS.length) {
      values.push('');
    }
    return values;
  });
}
