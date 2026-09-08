import crypto from 'node:crypto';
import { config } from '../config.js';
import type { ProductDraft } from '../types.js';
import type { ProductPublishResult } from '../shopify/productPublisher.js';

interface WooProduct {
  id: number;
  name: string;
  status: string;
  type: string;
  images: Array<{ id: number; src: string }>;
  regular_price: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  meta_data: Array<{ id: number; key: string; value: string | number }>;
}

interface WooProductResponse {
  id: number;
  name: string;
  status: string;
  type: string;
  images: Array<{ id: number; src: string }>;
  regular_price: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  meta_data: Array<{ id: number; key: string; value: string | number }>;
}

function wooSignUrl(url: string, method: string): string {
  const key = config.wooCommerceConsumerKey;
  const secret = config.wooCommerceConsumerSecret;
  if (!key || !secret) return url;
  const params = new URLSearchParams({ consumer_key: key, consumer_secret: secret });
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${params.toString()}`;
}

function buildDescription(product: ProductDraft): string {
  const parts: string[] = [];
  if (product.descriptionHtml) parts.push(product.descriptionHtml);
  const fields: Array<[string, string]> = [
    ['Product Description', product.productDescription],
    ['Product Attributes', product.productAttributes],
  ];
  const rows = fields.filter(([, v]) => v && v.trim().length > 0);
  if (rows.length) {
    parts.push('<h3>Product Details</h3><ul>' + rows.map(([l, v]) => `<li><strong>${l}:</strong> ${v}</li>`).join('') + '</ul>');
  }
  return parts.join('');
}

function buildTags(product: ProductDraft): string[] {
  return [product.brand, product.productType, product.country].filter((v) => v.trim().length > 0);
}

function getProductImages(product: ProductDraft): Array<{ src: string; alt: string }> {
  const images: Array<{ src: string; alt: string }> = [];
  const seen = new Set<string>();
  const addImage = (url: string) => {
    const trimmed = url.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      images.push({ src: trimmed, alt: product.title });
    }
  };

  // AliExpress: main image first (selectedImageIndex), then gallery images
  if (product.aliexpressImages && product.aliexpressImages.length > 0) {
    const idx = product.selectedImageIndex ?? 0;
    const selectedImage = product.aliexpressImages[idx] ?? product.aliexpressImages[0];
    if (selectedImage) addImage(selectedImage);
    for (const imageUrl of product.aliexpressImages) {
      addImage(imageUrl);
    }
  }
  // Fallback to primary imageUrl (Cellar/Drive style)
  if (product.imageUrl) addImage(product.imageUrl);

  return images;
}

async function findWooMatches(title: string): Promise<Array<{ id: number; name: string }>> {
  const url = wooSignUrl(`${config.wooCommerceStoreUrl}/wp-json/${config.wooCommerceApiVersion}/products?search=${encodeURIComponent(title)}&per_page=20`, 'GET');
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return [];
  const products: WooProduct[] = await response.json();
  return products.filter((p) => p.name.toLowerCase() === title.toLowerCase()).map((p) => ({ id: p.id, name: p.name }));
}

export const publishToWooCommerce = async (product: ProductDraft, categoryIds?: string[]): Promise<ProductPublishResult> => {
  if (!product.title.trim()) return { status: 'skipped', action: 'skipped', shopifyProductId: null, matchCount: 0, error: 'Title is required.' };
  if (product.suggestedSalePrice === null || !Number.isFinite(product.suggestedSalePrice) || product.suggestedSalePrice <= 0) return { status: 'skipped', action: 'skipped', shopifyProductId: null, matchCount: 0, error: 'A valid suggested sale price is required.' };
  if (!Number.isInteger(product.inventoryQuantity) || product.inventoryQuantity < 0) return { status: 'skipped', action: 'skipped', shopifyProductId: null, matchCount: 0, error: 'Inventory must be a non-negative whole number.' };
  if (!config.wooCommerceStoreUrl || !config.wooCommerceConsumerKey || !config.wooCommerceConsumerSecret) return { status: 'failed', action: 'skipped', shopifyProductId: null, matchCount: 0, error: 'WooCommerce is not configured. Check WOOCOMMERCE_* env values.' };

  const productImages = getProductImages(product);
  const descriptionHtml = buildDescription(product);
  const tags = buildTags(product);

  let matches: Array<{ id: number; name: string }>;
  try {
    matches = await findWooMatches(product.title);
  } catch (error) {
    return { status: 'failed', action: 'skipped', shopifyProductId: null, matchCount: 0, error: error instanceof Error ? error.message : 'WooCommerce product matching failed.' };
  }

  if (matches.length > 1) {
    return { status: 'skipped', action: 'skipped', shopifyProductId: null, matchCount: matches.length, error: 'Multiple WooCommerce products match this title.' };
  }

  const productId = matches.length === 1 ? matches[0].id : null;
  const isUpdate = productId !== null;

  try {
    const body: Record<string, unknown> = {
      name: product.title.trim(),
      type: 'simple',
      status: 'publish',
      description: descriptionHtml,
      short_description: product.productDescription || product.descriptionHtml || '',
      regular_price: product.suggestedSalePrice.toFixed(2),
      manage_stock: true,
      stock_quantity: product.inventoryQuantity,
      tags: tags.length ? tags.join(', ') : '',
      images: productImages,
      ...(categoryIds && categoryIds.length ? { categories: categoryIds.map((id) => ({ id: parseInt(id, 10) })) } : {}),
      meta_data: [
        { key: '_cost_price', value: (product.costPrice ?? 0).toString() },
        { key: '_supplier_type', value: product.supplierType || 'vican' },
        { key: '_source_platform', value: 'aliexpress' },
        { key: '_unit_price', value: (product.unitPrice ?? 0).toString() },
      ],
    };

    let wooId: number;
    let action: 'created' | 'updated';

    if (isUpdate) {
      const url = wooSignUrl(`${config.wooCommerceStoreUrl}/wp-json/${config.wooCommerceApiVersion}/products/${productId}`, 'PUT');
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const text = await response.text();
        return { status: 'failed', action: 'updated', shopifyProductId: null, matchCount: 1, error: `WooCommerce update failed: ${text}` };
      }
      const updated: WooProductResponse = await response.json();
      wooId = updated.id;
      action = 'updated';
    } else {
      const url = wooSignUrl(`${config.wooCommerceStoreUrl}/wp-json/${config.wooCommerceApiVersion}/products`, 'POST');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const text = await response.text();
        return { status: 'failed', action: 'created', shopifyProductId: null, matchCount: 0, error: `WooCommerce create failed: ${text}` };
      }
      const created: WooProductResponse = await response.json();
      wooId = created.id;
      action = 'created';
    }

    return {
      status: 'published',
      action,
      shopifyProductId: String(wooId),
      matchCount: matches.length,
      error: '',
    };
  } catch (error) {
    return {
      status: 'failed',
      action: isUpdate ? 'updated' : 'created',
      shopifyProductId: productId?.toString() ?? null,
      matchCount: matches.length,
      error: error instanceof Error ? error.message : 'WooCommerce publishing failed.',
    };
  }
};
