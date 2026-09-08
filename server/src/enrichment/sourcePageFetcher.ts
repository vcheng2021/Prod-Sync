import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import type { EnrichedProductDetails, FetchResult } from '../types.js';
import { extractProductDetails, extractAliexpressProductDetails, extractSupplierProductDetails, type SupplierProductPayload } from './productDetailsExtractor.js';
import { plainTextToHtml } from './htmlSanitizer.js';

const emptyDetails = (): EnrichedProductDetails => ({
  descriptionHtml: '',
  brand: '',
  country: '',
  region: '',
  productType: '',
  abv: '',
  containerType: '',
  style: '',
});

const emptyFetchResult = (): FetchResult => ({
  status: 'failed',
  details: emptyDetails(),
  error: '',
  failedFields: [],
});

const isPrivateAddress = (address: string): boolean => {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return true;
};

const validateUrl = async (rawUrl: string): Promise<URL> => {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS source URLs are allowed.');
  if (url.username || url.password) throw new Error('Source URL credentials are not allowed.');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('Local source URLs are blocked.');
  if (config.sourceUrlAllowlist.length > 0 && !config.sourceUrlAllowlist.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))) {
    throw new Error('Source host is not in the configured allowlist.');
  }
  const addresses = await dns.lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('Private or unavailable source address is blocked.');
  return url;
};

const readBody = async (response: Response, maxBytes = config.sourceMaxResponseBytes): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error('Source response is too large.');
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
};

const supplierCatalogCache = new Map<string, Map<string, SupplierProductPayload>>();
const supplierCatalogRequests = new Map<string, Promise<Map<string, SupplierProductPayload>>>();

const fetchSupplierCatalog = async (sourceUrl: URL): Promise<Map<string, SupplierProductPayload>> => {
  const cached = supplierCatalogCache.get(sourceUrl.origin);
  if (cached) return cached;
  const pending = supplierCatalogRequests.get(sourceUrl.origin);
  if (pending) return pending;
  const request = (async () => {
    const response = await fetch(`${sourceUrl.origin}${config.sourceCatalogEndpoint}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 eComInt product importer/1.0' },
      signal: AbortSignal.timeout(config.sourceRequestTimeoutMs),
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) return new Map<string, SupplierProductPayload>();
    const payload = JSON.parse(await readBody(response, config.sourceCatalogMaxResponseBytes)) as unknown;
    const products = Array.isArray(payload) ? payload as SupplierProductPayload[] : [];
    const productsBySku = new Map<string, SupplierProductPayload>();
    products.forEach((product) => { if (product.sku) productsBySku.set(String(product.sku), product); });
    supplierCatalogCache.set(sourceUrl.origin, productsBySku);
    return productsBySku;
  })();
  supplierCatalogRequests.set(sourceUrl.origin, request);
  try {
    return await request;
  } finally {
    supplierCatalogRequests.delete(sourceUrl.origin);
  }
};

const fetchSupplierDescription = async (sourceUrl: URL): Promise<string> => {
  const pathParts = sourceUrl.pathname.split('/').filter(Boolean);
  if (pathParts.length !== 2 || pathParts[0].toLocaleLowerCase() !== 'products') return '';
  const response = await fetch(`${sourceUrl.origin}${config.sourceDescriptionEndpoint}/${encodeURIComponent(pathParts[1])}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 eComInt product importer/1.0' },
    signal: AbortSignal.timeout(config.sourceRequestTimeoutMs),
  });
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) return '';
  const payload = JSON.parse(await readBody(response)) as unknown;
  const description = Array.isArray(payload)
    ? String(payload[1] || payload[0] || '').trim()
    : String(payload || '').trim();
  return description ? plainTextToHtml(description) : '';
};

const fetchSupplierProduct = async (sourceUrl: URL): Promise<EnrichedProductDetails | null> => {
  const pathParts = sourceUrl.pathname.split('/').filter(Boolean);
  if (pathParts.length !== 2 || pathParts[0].toLocaleLowerCase() !== 'products') return null;
  const catalog = await fetchSupplierCatalog(sourceUrl);
  const catalogProduct = catalog.get(pathParts[1]);
  if (catalogProduct) return extractSupplierProductDetails(catalogProduct);
  const response = await fetch(`${sourceUrl.origin}/graphql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'eComInt product importer/1.0' },
    body: JSON.stringify({
      query: 'query ProductByUrlKey($urlKey: String!) { products(filter: { url_key: { eq: $urlKey } }, pageSize: 1) { items { name description { html } meta_description country_of_manufacture custom_attributesV2 { items { code ... on AttributeValue { value } } } } } }',
      variables: { urlKey: pathParts[1] },
    }),
    signal: AbortSignal.timeout(config.sourceRequestTimeoutMs),
  });
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) return null;
  const payload = JSON.parse(await readBody(response)) as { data?: { products?: { items?: SupplierProductPayload[] } } };
  const product = payload.data?.products?.items?.[0];
  return product ? extractSupplierProductDetails(product) : null;
};

export const fetchProductDetails = async (rawUrl: string, supplier?: string): Promise<FetchResult> => {
  try {
    let url = await validateUrl(rawUrl);
    const [supplierDetails, supplierDescription] = await Promise.all([
      fetchSupplierProduct(url).catch(() => null),
      fetchSupplierDescription(url).catch(() => ''),
    ]);
    const mergedSupplierDetails = supplierDetails ? { ...supplierDetails, descriptionHtml: supplierDescription || supplierDetails.descriptionHtml } : null;
    if (mergedSupplierDetails && Object.values(mergedSupplierDetails).some((value) => typeof value === 'string' && value.trim().length > 0)) {
      return { status: 'ready', details: mergedSupplierDetails, error: '', failedFields: [] };
    }
    for (let redirect = 0; redirect <= config.sourceMaxRedirects; redirect += 1) {
      const response = await fetch(url, {
        headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'eComInt product importer/1.0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(config.sourceRequestTimeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirect === config.sourceMaxRedirects) throw new Error('Too many or invalid source redirects.');
        url = await validateUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new Error('Source did not return an HTML page.');
      // Partial enrichment: extract each field independently, track failures
      const html = await readBody(response);
      const fields = ['descriptionHtml', 'brand', 'country', 'region', 'productType', 'abv', 'containerType', 'style'];
      const details: EnrichedProductDetails = { descriptionHtml: '', brand: '', country: '', region: '', productType: '', abv: '', containerType: '', style: '' };
      const failedFields: string[] = [];
      const partialDetails: Partial<EnrichedProductDetails> = {};
      for (const field of fields) {
        try {
          const value = extractProductDetails(html)[field as keyof EnrichedProductDetails];
          if (value && typeof value === 'string' && value.trim().length > 0) {
            ((details as unknown) as Record<string, string>)[field] = value;
            ((partialDetails as unknown) as Record<string, string>)[field] = value;
          }
        } catch {
          failedFields.push(field);
        }
      }
      // VIC-17: AliExpress-specific extraction.
      // Detect AliExpress both by URL hostname AND by supplier field (Issue 8:
      // some vican source URLs may not match the .aliexpress.com pattern, e.g.
      // redirected or aliased product links).
      const isAliExpressUrl = url.hostname === 'www.aliexpress.com' || url.hostname === 'aliexpress.com' || url.hostname.endsWith('.aliexpress.com');
      const isAliExpressSupplier = supplier === 'aliexpress' || supplier === 'vican';
      const isAliExpress = isAliExpressUrl || isAliExpressSupplier;
      if (isAliExpress) {
        const aliexpressDetails = extractAliexpressProductDetails(html);
        if (aliexpressDetails.images.length > 0) {
          details.aliexpressImages = aliexpressDetails.images;
          partialDetails.aliexpressImages = aliexpressDetails.images;
        }
        if (aliexpressDetails.descriptionHtml.trim().length > 0) {
          details.productDescription = aliexpressDetails.descriptionHtml;
          // For AliExpress, use the extracted description as descriptionHtml fallback
          // so the standard Description textarea is also populated.
          if (!details.descriptionHtml) details.descriptionHtml = aliexpressDetails.descriptionHtml;
          if (!partialDetails.descriptionHtml) partialDetails.descriptionHtml = aliexpressDetails.descriptionHtml;
          partialDetails.productDescription = aliexpressDetails.descriptionHtml;
        } else {
          failedFields.push('productDescription');
        }
        if (aliexpressDetails.attributesHtml.trim().length > 0 || Object.keys(aliexpressDetails.attributeFields).length > 0) {
          details.productAttributes = aliexpressDetails.attributesHtml || Object.entries(aliexpressDetails.attributeFields)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n');
          partialDetails.productAttributes = details.productAttributes;
        } else {
          failedFields.push('productAttributes');
        }
      }
      const hasProductData = Object.values(details).some((value) => typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) && value.length > 0);
      if (!hasProductData) throw new Error('No product-specific data was found at the source URL.');
      return {
        status: 'ready',
        details,
        error: failedFields.length > 0 ? `Partial enrichment: ${failedFields.join(', ')} failed` : '',
        partialDetails,
        failedFields,
      };
    }
    throw new Error('Source fetch failed.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Source fetch failed.';
    const blocked = /blocked|allowlist|HTTPS|credentials|private|Local source/i.test(message);
    return { status: blocked ? 'blocked' : 'failed', details: emptyDetails(), error: message, failedFields: [] };
  }
};

export const validateImageUrl = async (rawUrl: string): Promise<{ status: 'valid' | 'failed' | 'blocked'; error: string }> => {
  try {
    const url = await validateUrl(rawUrl);
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { Accept: 'image/*', 'User-Agent': 'eComInt product importer/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(config.imageRequestTimeoutMs),
    });
    if (!response.ok) throw new Error(`Image returned HTTP ${response.status}.`);
    if (!(response.headers.get('content-type') ?? '').startsWith('image/')) throw new Error('URL did not return an image.');
    return { status: 'valid', error: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Image validation failed.';
    const blocked = /blocked|allowlist|HTTPS|credentials|private|Local source/i.test(message);
    return { status: blocked ? 'blocked' : 'failed', error: message };
  }
};
