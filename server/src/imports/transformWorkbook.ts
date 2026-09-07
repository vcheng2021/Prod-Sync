import * as XLSX from 'xlsx';
import { detectSupplier, SUPPLIER_MAPPINGS, type SupplierMapping } from './supplierConfig.js';
import { STANDARD_HEADERS, type StandardColumn } from './standardFormat.js';

interface StandardRow {
  /** All 16 standard columns as strings. */
  values: string[];
  /** Native row index (for error messages). */
  nativeRowIndex: number;
}

/** Detect supplier type and get its mapping from workbook headers. */
function getSupplierMapping(headers: string[]): { mapping: SupplierMapping; supplier: string } {
  const supplier = detectSupplier(headers);
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
  // AliExpress fragments price across K/L/M: e.g. "US $12.34", "US $15.67", "12 - 15 pcs"
  // Try to find the first numeric price value in columns K, L, M
  for (const col of [10, 11, 12]) {
    if (col < row.length && row[col] !== null && row[col] !== undefined) {
      const text = String(row[col]).trim();
      const match = text.match(/\d+\.?\d*/);
      if (match) return match[0];
    }
  }
  return '';
}

/** Transform a native workbook into the standard 16-column format. */
export function transformToStandard(buffer: Buffer): { headers: string[]; rows: StandardRow[]; supplier: string } {
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

  const { mapping, supplier } = getSupplierMapping(headers);

  const standardRows: StandardRow[] = [];

  rows.slice(1).forEach((nativeRow, nativeRowIndex) => {
    // Skip completely empty rows
    if (!nativeRow.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== '')) {
      return;
    }

    const standardValues: string[] = new Array(16).fill('');

    // Images: map native image columns to standard image columns
    for (let i = 0; i < 8; i++) {
      const nativeCol = mapping.imageColumns[i];
      if (nativeCol >= 0 && nativeCol < nativeRow.length) {
        standardValues[i] = nativeValue(nativeRow, nativeCol);
      }
    }

    // Source platform
    if (mapping.sourceColumn !== null) {
      standardValues[8] = nativeValue(nativeRow, mapping.sourceColumn);
    } else {
      standardValues[8] = supplier;
    }

    // Supplier product key
    if (mapping.keyColumn !== null) {
      standardValues[9] = nativeValue(nativeRow, mapping.keyColumn);
    }

    // Title
    if (mapping.titleColumn !== null) {
      standardValues[10] = nativeValue(nativeRow, mapping.titleColumn);
    }
    // For AliExpress, title is typically in columns I/J (8/9) — extract from native row
    if (supplier === 'aliexpress' && standardValues[10] === '') {
      const aliTitle = nativeValue(nativeRow, 8) || nativeValue(nativeRow, 9);
      if (aliTitle) standardValues[10] = aliTitle;
    }

    // Source URL
    if (mapping.sourceUrlColumn !== null) {
      standardValues[11] = nativeValue(nativeRow, mapping.sourceUrlColumn);
    }
    // For AliExpress, source URL is in column A (product URL)
    if (supplier === 'aliexpress' && standardValues[11] === '') {
      standardValues[11] = nativeValue(nativeRow, 0);
    }

    // SOH
    if (mapping.sohColumn !== null) {
      standardValues[12] = nativeValue(nativeRow, mapping.sohColumn);
    }

    // Case price
    if (mapping.casePriceColumn !== null) {
      standardValues[13] = nativeValue(nativeRow, mapping.casePriceColumn);
    }

    // Unit price
    standardValues[14] = reconstructUnitPrice(nativeRow, mapping);

    // Supplier type
    if (mapping.typeColumn !== null) {
      standardValues[15] = nativeValue(nativeRow, mapping.typeColumn);
    } else if (supplier === 'aliexpress') {
      standardValues[15] = 'AliExpress';
    } else if (supplier === 'paramount') {
      standardValues[15] = 'Paramount';
    }

    standardRows.push({ values: standardValues, nativeRowIndex: nativeRowIndex + 2 });
  });

  return { headers: headersMutable, rows: standardRows, supplier };
}

/** Convert standard rows to xlsx-compatible data for xlsxParser consumption. */
export function standardRowsToXlsxRows(standardRows: StandardRow[]): unknown[][] {
  return standardRows.map((row) => [...row.values]);
}
