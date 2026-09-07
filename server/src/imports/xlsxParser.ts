import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import { StandardCol } from './standardFormat.js';
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
    const key = textValue(valueAt(row, StandardCol.KEY));
    const normalizedKey = normalizeSupplierProductKey(key);
    if (normalizedKey) keyRows.set(normalizedKey, [...(keyRows.get(normalizedKey) ?? []), { rowNumber, fingerprint: JSON.stringify([row[StandardCol.IMAGE_1], row[StandardCol.KEY], row[StandardCol.TITLE], row[StandardCol.SOURCE_URL], row[StandardCol.SOH], row[StandardCol.CASE_PRICE], row[StandardCol.UNIT_PRICE], row[StandardCol.SUPPLIER_TYPE]]) }]);
  });

  rows.slice(1).forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const supplierProductKey = textValue(valueAt(row, StandardCol.KEY));
    const normalizedKey = normalizeSupplierProductKey(supplierProductKey);
    const imageUrl = textValue(valueAt(row, StandardCol.IMAGE_1));
    const title = textValue(valueAt(row, StandardCol.TITLE));
    const sourceUrl = textValue(valueAt(row, StandardCol.SOURCE_URL));
    const stockOnHand = numericValue(valueAt(row, StandardCol.SOH));
    const supplierType = textValue(valueAt(row, StandardCol.SUPPLIER_TYPE));
    const casePrice = numericValue(valueAt(row, StandardCol.CASE_PRICE));
    const unitPriceText = textValue(valueAt(row, StandardCol.UNIT_PRICE));
    const unitPrice = numericValue(valueAt(row, StandardCol.UNIT_PRICE));
    const validationErrors: string[] = [];

    const hasContent = row.some((value) => textValue(value) !== '');
    if (!hasContent) return;
    if (!supplierProductKey) validationErrors.push('Supplier product key is missing (column J).');
    const duplicateEntries = keyRows.get(normalizedKey) ?? [];
    const duplicateRows = duplicateEntries.map((entry) => entry.rowNumber);
    const hasConflictingDuplicate = new Set(duplicateEntries.map((entry) => entry.fingerprint)).size > 1;
    if (duplicateEntries.length > 1 && hasConflictingDuplicate) validationErrors.push(`Supplier product key conflicts with rows ${duplicateRows.filter((entry) => entry !== rowNumber).join(', ')} (column J).`);
    if (!title) validationErrors.push('Title is missing (column K).');
    if (unitPriceText && (unitPrice === null || unitPrice <= 0)) validationErrors.push('Unit price must be greater than zero (column O).');
    if (sourceUrl && !isValidUrl(sourceUrl)) validationErrors.push('Product URL must be a valid HTTPS URL (column L).');
    if (stockOnHand === null && textValue(valueAt(row, StandardCol.SOH))) validationErrors.push('Stock on hand is not numeric (column M).');
    if (casePrice === null && textValue(valueAt(row, StandardCol.CASE_PRICE))) validationErrors.push('Case price is not numeric (column N).');
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
      imageUrls: imageUrl ? [imageUrl] : [],
      imageLocalFilename: '',
      imageLocalUrl: '',
      imageStatus: imageUrl ? 'pending' : 'not-provided',
      title,
      sourceUrl,
      stockOnHand,
      casePrice,
      unitPrice,
      suggestedSalePrice: unitPrice === null ? null : currencyValue(unitPrice * 1.35),
      inventoryQuantity: stockOnHand !== null && stockOnHand > 2 ? 1 : 0,
      descriptionHtml: '',
      brand: '',
      country: '',
      region: '',
      productType: '',
      supplierType,
      sourcePlatform: '',
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
      enrichmentPartial: false,
      failedEnrichmentFields: [],
      productAttributes: '',
      productDescription: '',
      aliexpressImages: [],
      originalProductAttributes: '',
      originalProductDescription: '',
      supplier: 'cellar',
    });

    if (validationErrors.length > 0) {
      invalidRowCount += 1;
      importErrors.push(`Row ${rowNumber}: ${validationErrors.join(' ')}`);
    }
  });

  return { sheetName, headers, products, importErrors, invalidRowCount, duplicateRowsSkipped };
};
