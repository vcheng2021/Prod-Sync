export type EnrichmentStatus = 'pending' | 'ready' | 'failed' | 'blocked' | 'not-provided';
export type ImageStatus = 'pending' | 'valid' | 'failed' | 'blocked' | 'not-provided';
export type PublishStatus = 'pending' | 'publishing' | 'published' | 'failed' | 'skipped';

export interface ProductDraft {
  id: string;
  draftId: string;
  rowNumber: number;
  supplierProductKey: string;
  imageUrl: string;
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
  featured: boolean;
  publishToOnlineStore: boolean;
}

export interface DraftResponse {
  draft: {
    id: string;
    filename: string;
    createdAt: string;
    updatedAt: string;
    totalProducts: number;
    selectedProducts: number;
    readyProducts: number;
    failedProducts: number;
  };
  products: ProductDraft[];
}

export interface LogIssue {
  timestamp: string;
  event: string;
  outcome: 'failure';
  details: Record<string, unknown>;
}

interface ImportResponse extends DraftResponse {
  sheetName: string;
  headers: string[];
  importErrors: string[];
  importSummary: { added: number; updated: number; unchanged: number; invalid: number; duplicateRowsSkipped: number };
}

const readError = async (response: Response): Promise<string> => {
  try {
    const payload = await response.json() as { error?: string };
    return payload.error ?? `Request failed with HTTP ${response.status}.`;
  } catch {
    return `Request failed with HTTP ${response.status}.`;
  }
};

const requestJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<T>;
};

export const importWorkbook = async (file: File): Promise<ImportResponse> => {
  const form = new FormData();
  form.append('workbook', file);
  return requestJson<ImportResponse>('/api/imports', { method: 'POST', body: form });
};

export const getCurrentDraft = (): Promise<DraftResponse | null> => requestJson<DraftResponse | null>('/api/drafts/current');

export const getIssueLog = (draftId?: string): Promise<LogIssue[]> => requestJson<LogIssue[]>(draftId ? `/api/issues?draftId=${encodeURIComponent(draftId)}` : '/api/issues');

export const getDraft = (draftId: string): Promise<DraftResponse> => requestJson<DraftResponse>(`/api/drafts/${draftId}`);

export const updateProduct = (draftId: string, productId: string, patch: Partial<ProductDraft>): Promise<ProductDraft> =>
  requestJson<ProductDraft>(`/api/drafts/${draftId}/products/${productId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

export const saveProducts = (draftId: string, products: Array<{ id: string; changes: Partial<ProductDraft> }>): Promise<{ products: ProductDraft[]; draft: DraftResponse }> =>
  requestJson<{ products: ProductDraft[]; draft: DraftResponse }>(`/api/drafts/${draftId}/products`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ products }),
  });

export const purgeDatabase = (): Promise<{ draft: null; removedImages: number }> =>
  requestJson<{ draft: null; removedImages: number }>('/api/database/purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmation: 'PURGE' }),
  });

export const refreshProduct = (draftId: string, productId: string): Promise<ProductDraft> =>
  requestJson<ProductDraft>(`/api/drafts/${draftId}/products/${productId}/refresh`, { method: 'POST' });

export const retrieveProduct = (draftId: string, productId: string): Promise<ProductDraft> =>
  requestJson<ProductDraft>(`/api/drafts/${draftId}/products/${productId}/retrieve`, { method: 'POST' });

export const publishProducts = (draftId: string, productIds: string[], changes: Array<{ id: string; changes: Partial<ProductDraft> }> = []): Promise<{ results: Array<{ productId: string; status: PublishStatus; error: string }>; draft: DraftResponse }> =>
  requestJson(`/api/drafts/${draftId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true, productIds, changes }),
  });

export const exportDraftUrl = (draftId: string): string => `/api/drafts/${draftId}/export`;

export interface ReadinessStatus {
  ok: boolean;
  version: string;
  shopifyConfigured: boolean;
  storeDomain: string;
  missing: string[];
}

export const getReadiness = (): Promise<ReadinessStatus> =>
  requestJson<ReadinessStatus>('/api/ready');
