import { config } from '../config.js';

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export class ShopifyAdminClient {
  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!config.shopifyAdminAccessToken) {
      throw new Error('Shopify is not configured. Set SHOPIFY_ADMIN_ACCESS_TOKEN in .env.');
    }

    const response = await fetch(
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
    if (!response.ok) throw new Error(`Shopify returned HTTP ${response.status}.`);
    if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '));
    if (!payload.data) throw new Error('Shopify returned no GraphQL data.');
    return payload.data;
  }
}

export const shopifyAdminClient = new ShopifyAdminClient();
