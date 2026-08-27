import * as XLSX from 'xlsx';
import type { DraftResponse, ProductDraft } from '../types.js';

const productToRow = (product: ProductDraft, rawKeys: string[]): Record<string, unknown> => {
  const row: Record<string, unknown> = {
    'Source row': product.rowNumber,
    'Image URL': product.imageUrl,
    'Saved image filename': product.imageLocalFilename,
    'Saved image URL': product.imageLocalUrl,
    'Image status': product.imageStatus,
    Title: product.title,
    'Supplier product URL': product.sourceUrl,
    'Stock on hand': product.stockOnHand,
    'Case price': product.casePrice,
    'Unit price': product.unitPrice,
    'About this product (HTML)': product.descriptionHtml,
    Brand: product.brand,
    Country: product.country,
    Region: product.region,
    'Product Type': product.productType,
    'ABV %': product.abv,
    'Container Type': product.containerType,
    Style: product.style,
    'Enrichment status': product.enrichmentStatus,
    'Enrichment error': product.enrichmentError,
    Selected: product.selected ? 'Yes' : 'No',
    'Publish status': product.publishStatus,
    'Publish error': product.publishError,
    'Shopify product ID': product.shopifyProductId,
    'Validation errors': product.validationErrors.join(' | '),
  };
  for (const key of rawKeys) row[`Raw: ${key}`] = product.raw[key] ?? '';
  return row;
};

export const createDraftWorkbook = (response: DraftResponse): Buffer => {
  const rawKeys = [...new Set(response.products.flatMap((product) => Object.keys(product.raw)))].sort();
  const products = response.products.map((product) => productToRow(product, rawKeys));
  const workbook = XLSX.utils.book_new();
  const productsSheet = XLSX.utils.json_to_sheet(products);
  const summarySheet = XLSX.utils.json_to_sheet([{
    'Draft ID': response.draft.id,
    Filename: response.draft.filename,
    'Created at': response.draft.createdAt,
    'Updated at': response.draft.updatedAt,
    'Total products': response.draft.totalProducts,
    'Selected products': response.draft.selectedProducts,
    'Ready products': response.draft.readyProducts,
    'Failed products': response.draft.failedProducts,
  }]);
  XLSX.utils.book_append_sheet(workbook, productsSheet, 'Products');
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Import summary');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};
