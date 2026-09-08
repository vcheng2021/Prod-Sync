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
  // VIC-17: AliExpress-specific fields
  productAttributes: string;
  productDescription: string;
  aliexpressImages: string[];
  originalProductAttributes: string;
  originalProductDescription: string;
  selectedImageIndex: number;
  costPrice: number | null;
  // VIC-18: supplier routing
  supplier: string;
  // UI state
  featured: boolean;
  publishToOnlineStore: boolean;
  selectedCollectionIds: string[];
  // Import validation
  validationErrors: string[];
  raw: Record<string, unknown>;
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
    supplier: string;
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
  const response = await fetch(input, { credentials: 'include', ...init });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<T>;
};

export const importWorkbook = async (file: File, supplier?: string): Promise<ImportResponse> => {
  const form = new FormData();
  form.append('workbook', file);
  if (supplier) form.append('supplier', supplier);
  return requestJson<ImportResponse>('/api/imports', { method: 'POST', body: form });
};

export const getCurrentDraft = (): Promise<DraftResponse | null> => requestJson<DraftResponse | null>('/api/drafts/current');

// VIC-22: Fetch the most recent draft filtered by supplier
export const getCurrentDraftBySupplier = (supplier: string): Promise<DraftResponse | null> =>
  requestJson<DraftResponse | null>(`/api/drafts/current?supplier=${encodeURIComponent(supplier)}`);

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

// VIC-20 Issue 7: Image download is a separate explicit action, not bundled
// with source page retrieval.
export const downloadProductImage = (draftId: string, productId: string): Promise<ProductDraft> =>
  requestJson<ProductDraft>(`/api/drafts/${draftId}/products/${productId}/images`, { method: 'POST' });

export const publishProducts = (draftId: string, productIds: string[], changes: Array<{ id: string; changes: Partial<ProductDraft> }> = [], globalCollectionIds: string[] = [], globalCategoryIds: string[] = []): Promise<{ results: Array<{ productId: string; status: PublishStatus; error: string }>; draft: DraftResponse }> =>
  requestJson(`/api/drafts/${draftId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true, productIds, changes, globalCollectionIds, globalCategoryIds }),
  });

export const exportDraftUrl = (draftId: string): string => `/api/drafts/${draftId}/export`;

export interface CollectionOption {
  name: string;
  id: string;
}

export interface ProductsLoadEntry {
  timestamp: string;
  productId: string;
  supplierProductKey: string;
  title: string;
  sourceUrl: string;
  fieldsLoaded: string[];
  fieldsFailed: string[];
  error: string;
  draftId: string;
}

export const getProductsLoad = (draftId?: string): Promise<ProductsLoadEntry[]> =>
  requestJson<ProductsLoadEntry[]>(draftId ? `/api/productsload?draftId=${encodeURIComponent(draftId)}` : '/api/productsload');

export interface ReadinessStatus {
  ok: boolean;
  version: string;
  shopifyConfigured: boolean;
  storeDomain: string;
  missing: string[];
  collections: CollectionOption[];
  wooCategories: CollectionOption[];
  wooConfigured: boolean;
  wooStoreUrl: string;
  wooMissing: string[];
}

export const getReadiness = (): Promise<ReadinessStatus> =>
  requestJson<ReadinessStatus>('/api/ready');

export const registerUser = (username: string, password: string): Promise<{ ok: boolean; user: { id: string; username: string } }> =>
  requestJson('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });

export const loginUser = (username: string, password: string): Promise<{ ok: boolean; user: { id: string; username: string } }> =>
  requestJson('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });

export const logoutUser = (): Promise<{ ok: boolean }> =>
  requestJson('/api/auth/logout', { method: 'POST' });

export const getCurrentUser = (): Promise<{ authenticated: boolean; user?: { id: string; username: string; createdAt: string } }> =>
  requestJson('/api/auth/me');
