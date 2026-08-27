import * as XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import type { ProductDraft } from '../types.js';

export interface ParsedWorkbook {
  sheetName: string;
  headers: string[];
  products: ProductDraft[];
  importErrors: string[];
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

  rows.slice(1).forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const imageUrl = textValue(valueAt(row, 0));
    const title = textValue(valueAt(row, 4));
    const sourceUrl = textValue(valueAt(row, 5));
    const stockOnHand = numericValue(valueAt(row, 6));
    const casePrice = numericValue(valueAt(row, 8));
    const unitPriceText = textValue(valueAt(row, 9));
    const unitPrice = numericValue(valueAt(row, 9));
    const validationErrors: string[] = [];

    const hasContent = row.some((value) => textValue(value) !== '');
    if (!hasContent) return;
    if (!title) validationErrors.push('Title is missing (column E).');
    if (unitPriceText && (unitPrice === null || unitPrice <= 0)) validationErrors.push('Unit price must be greater than zero (column J).');
    if (sourceUrl && !isValidUrl(sourceUrl)) validationErrors.push('Product URL must be a valid HTTPS URL (column F).');
    if (stockOnHand === null && textValue(valueAt(row, 6))) validationErrors.push('Stock on hand is not numeric (column G).');
    if (casePrice === null && textValue(valueAt(row, 8))) validationErrors.push('Case price is not numeric (column I).');
    if (imageUrl && !isValidUrl(imageUrl)) validationErrors.push('Image URL must be a valid HTTPS URL (column A).');

    products.push({
      id: randomUUID(),
      draftId,
      rowNumber,
      imageUrl,
      imageLocalFilename: '',
      imageLocalUrl: '',
      imageStatus: imageUrl ? 'pending' : 'not-provided',
      title,
      sourceUrl,
      stockOnHand,
      casePrice,
      unitPrice,
      descriptionHtml: '',
      brand: '',
      country: '',
      region: '',
      productType: '',
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
    });

    if (validationErrors.length > 0) {
      importErrors.push(`Row ${rowNumber}: ${validationErrors.join(' ')}`);
    }
  });

  return { sheetName, headers, products, importErrors };
};
