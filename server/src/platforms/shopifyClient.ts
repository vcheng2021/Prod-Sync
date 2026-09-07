import { config } from '../config.js';
import type { ProductDraft } from '../types.js';
import { publishProduct, type ProductPublishResult } from '../shopify/productPublisher.js';
import type { PlatformClient, PlatformProductData, PublishResult, ProductMatch } from './platformClient.js';

/** Shopify implementation of PlatformClient. */
export class ShopifyClient implements PlatformClient {
  getPlatformName(): string {
    return 'shopify';
  }

  async queryProducts(title: string): Promise<ProductMatch[]> {
    // Reuse the existing match-finding logic from the publisher
    const { findProductMatches } = await import('../shopify/productPublisher.js');
    const rawMatches = await findProductMatches(title);
    return rawMatches.map((match) => ({
      id: match.id,
      title: match.title,
      matchConfidence: 1.0,
    }));
  }

  async createProduct(product: PlatformProductData): Promise<PublishResult> {
    const draftProduct = this.toProductDraft(product);
    const result = await publishProduct(draftProduct);
    return {
      action: result.action,
      status: result.status,
      platformProductId: result.shopifyProductId,
      error: result.error,
    };
  }

  async updateProduct(_productId: string, product: PlatformProductData): Promise<PublishResult> {
    const draftProduct = this.toProductDraft(product);
    const result = await publishProduct(draftProduct);
    return {
      action: result.action,
      status: result.status,
      platformProductId: result.shopifyProductId,
      error: result.error,
    };
  }

  async updateInventory(_productId: string, _quantity: number): Promise<void> {
    // Inventory is handled within publishProduct in the Shopify implementation
  }

  /** Convert PlatformProductData to a ProductDraft for the existing Shopify publisher. */
  private toProductDraft(product: PlatformProductData): ProductDraft {
    return {
      id: '',
      draftId: '',
      rowNumber: 0,
      supplierProductKey: '',
      imageUrl: product.imageUrls[0] ?? '',
      imageUrls: product.imageUrls,
      imageLocalFilename: '',
      imageLocalUrl: '',
      imageStatus: 'valid',
      title: product.title,
      sourceUrl: '',
      stockOnHand: null,
      casePrice: null,
      unitPrice: product.unitPrice,
      suggestedSalePrice: product.suggestedSalePrice,
      inventoryQuantity: product.inventoryQuantity,
      descriptionHtml: product.descriptionHtml,
      brand: product.brand,
      country: product.country,
      region: '',
      productType: product.productType,
      supplierType: product.supplierType,
      sourcePlatform: product.sourcePlatform,
      abv: '',
      containerType: '',
      style: '',
      enrichmentStatus: 'ready',
      enrichmentError: '',
      enrichmentFetchedAt: null,
      selected: true,
      publishStatus: 'pending',
      publishError: '',
      shopifyProductId: null,
      shopifyMatchCount: null,
      validationErrors: [],
      raw: {},
      featured: false,
      publishToOnlineStore: true,
      selectedCollectionIds: product.selectedCollectionIds,
    };
  }
}
