export type EnrichmentStatus = 'pending' | 'ready' | 'failed' | 'blocked' | 'not-provided';
export type ImageStatus = 'pending' | 'valid' | 'failed' | 'blocked' | 'not-provided';
export type PublishStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'skipped';

export interface ProductDraft {
  id: string;
  draftId: string;
  rowNumber: number;
  imageUrl: string;
  imageLocalFilename: string;
  imageLocalUrl: string;
  imageStatus: ImageStatus;
  title: string;
  sourceUrl: string;
  stockOnHand: number | null;
  casePrice: number | null;
  unitPrice: number | null;
  descriptionHtml: string;
  brand: string;
  country: string;
  region: string;
  productType: string;
  abv: string;
  containerType: string;
  style: string;
  enrichmentStatus: EnrichmentStatus;
  enrichmentError: string;
  enrichmentFetchedAt: string | null;
  selected: boolean;
  publishStatus: PublishStatus;
  publishError: string;
  shopifyProductId: string | null;
  shopifyMatchCount: number | null;
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
}

export interface DraftResponse {
  draft: DraftSummary;
  products: ProductDraft[];
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
}
