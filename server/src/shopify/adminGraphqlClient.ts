import { config } from '../config.js';

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetches a Shopify GraphQL endpoint with retry-on-429 backoff.
 * Shopify returns HTTP 429 with a `Retry-After` header (seconds) when the
 * rate limit (typically ~2 req/s on most plans) is exceeded. We honour that
 * header and fall back to exponential backoff for transient 5xx responses.
 */
const fetchWithRetry = async (
  url: string,
  init: RequestInit,
  maxRetries = 5,
): Promise<Response> => {
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(url, init);
    lastResponse = response;
    if (response.ok) return response;

    // Read the body once and close — we may need to log it on the final failure.
    const bodyText = response.body ? await response.text() : '';
    const contentType = response.headers.get('content-type') ?? '';
    let payload: unknown = undefined;
    if (contentType.includes('application/json')) {
      try { payload = JSON.parse(bodyText); } catch { /* ignore parse errors */ }
    }

    const retryAfter = response.headers.get('Retry-After');
    const shopifyErrors = Array.isArray((payload as { errors?: unknown })?.errors)
      ? ((payload as { errors: Array<{ extensions?: { retryAfter?: number } }> }).errors as Array<{ extensions?: { retryAfter?: number } }>)
      : [];

    // Retryable: 429 rate limit, or transient 5xx server errors.
    const isRateLimited = response.status === 429;
    const isServerFault = response.status >= 500 && response.status < 600;
    if ((isRateLimited || isServerFault) && attempt < maxRetries) {
      const hintedDelay = isRateLimited
        ? Number(retryAfter ?? shopifyErrors[0]?.extensions?.retryAfter ?? 0) * 1000
        : 0;
      const backoff = Math.max(hintedDelay, 1000 * 2 ** attempt); // 1s, 2s, 4s, 8s, 16s
      await sleep(backoff);
      continue;
    }

    throw new Error(`Shopify returned HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }
  throw new Error(`Shopify request failed after ${maxRetries} retries. Last response: HTTP ${lastResponse?.status}`);
};

export class ShopifyAdminClient {
  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!config.shopifyAdminAccessToken) {
      throw new Error('Shopify is not configured. Set SHOPIFY_ADMIN_ACCESS_TOKEN in .env.');
    }

    const response = await fetchWithRetry(
      `https://${config.storeDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': config.shopifyAdminAccessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const payload = await response.json() as GraphqlResponse<T>;
    if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.extensions?.code ? `${error.message} [${error.extensions.code}]` : error.message).join('; '));
    if (!payload.data) throw new Error('Shopify returned no GraphQL data.');
    return payload.data;
  }
}

export const shopifyAdminClient = new ShopifyAdminClient();
