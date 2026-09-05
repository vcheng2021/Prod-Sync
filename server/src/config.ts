import 'dotenv/config';
import path from 'node:path';

const parseAllowlist = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

interface ShopifyCollection {
  name: string;
  id: string;
}

const stripQuotes = (value: string): string => value.replace(/^["']|["']$/g, '');

const parseShopifyCollections = (value: string | undefined): ShopifyCollection[] => {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIndex = entry.indexOf(':');
      if (colonIndex === -1) return null;
      const name = stripQuotes(entry.slice(0, colonIndex).trim());
      const id = stripQuotes(entry.slice(colonIndex + 1).trim());
      return name && id ? { name, id } : null;
    })
    .filter((entry): entry is ShopifyCollection => entry !== null);
};

export const config = {
  appVersion: process.env.APP_VERSION ?? '0.1.0',
  port: Number(process.env.PORT ?? 8787),
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN ?? 'cb1710-2.myshopify.com',
  shopifyAdminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ?? '',
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION ?? '2026-07',
  sourceUrlAllowlist: parseAllowlist(process.env.SOURCE_URL_ALLOWLIST),
  databasePath: path.resolve(process.cwd(), process.env.DATABASE_PATH ?? './data/ecomint.db'),
  productImageDirectory: path.resolve(process.cwd(), process.env.PRODUCT_IMAGE_DIRECTORY ?? './productimage'),
  logDirectory: path.resolve(process.cwd(), process.env.LOG_DIRECTORY ?? './logs'),
  shopifyLocationId: process.env.SHOPIFY_LOCATION_ID ?? '',
  shopifyFeaturedCollectionId: process.env.SHOPIFY_FEATURED_COLLECTION_ID ?? '',
  shopifyCollections: parseShopifyCollections(process.env.SHOPIFY_COLLECTION_ID),
  maxImportRows: Number(process.env.MAX_IMPORT_ROWS ?? 10000),
  defaultWorkbookPath: path.resolve(process.cwd(), 'suppliers', 'sup2_paramountliquor.xlsx'),
  sourceRequestTimeoutMs: Number(process.env.SOURCE_REQUEST_TIMEOUT_MS ?? 12_000),
  sourceMaxRedirects: Number(process.env.SOURCE_MAX_REDIRECTS ?? 3),
  sourceMaxResponseBytes: Number(process.env.SOURCE_MAX_RESPONSE_BYTES ?? 5 * 1024 * 1024),
  sourceCatalogEndpoint: process.env.SOURCE_CATALOG_ENDPOINT ?? '/rest/V1/product/getAllProduct',
  sourceCatalogMaxResponseBytes: Number(process.env.SOURCE_CATALOG_MAX_RESPONSE_BYTES ?? 50 * 1024 * 1024),
  sourceDescriptionEndpoint: process.env.SOURCE_DESCRIPTION_ENDPOINT ?? '/rest/V1/product-description',
  imageRequestTimeoutMs: Number(process.env.IMAGE_REQUEST_TIMEOUT_MS ?? 15_000),
  imageMaxRedirects: Number(process.env.IMAGE_MAX_REDIRECTS ?? 3),
  imageMaxBytes: Number(process.env.IMAGE_MAX_BYTES ?? 15 * 1024 * 1024),
  imageDownloadConcurrency: Number(process.env.IMAGE_DOWNLOAD_CONCURRENCY ?? 3),
};

export const shopifyConfigured = Boolean(config.shopifyAdminAccessToken);
