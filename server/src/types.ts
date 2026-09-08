export type EnrichmentStatus = 'pending' | 'ready' | 'failed' | 'blocked' | 'not-provided';
export type ImageStatus = 'pending' | 'valid' | 'failed' | 'blocked' | 'not-provided';
export type PublishStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'skipped';

export interface ProductDraft {
  id: string;
  draftId: string;
  rowNumber: number;
  supplierProductKey: string;
  imageUrl: string;
  imageUrls: string[];
  imageLocalFilename: string;
  imageLocalUrl: string;
  imageStatus: ImageStatus;
  title: string;
  sourceUrl: string;
  stockOnHand: number | null;
  casePrice: number | null;
  unitPrice: number | null;
  suggestedSalePrice: number | null;
  inventoryQuantity: number;
  descriptionHtml: string;
  brand: string;
  country: string;
  region: string;
  productType: string;
  supplierType: string;
  sourcePlatform: string;
  abv: string;
  containerType: string;
  style: string;
  enrichmentStatus: EnrichmentStatus;
  enrichmentError: string;
  enrichmentFetchedAt: string | null;
  enrichmentPartial: boolean;
  failedEnrichmentFields: string[];
  selected: boolean;
  publishStatus: PublishStatus;
  publishError: string;
  shopifyProductId: string | null;
  shopifyMatchCount: number | null;
  // VIC-17: AliExpress fields
  productAttributes: string;
  productDescription: string;
  aliexpressImages: string[];
  originalProductAttributes: string;
  originalProductDescription: string;
  selectedImageIndex: number;
  costPrice: number | null;
  // VIC-18: Supplier routing
  supplier: string;
  // UI state
  featured: boolean;
  publishToOnlineStore: boolean;
  selectedCollectionIds: string[];
  // Import validation
  validationErrors: string[];
  raw: Record<string, unknown>;
}

export interface DraftSummary {
  id: string;
  filename: string;
  createdAt: string;
  updatedAt: string;
  totalProducts: number;
  selectedProducts: number;
  readyProducts: number;
  failedProducts: number;
  supplier: string;
}

export interface DraftResponse {
  draft: DraftSummary;
  products: ProductDraft[];
}

export interface WorkbookImportSummary {
  added: number;
  updated: number;
  unchanged: number;
  invalid: number;
  duplicateRowsSkipped: number;
}

export interface EnrichedProductDetails {
  descriptionHtml: string;
  brand: string;
  country: string;
  region: string;
  productType: string;
  abv: string;
  containerType: string;
  style: string;
  // VIC-17: AliExpress-specific fields (may be empty for non-AliExpress)
  productAttributes?: string;
  productDescription?: string;
  aliexpressImages?: string[];
  // Enrichment metadata
  enrichmentPartial?: boolean;
  failedFields?: string[];
}

export interface FetchResult {
  status: 'ready' | 'failed' | 'blocked';
  details: EnrichedProductDetails;
  error: string;
  // VIC-16: Partial enrichment support
  partialDetails?: Partial<EnrichedProductDetails>;
  failedFields: string[];
}
