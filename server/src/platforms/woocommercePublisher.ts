import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { downloadProductImage } from '../enrichment/imageDownloader.js';
import type { ProductDraft } from '../types.js';
import type { ProductPublishResult } from '../shopify/productPublisher.js';

/** Redact sensitive query param values from URLs in logs. */
const redactUrl = (url: string): string =>
  url.replace(/consumer_key=[^&]*/g, 'consumer_key=[REDACTED]')
     .replace(/consumer_secret=[^&]*/g, 'consumer_secret=[REDACTED]');

/** Write a debug entry to logs/vican-api.log for API request/response tracing. */
const logVican = (message: string, data?: Record<string, unknown>): void => {
  const logPath = path.join(config.logDirectory, 'vican-api.log');
  try {
    fsSync.mkdirSync(path.dirname(logPath), { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      message,
      data: data ? JSON.stringify(data).replace(/"(consumer_key|consumer_secret)":"[^"]*"/g, '"$1":"[REDACTED]"') : undefined,
    };
    fsSync.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* ignore log failures */ }
};

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

// Strip surrounding quotes and validate that the URL has a recognized image
// extension.  Quotes can sneak in from quoted .env values or Excel cell
// formatting; non-image URLs cause WooCommerce to reject the entire create
// request with "woocommerce_product_image_upload_error".
// Only JPEG is allowed — WooCommerce/WooCommerce sideloading is most reliable
// with .jpg URLs; AVIF/WebP/others can cause file-type rejection errors.
const IMAGE_URL_RE = /\.(jpe?g)(\?.*)?$/i;
// Reject AliExpress variant URLs like "xxx.jpg_480x480q75.jpg_.avif" — these
// have mixed extensions that WordPress can't download via media_sideload_image.
// After cleanImageUrl strips the variant suffix, the URL ends in .jpg and this
// check passes as a safety net for any URL that wasn't cleaned.
const ALIEXPRESS_VARIANT_RE = /\.jpg_[^.]/;
// AliExpress variant suffix: "_480x480q75.jpg_.avif" (dimensions + quality +
// format override).  Strips everything from the first "_<w>x<h>q<q>" onward,
// restoring the base .jpg URL so it can be downloaded and converted via Sharp
// if WordPress rejects the format.
const ALIEXPRESS_VARIANT_SUFFIX_RE = /\.(jpe?g|png|gif|webp)_\d+x\d+q\d+.*$/i;
const cleanImageUrl = (url: string): string =>
  url.trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\+$/, '')
    .replace(ALIEXPRESS_VARIANT_SUFFIX_RE, '.$1');

/** Collect image URLs from a product, cleaned and extension-validated.
 *  Returns objects with `src` (remote URL) and an optional `localFilename`/
 *  `localUrl` when the image has already been downloaded to the server's
 *  productimage/ directory. */
interface ImageCandidate {
  src: string;
  alt: string;
  localFilename: string;
  localUrl: string;
}

function getProductImages(product: ProductDraft): ImageCandidate[] {
  const images: ImageCandidate[] = [];
  const seen = new Set<string>();
  const addImage = (url: string) => {
    const cleaned = cleanImageUrl(url);
    if (cleaned && !seen.has(cleaned) && IMAGE_URL_RE.test(cleaned) && !ALIEXPRESS_VARIANT_RE.test(cleaned)) {
      if (cleaned !== url) {
        logVican('image_url_cleaned', {
          productId: product.id,
          original: url.slice(0, 120),
          cleaned: cleaned.slice(0, 120),
        });
      }
      seen.add(cleaned);
      images.push({ src: cleaned, alt: product.title, localFilename: '', localUrl: '' });
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

  // If the primary image was already downloaded locally, prefer the local
  // file — its filename and URL are stored in imageLocalFilename/imageLocalUrl.
  if (product.imageStatus === 'valid' && product.imageLocalFilename) {
    const primary = images[0];
    if (primary) {
      primary.localFilename = product.imageLocalFilename;
      primary.localUrl = product.imageLocalUrl;
    }
  }

  return images;
}

/** Download a remote image URL into the server's productimage/ directory
 *  (reusing the same logic as the retrieve endpoint) and return the local
 *  filename and URL. If the image was already downloaded, returns the cached
 *  filename/URL.
 *
 * Note: the product's imageLocalFilename/imageStatus only tracks the primary
 * image (column A from the workbook). Gallery images from AliExpress enrichment
 * are always downloaded fresh here. */
async function ensureLocalImage(product: ProductDraft, imageUrl: string): Promise<{ filename: string; url: string }> {
  // If this URL is the product's primary image and it was already downloaded
  // during retrieve, reuse the cached local file.
  if (imageUrl === product.imageUrl && product.imageStatus === 'valid' && product.imageLocalFilename) {
    logVican('image_ensure_local_cached', { imageUrl: imageUrl.slice(0, 100), localFilename: product.imageLocalFilename });
    return { filename: product.imageLocalFilename, url: product.imageLocalUrl };
  }
  // Download it now from the server side.
  logVican('image_ensure_local_download', { imageUrl: imageUrl.slice(0, 100), productId: product.id });
  const result = await downloadProductImage(imageUrl, product.id);
  logVican('image_ensure_local_result', { status: result.status, localFilename: result.localFilename, localUrl: result.localUrl, error: result.error });
  return { filename: result.localFilename, url: result.localUrl };
}

/** Build headers for a WordPress media library upload request.
 *  Uses Application Passwords (Basic Auth) when configured, which is the
 *  correct auth for the WordPress REST API (/wp-json/wp/v2/media).
 *  Falls back to WooCommerce OAuth query params if no app password is set. */
function buildMediaUploadHeaders(contentType: string, uploadFilename: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Disposition': `attachment; filename="${uploadFilename}"`,
    'Content-Type': contentType,
  };
  if (config.wooCommerceUsername && config.wooCommerceAppPassword) {
    const credentials = Buffer.from(`${config.wooCommerceUsername}:${config.wooCommerceAppPassword}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }
  return headers;
}

/** Build the media library upload URL, adding credentials as needed. */
function buildMediaUploadUrl(): string {
  const baseUrl = `${config.wooCommerceStoreUrl}/wp-json/wp/v2/media`;
  // When using Application Passwords, credentials go in the Authorization
  // header (Basic Auth), NOT in query params. Only add WC OAuth params if
  // no app password is configured (fallback for older setups).
  if (config.wooCommerceUsername && config.wooCommerceAppPassword) {
    return baseUrl;
  }
  return wooSignUrl(baseUrl, 'POST');
}

/** Upload an image file to the WordPress media library and return the media ID.
 *  Returns null if the upload fails.
 *
 *  Requires WordPress Application Passwords (WOOCOMMERCE_USERNAME +
 *  WOOCOMMERCE_APP_PASSWORD env vars) for authentication to the WordPress
 *  REST API. The WooCommerce consumer_key/secret alone are insufficient
 *  for media uploads (they authenticate to the WC REST API, not WP REST API).
 *
 *  Tries the original image format first (JPEG/PNG/WebP/AVIF). If WordPress
 *  rejects it ("you are not allowed to upload this file type"), falls back to
 *  converting to JPEG via Sharp, which is universally supported. */
async function uploadImageToWooCommerce(localFilename: string, alt: string): Promise<number | null> {
  const filePath = path.join(config.productImageDirectory, localFilename);
  const originalBuffer = await fs.readFile(filePath);
  const ext = path.extname(localFilename).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
                    ext === '.png' ? 'image/png' :
                    ext === '.webp' ? 'image/webp' :
                    ext === '.avif' ? 'image/avif' :
                    ext === '.gif' ? 'image/gif' : 'image/jpeg';

  const uploadUrl = buildMediaUploadUrl();
  const baseName = localFilename.replace(/\.[^.]+$/, '');

  logVican('image_media_upload_request', {
    localFilename, uploadFilename: `ecomint-${baseName}${ext || '.jpg'}`,
    contentType: mimeType,
    fileSize: originalBuffer.byteLength,
    uploadUrl: redactUrl(uploadUrl),
    authMethod: (config.wooCommerceUsername && config.wooCommerceAppPassword) ? 'application_passwords' : 'wc_oauth_fallback',
    hasAppPassword: Boolean(config.wooCommerceAppPassword),
  });

  // First attempt: original format
  const uploadFilename = `ecomint-${baseName}${ext || '.jpg'}`;
  const headers = buildMediaUploadHeaders(mimeType, uploadFilename);
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers,
    body: originalBuffer,
    signal: AbortSignal.timeout(30_000),
  });

  if (response.ok) {
    const media = await response.json() as { id: number };
    logVican('image_media_upload_success', { mediaId: media.id, localFilename });
    return media.id ?? null;
  }

  const errorText = await response.text().catch(() => '');
  logVican('image_media_upload_failed', {
    localFilename, uploadFilename, status: response.status, errorBody: errorText.slice(0, 500),
    uploadUrl: redactUrl(uploadUrl),
    authMethod: (config.wooCommerceUsername && config.wooCommerceAppPassword) ? 'application_passwords' : 'wc_oauth_fallback',
  });

  // 401 = auth/capability failure. Propagate so the caller skips remaining
  // media uploads and avoids triggering 429 rate limits.
  if (response.status === 401 || response.status === 403) {
    const authError = new Error(`WordPress media upload auth failed (HTTP ${response.status}): ${errorText.slice(0, 200)}`);
    (authError as any).statusCode = response.status;
    throw authError;
  }

  // Fall back to JPEG conversion for formats that WordPress may reject
  // (AVIF/WebP/BMP on older WP versions, or corrupted content).
  logVican('image_jpeg_fallback_attempt', { localFilename, originalExt: ext });
  const jpegBuffer = await sharp(originalBuffer)
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  const jpegUploadFilename = `ecomint-${baseName}.jpg`;
  const jpegHeaders = buildMediaUploadHeaders('image/jpeg', jpegUploadFilename);
  const jpegResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: jpegHeaders,
    body: jpegBuffer,
    signal: AbortSignal.timeout(30_000),
  });

  if (jpegResponse.ok) {
    const media = await jpegResponse.json() as { id: number };
    logVican('image_jpeg_fallback_success', { mediaId: media.id, localFilename });
    return media.id ?? null;
  }

  const jpegErrorText = await jpegResponse.text().catch(() => '');
  logVican('image_jpeg_fallback_failed', {
    localFilename, status: jpegResponse.status, errorBody: jpegErrorText.slice(0, 500),
  });
  return null;
}

/** Resolve all product images for the WooCommerce product create/update request.
 *
 *  Three strategies, in priority order:
 *  1. If SERVER_URL is set → serve from the eComInt server's public URL
 *  2. Else → try WordPress media library upload → use media ID
 *  3. Fall back to the original remote URL */
async function resolveProductImages(
  product: ProductDraft,
  imageCandidates: ImageCandidate[],
): Promise<Array<{ id?: number; src?: string; alt: string }>> {
  const serverUrl = config.serverUrl;
  const uploaded: Array<{ id?: number; src?: string; alt: string }> = [];
  const seen = new Set<string>();

  // If the first media upload returns 401 (auth/capability), skip all
  // remaining media uploads to avoid triggering 429 rate limits.
  let mediaUploadsBlocked = false;

  for (const image of imageCandidates) {
    if (seen.has(image.src)) continue;
    seen.add(image.src);

    // Ensure the image is available as a local file.
    let localFilename = image.localFilename;
    let localUrl = image.localUrl;
    if (!localFilename) {
      const result = await ensureLocalImage(product, image.src);
      localFilename = result.filename;
      localUrl = result.url;
    }

    if (!localFilename) {
      // Could not download — fall back to remote URL.
      logVican('image_resolve_no_local_file', { src: image.src.slice(0, 100) });
      uploaded.push({ src: image.src, alt: image.alt });
      continue;
    }

    // Strategy 1: Server URL — serve directly from the eComInt server.
    if (serverUrl && localUrl) {
      const imageUrl = `${serverUrl}${localUrl}`;
      logVican('image_resolve_server_url', { localUrl, publicUrl: imageUrl.slice(0, 120) });
      uploaded.push({ src: imageUrl, alt: image.alt });
      continue;
    }

    // Strategy 2: WordPress media library upload.
    if (mediaUploadsBlocked) {
      // Previous upload returned 401 — skip media uploads entirely.
      logVican('image_resolve_media_blocked_skip', { localFilename, src: image.src.slice(0, 100) });
      uploaded.push({ src: image.src, alt: image.alt });
      continue;
    }

    try {
      const mediaId = await uploadImageToWooCommerce(localFilename, image.alt);
      if (mediaId !== null) {
        uploaded.push({ id: mediaId, alt: image.alt });
        // Small delay between uploads to avoid triggering rate limiting.
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
    } catch (error) {
      const statusCode = (error as any).statusCode;
      // 401/403 = auth/capability failure → skip all remaining media uploads.
      if (statusCode === 401 || statusCode === 403) {
        mediaUploadsBlocked = true;
        logVican('image_resolve_media_blocked', {
          localFilename,
          statusCode,
          message: error instanceof Error ? error.message : String(error),
        });
        uploaded.push({ src: image.src, alt: image.alt });
        continue;
      }
      logVican('image_resolve_upload_error', {
        localFilename,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Strategy 3: Remote URL fallback (old behavior).
    logVican('image_resolve_remote_url_fallback', { src: image.src.slice(0, 100) });
    uploaded.push({ src: image.src, alt: image.alt });
  }

  return uploaded;
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

  const imageCandidates = getProductImages(product);
  logVican('publish_start', {
    productId: product.id,
    title: product.title,
    supplier: product.supplier,
    serverUrl: config.serverUrl || null,
    imageCandidates: imageCandidates.length,
    candidateFilenames: imageCandidates.map((c) => ({ src: c.src.slice(0, 100), localFilename: c.localFilename, localUrl: c.localUrl })),
  });

  const productImages = await resolveProductImages(product, imageCandidates);
  logVican('publish_product_images', { images: productImages });
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
      tags: tags.length ? tags.map((tag) => ({ name: tag })) : [],
      images: productImages,
      ...(categoryIds && categoryIds.length ? { categories: categoryIds.map((id) => ({ id: parseInt(id, 10) })) } : {}),
      meta_data: [
        { key: '_cost_price', value: (product.costPrice ?? product.unitPrice ?? 0).toString() },
        { key: '_supplier_type', value: product.supplierType || 'vican' },
        { key: '_source_platform', value: product.supplier || 'aliexpress' },
        { key: '_unit_price', value: (product.unitPrice ?? 0).toString() },
        { key: 'product_category', value: product.productType || '' },
        { key: 'sub_category', value: product.containerType || '' },
        { key: 'brand', value: product.brand || '' },
      ],
    };

    logVican('publish_product_request', {
      action: isUpdate ? 'update' : 'create',
      productId: productId?.toString() ?? null,
      body: JSON.stringify(body, null, 0).slice(0, 2000),
      imageCount: (body.images as Array<unknown>).length,
      imageTypes: (body.images as Array<{ id?: number; src?: string }>).map((img) => img.id ? `id:${img.id}` : img.src ? `src:${(img.src as string).slice(0, 80)}` : 'unknown'),
    });

    let wooId: number;
    let action: 'created' | 'updated';

    if (isUpdate) {
      const url = wooSignUrl(`${config.wooCommerceStoreUrl}/wp-json/${config.wooCommerceApiVersion}/products/${productId}`, 'PUT');
      logVican('publish_update_request', { url: redactUrl(url), body: JSON.stringify(body).slice(0, 2000) });
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      logVican('publish_update_response', { status: response.status, body: text.slice(0, 500) });
      if (!response.ok) {
        return { status: 'failed', action: 'updated', shopifyProductId: null, matchCount: 1, error: `WooCommerce update failed: ${text}` };
      }
      const updated: WooProductResponse = JSON.parse(text) as WooProductResponse;
      wooId = updated.id;
      action = 'updated';
    } else {
      const url = wooSignUrl(`${config.wooCommerceStoreUrl}/wp-json/${config.wooCommerceApiVersion}/products`, 'POST');
      logVican('publish_create_request', { url: redactUrl(url), body: JSON.stringify(body).slice(0, 2000) });
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      logVican('publish_create_response', { status: response.status, body: text.slice(0, 500) });
      if (!response.ok) {
        return { status: 'failed', action: 'created', shopifyProductId: null, matchCount: 0, error: `WooCommerce create failed: ${text}` };
      }
      const created: WooProductResponse = JSON.parse(text) as WooProductResponse;
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
