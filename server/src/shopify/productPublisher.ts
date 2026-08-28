import { config } from '../config.js';
import type { ProductDraft } from '../types.js';
import { shopifyAdminClient } from './adminGraphqlClient.js';

interface ProductMatch {
  id: string;
  title: string;
  status: string;
  variants: { nodes: Array<{ id: string; price: string; inventoryItem: { id: string } }> };
}

interface MatchResponse {
  products: { nodes: ProductMatch[] };
}

interface ProductMutationResponse {
  productCreate?: { product: { id: string; variants: { nodes: Array<{ id: string; inventoryItem: { id: string } }> } } | null; userErrors: UserError[] };
  productUpdate?: { product: { id: string; variants: { nodes: Array<{ id: string; inventoryItem: { id: string } }> } } | null; userErrors: UserError[] };
}

interface VariantMutationResponse {
  productVariantsBulkUpdate?: { userErrors: UserError[] };
  productVariantsBulkCreate?: { userErrors: UserError[] };
  inventoryActivate?: { userErrors: UserError[] };
  inventorySetQuantities?: { userErrors: UserError[] };
}

interface MediaMutationResponse {
  productCreateMedia?: { media: Array<{ id: string }>; mediaUserErrors: UserError[] };
}

interface UserError {
  field?: string[];
  message: string;
}

export interface ProductPublishResult {
  status: 'published' | 'failed' | 'skipped';
  action: 'created' | 'updated' | 'skipped';
  shopifyProductId: string | null;
  matchCount: number;
  error: string;
}

const normalizeTitle = (title: string): string => title.trim().toLocaleLowerCase();
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character] ?? character));

const detailsForDescription = (product: ProductDraft): string => {
  const fields: Array<[string, string]> = [
    ['Brand', product.brand], ['Country', product.country], ['Region', product.region],
    ['Product Type', product.productType], ['ABV %', product.abv],
    ['Container Type', product.containerType], ['Style', product.style],
  ];
  const rows = fields.filter(([, value]) => value.trim()).map(([label, value]) => `<li><strong>${label}:</strong> ${escapeHtml(value.trim())}</li>`);
  return rows.length ? `<h3>About this product</h3><ul>${rows.join('')}</ul>` : '';
};

const descriptionForShopify = (product: ProductDraft): string =>
  `${product.descriptionHtml}${detailsForDescription(product)}`.trim();

const searchTitle = (title: string): string => `title:"${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const findProductMatches = async (title: string): Promise<ProductMatch[]> => {
  const data = await shopifyAdminClient.request<MatchResponse>(
    `query ProductMatches($query: String!) {
      products(first: 20, query: $query) {
        nodes { id title status variants(first: 1) { nodes { id price inventoryItem { id } } } }
      }
    }`,
    { query: searchTitle(title) },
  );
  return data.products.nodes.filter((product) => normalizeTitle(product.title) === normalizeTitle(title));
};

const mutationErrors = (errors: UserError[]): string => errors.map((error) => error.message).join('; ');

const updateVariantPrice = async (productId: string, variantId: string | undefined, price: number): Promise<void> => {
  if (!variantId) {
    const result = await shopifyAdminClient.request<VariantMutationResponse>(
      `mutation CreateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) { userErrors { field message } }
      }`,
      { productId, variants: [{ price: price.toFixed(2) }] },
    );
    const errors = result.productVariantsBulkCreate?.userErrors ?? [];
    if (errors.length) throw new Error(mutationErrors(errors));
    return;
  }
  const result = await shopifyAdminClient.request<VariantMutationResponse>(
    `mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
    }`,
    { productId, variants: [{ id: variantId, price: price.toFixed(2) }] },
  );
  const errors = result.productVariantsBulkUpdate?.userErrors ?? [];
  if (errors.length) throw new Error(mutationErrors(errors));
};

const updateInventory = async (inventoryItemId: string | undefined, quantity: number): Promise<void> => {
  if (!config.shopifyLocationId) throw new Error('Shopify inventory is not configured. Set SHOPIFY_LOCATION_ID in .env.');
  if (!inventoryItemId) throw new Error('Shopify did not return a variant inventory item.');
  const activation = await shopifyAdminClient.request<VariantMutationResponse>(
    `mutation ActivateInventory($inventoryItemId: ID!, $locationId: ID!, $available: Int!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) { userErrors { field message } }
    }`,
    { inventoryItemId, locationId: config.shopifyLocationId, available: quantity },
  );
  const activationErrors = activation.inventoryActivate?.userErrors ?? [];
  const blockingActivationErrors = activationErrors.filter((error) => !error.message.toLocaleLowerCase().includes('already active'));
  if (blockingActivationErrors.length) throw new Error(mutationErrors(blockingActivationErrors));

  const result = await shopifyAdminClient.request<VariantMutationResponse>(
    `mutation SetInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) { userErrors { field message } }
    }`,
    {
      input: {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: 'ecomint://product-sync',
        quantities: [{ inventoryItemId, locationId: config.shopifyLocationId, quantity }],
      },
    },
  );
  const errors = result.inventorySetQuantities?.userErrors ?? [];
  if (errors.length) throw new Error(mutationErrors(errors));
};

const addImage = async (productId: string, product: ProductDraft): Promise<void> => {
  if (!product.imageUrl) return;
  const result = await shopifyAdminClient.request<MediaMutationResponse>(
    `mutation AddProductImage($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) { media { id } mediaUserErrors { field message } }
    }`,
    {
      productId,
      media: [{ originalSource: product.imageUrl, mediaContentType: 'IMAGE', alt: product.title }],
    },
  );
  const errors = result.productCreateMedia?.mediaUserErrors ?? [];
  if (errors.length) throw new Error(mutationErrors(errors));
};

export const publishProduct = async (product: ProductDraft): Promise<ProductPublishResult> => {
  if (!product.title.trim()) return { status: 'skipped', action: 'skipped', shopifyProductId: null, matchCount: 0, error: 'Title is required.' };
  if (product.suggestedSalePrice === null || !Number.isFinite(product.suggestedSalePrice) || product.suggestedSalePrice <= 0) return { status: 'skipped', action: 'skipped', shopifyProductId: null, matchCount: 0, error: 'A valid suggested sale price is required.' };
  if (!Number.isInteger(product.inventoryQuantity) || product.inventoryQuantity < 0) return { status: 'skipped', action: 'skipped', shopifyProductId: null, matchCount: 0, error: 'Shopify inventory must be a non-negative whole number.' };
  if (!config.shopifyAdminAccessToken) return { status: 'failed', action: 'skipped', shopifyProductId: null, matchCount: 0, error: 'Shopify is not configured. Set SHOPIFY_ADMIN_ACCESS_TOKEN in .env.' };
  if (!config.shopifyLocationId) return { status: 'failed', action: 'skipped', shopifyProductId: null, matchCount: 0, error: 'Shopify inventory is not configured. Set SHOPIFY_LOCATION_ID in .env.' };

  let matches: ProductMatch[];
  try {
    matches = await findProductMatches(product.title);
  } catch (error) {
    return { status: 'failed', action: 'skipped', shopifyProductId: null, matchCount: 0, error: error instanceof Error ? error.message : 'Shopify product matching failed.' };
  }
  if (matches.length > 1) {
    return { status: 'skipped', action: 'skipped', shopifyProductId: null, matchCount: matches.length, error: 'Multiple Shopify products match this title.' };
  }

  try {
    const descriptionHtml = descriptionForShopify(product);
    let shopifyProductId: string;
    let variantId: string | undefined;
    let inventoryItemId: string | undefined;
    let action: 'created' | 'updated';
    if (matches.length === 1) {
      const existing = matches[0];
      const result = await shopifyAdminClient.request<ProductMutationResponse>(
        `mutation UpdateProduct($input: ProductInput!) {
          productUpdate(input: $input) { product { id variants(first: 1) { nodes { id inventoryItem { id } } } } userErrors { field message } }
        }`,
        { input: { id: existing.id, title: product.title.trim(), descriptionHtml, status: 'ACTIVE' } },
      );
      const mutation = result.productUpdate;
      if (!mutation) throw new Error('Shopify returned no product update result.');
      if (mutation.userErrors.length) throw new Error(mutationErrors(mutation.userErrors));
      if (!mutation.product) throw new Error('Shopify did not return the updated product.');
      shopifyProductId = mutation.product.id;
      variantId = mutation.product.variants.nodes[0]?.id;
      inventoryItemId = mutation.product.variants.nodes[0]?.inventoryItem.id;
      action = 'updated';
    } else {
      const result = await shopifyAdminClient.request<ProductMutationResponse>(
        `mutation CreateProduct($product: ProductCreateInput!) {
          productCreate(product: $product) { product { id variants(first: 1) { nodes { id inventoryItem { id } } } } userErrors { field message } }
        }`,
        { product: { title: product.title.trim(), descriptionHtml, status: 'ACTIVE' } },
      );
      const mutation = result.productCreate;
      if (!mutation) throw new Error('Shopify returned no product create result.');
      if (mutation.userErrors.length) throw new Error(mutationErrors(mutation.userErrors));
      if (!mutation.product) throw new Error('Shopify did not return the created product.');
      shopifyProductId = mutation.product.id;
      variantId = mutation.product.variants.nodes[0]?.id;
      inventoryItemId = mutation.product.variants.nodes[0]?.inventoryItem.id;
      action = 'created';
    }

    await updateVariantPrice(shopifyProductId, variantId, product.suggestedSalePrice);
    await updateInventory(inventoryItemId, product.inventoryQuantity);
    if (action === 'created') await addImage(shopifyProductId, product);
    return { status: 'published', action, shopifyProductId, matchCount: matches.length, error: '' };
  } catch (error) {
    return { status: 'failed', action: matches.length ? 'updated' : 'created', shopifyProductId: matches[0]?.id ?? null, matchCount: matches.length, error: error instanceof Error ? error.message : 'Shopify publishing failed.' };
  }
};
