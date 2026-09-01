import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import type { ProductDraft } from '../types.js';

export interface ParsedWorkbook {
  sheetName: string;
  headers: string[];
  products: ProductDraft[];
  importErrors: string[];
  invalidRowCount: number;
  duplicateRowsSkipped: number;
}

const valueAt = (row: unknown[], index: number): unknown => row[index] ?? null;

const textValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const numericValue = (value: unknown): number | null => {
  const text = textValue(value).replace(/[$,]/g, '');
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};

const currencyValue = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export const normalizeSupplierProductKey = (value: string): string => value.trim().toLocaleLowerCase();

const isValidUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
};

const rawColumns = (row: unknown[], headers: string[]): Record<string, unknown> =>
  Object.fromEntries(
    row.map((value, index) => [headers[index] || `Column ${index + 1}`, value]),
  );

export const parseWorkbook = (buffer: Buffer, draftId: string): ParsedWorkbook => {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('The workbook does not contain a worksheet.');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });
  const headerRow = rows[0] ?? [];
  const headers = headerRow.map((value, index) => textValue(value) || `Column ${index + 1}`);
  const importErrors: string[] = [];
  const products: ProductDraft[] = [];
  let invalidRowCount = 0;
  let duplicateRowsSkipped = 0;

  const keyRows = new Map<string, Array<{ rowNumber: number; fingerprint: string }>>();
  rows.slice(1).forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const key = textValue(valueAt(row, 1));
    const normalizedKey = normalizeSupplierProductKey(key);
    if (normalizedKey) keyRows.set(normalizedKey, [...(keyRows.get(normalizedKey) ?? []), { rowNumber, fingerprint: JSON.stringify([row[0], row[1], row[4], row[5], row[6], row[8], row[9], row[10]]) }]);
  });

  rows.slice(1).forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const supplierProductKey = textValue(valueAt(row, 1));
    const normalizedKey = normalizeSupplierProductKey(supplierProductKey);
    const imageUrl = textValue(valueAt(row, 0));
    const title = textValue(valueAt(row, 4));
    const sourceUrl = textValue(valueAt(row, 5));
    const stockOnHand = numericValue(valueAt(row, 6));
    const supplierType = textValue(valueAt(row, 10));
    const casePrice = numericValue(valueAt(row, 8));
    const unitPriceText = textValue(valueAt(row, 9));
    const unitPrice = numericValue(valueAt(row, 9));
    const validationErrors: string[] = [];

    const hasContent = row.some((value) => textValue(value) !== '');
    if (!hasContent) return;
    if (!supplierProductKey) validationErrors.push('Supplier product key is missing (column B).');
    const duplicateEntries = keyRows.get(normalizedKey) ?? [];
    const duplicateRows = duplicateEntries.map((entry) => entry.rowNumber);
    const hasConflictingDuplicate = new Set(duplicateEntries.map((entry) => entry.fingerprint)).size > 1;
    if (duplicateEntries.length > 1 && hasConflictingDuplicate) validationErrors.push(`Supplier product key conflicts with rows ${duplicateRows.filter((entry) => entry !== rowNumber).join(', ')} (column B).`);
    if (!title) validationErrors.push('Title is missing (column E).');
    if (unitPriceText && (unitPrice === null || unitPrice <= 0)) validationErrors.push('Unit price must be greater than zero (column J).');
    if (sourceUrl && !isValidUrl(sourceUrl)) validationErrors.push('Product URL must be a valid HTTPS URL (column F).');
    if (stockOnHand === null && textValue(valueAt(row, 6))) validationErrors.push('Stock on hand is not numeric (column G).');
    if (casePrice === null && textValue(valueAt(row, 8))) validationErrors.push('Case price is not numeric (column I).');
    if (imageUrl && !isValidUrl(imageUrl)) validationErrors.push('Image URL must be a valid HTTPS URL (column A).');

    if (!supplierProductKey || (duplicateEntries.length > 1 && hasConflictingDuplicate)) {
      invalidRowCount += 1;
      importErrors.push(`Row ${rowNumber}: ${validationErrors.join(' ')}`);
      return;
    }
    if (duplicateEntries.length > 1) {
      const firstDuplicate = duplicateEntries[0];
      if (firstDuplicate.rowNumber !== rowNumber) duplicateRowsSkipped += 1;
      if (firstDuplicate.rowNumber !== rowNumber) return;
    }

    products.push({
      id: randomUUID(),
      draftId,
      rowNumber,
      supplierProductKey,
      imageUrl,
      imageLocalFilename: '',
      imageLocalUrl: '',
      imageStatus: imageUrl ? 'pending' : 'not-provided',
      title,
      sourceUrl,
      stockOnHand,
      casePrice,
      unitPrice,
      suggestedSalePrice: unitPrice === null ? null : currencyValue(unitPrice * 1.25),
      inventoryQuantity: stockOnHand !== null && stockOnHand > 2 ? 1 : 0,
      descriptionHtml: '',
      brand: '',
      country: '',
      region: '',
      productType: '',
      supplierType,
      abv: '',
      containerType: '',
      style: '',
      enrichmentStatus: sourceUrl ? 'pending' : 'not-provided',
      enrichmentError: '',
      enrichmentFetchedAt: null,
      selected: false,
      publishStatus: 'pending',
      publishError: '',
      shopifyProductId: null,
      shopifyMatchCount: null,
      validationErrors,
      raw: rawColumns(row, headers),
      featured: false,
      publishToOnlineStore: true,
      selectedCollectionIds: [],
    });

    if (validationErrors.length > 0) {
      invalidRowCount += 1;
      importErrors.push(`Row ${rowNumber}: ${validationErrors.join(' ')}`);
    }
  });

  return { sheetName, headers, products, importErrors, invalidRowCount, duplicateRowsSkipped };
};
