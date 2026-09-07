/** Common product match result returned by all platform clients. */
export interface ProductMatch {
  id: string;
  title: string;
  matchConfidence: number;
}

/** Result of publishing a product to a platform. */
export interface PublishResult {
  action: 'created' | 'updated' | 'skipped';
  status: 'published' | 'failed' | 'skipped';
  platformProductId: string | null;
  error: string;
}

/** Product data needed for create/update on any platform. */
export interface PlatformProductData {
  title: string;
  descriptionHtml: string;
  imageUrls: string[];
  suggestedSalePrice: number;
  unitPrice: number | null;
  inventoryQuantity: number;
  sourcePlatform: string;
  supplierType: string;
  brand: string;
  country: string;
  productType: string;
  selectedCollectionIds: string[];
}

/** Abstract interface that all e-commerce platform clients must implement. */
export interface PlatformClient {
  /** Query existing products by title to find matches. */
  queryProducts(title: string): Promise<ProductMatch[]>;
  /** Create a new product on the platform. */
  createProduct(product: PlatformProductData): Promise<PublishResult>;
  /** Update an existing product on the platform. */
  updateProduct(productId: string, product: PlatformProductData): Promise<PublishResult>;
  /** Set inventory quantity for a product. */
  updateInventory(productId: string, quantity: number): Promise<void>;
  /** Get the platform name. */
  getPlatformName(): string;
}
