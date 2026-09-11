import crypto from 'node:crypto';
import { config } from '../config.js';
import type { PlatformClient, PlatformProductData, PublishResult, ProductMatch } from './platformClient.js';

// Strip surrounding quotes and validate image extension before sending
// URLs to WooCommerce.  WooCommerce's own media-upload endpoint is the
// preferred path for images (see uploadImagesToMediaLibrary), but these
// helpers remain as a fallback for remote-URL image references.
const IMAGE_URL_RE = /\.(jpe?g|png|webp|gif|bmp|avif)(\?.*)?$/i;
const cleanImageUrl = (url: string): string => url.trim().replace(/^["']|["']$/g, '');

/** Simple OAuth 1.0a helper for WooCommerce REST API (Consumer Key/Secret). */
function wooCommerceSignUrl(url: string, method: string): string {
  const consumerKey = config.wooCommerceConsumerKey;
  const consumerSecret = config.wooCommerceConsumerSecret;
  if (!consumerKey || !consumerSecret) return url;

  const params = new URLSearchParams({
    consumer_key: consumerKey,
    consumer_secret: consumerSecret,
  });
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${params.toString()}`;
}

interface WooProduct {
  id: number;
  name: string;
  status: string;
  type: string;
  images: Array<{ id: number; src: string }>;
  meta_data: Array<{ id: number; key: string; value: string | number }>;
}

interface WooProductVariant {
  id: number;
  regular_price: string;
  stock_quantity: number | null;
}

interface WooUpdateStock {
  stock_quantity: number;
  manage_stock: boolean;
}

/** WooCommerce implementation of PlatformClient. */
export class WooCommerceClient implements PlatformClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = config.wooCommerceStoreUrl;
  }

  getPlatformName(): string {
    return 'woocommerce';
  }

  async queryProducts(title: string): Promise<ProductMatch[]> {
    const url = wooCommerceSignUrl(
      `${this.baseUrl}/wp-json/wc/v3/products?search=${encodeURIComponent(title)}&per_page=20`,
      'GET',
    );
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return [];
    const products: WooProduct[] = await response.json();
    return products
      .filter((product) => product.name.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase())
      .map((product) => ({
        id: String(product.id),
        title: product.name,
        matchConfidence: 1.0,
      }));
  }

  async createProduct(product: PlatformProductData): Promise<PublishResult> {
    try {
      const body = this.buildProductBody(product);
      const url = wooCommerceSignUrl(`${this.baseUrl}/wp-json/wc/v3/products`, 'POST');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const errorText = await response.text();
        return { action: 'created', status: 'failed', platformProductId: null, error: `WooCommerce create failed: ${errorText}` };
      }
      const created: WooProduct = await response.json();
      await this.updateInventory(String(created.id), product.inventoryQuantity);
      return { action: 'created', status: 'published', platformProductId: String(created.id), error: '' };
    } catch (error) {
      return { action: 'created', status: 'failed', platformProductId: null, error: error instanceof Error ? error.message : 'WooCommerce create failed.' };
    }
  }

  async updateProduct(productId: string, product: PlatformProductData): Promise<PublishResult> {
    try {
      const body = this.buildProductBody(product);
      const url = wooCommerceSignUrl(`${this.baseUrl}/wp-json/wc/v3/products/${productId}`, 'PUT');
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const errorText = await response.text();
        return { action: 'updated', status: 'failed', platformProductId: productId, error: `WooCommerce update failed: ${errorText}` };
      }
      await this.updateInventory(productId, product.inventoryQuantity);
      return { action: 'updated', status: 'published', platformProductId: productId, error: '' };
    } catch (error) {
      return { action: 'updated', status: 'failed', platformProductId: productId, error: error instanceof Error ? error.message : 'WooCommerce update failed.' };
    }
  }

  async updateInventory(productId: string, quantity: number): Promise<void> {
    const url = wooCommerceSignUrl(`${this.baseUrl}/wp-json/wc/v3/products/${productId}`, 'PUT');
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: productId, stock_quantity: quantity, manage_stock: true } as WooUpdateStock),
      signal: AbortSignal.timeout(15_000),
    });
  }

  /** Build the JSON body for a WooCommerce product create/update request. */
  private buildProductBody(product: PlatformProductData): Record<string, unknown> {
    const body: Record<string, unknown> = {
      name: product.title,
      type: 'simple',
      status: 'publish',
      description: product.descriptionHtml,
      short_description: product.descriptionHtml,
      images: product.imageUrls
        .map(cleanImageUrl)
        .filter((url) => IMAGE_URL_RE.test(url))
        .map((url) => ({ src: url })),
      meta_data: [
        { key: '_ecomint_unit_price', value: product.unitPrice ?? '' },
        { key: '_ecomint_supplier_type', value: product.supplierType },
        { key: '_ecomint_source_platform', value: product.sourcePlatform },
      ],
    };

    if (product.selectedCollectionIds.length > 0) {
      body.tag_ids = product.selectedCollectionIds;
    }

    return body;
  }
}
