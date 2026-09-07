import { config } from '../config.js';
import type { PlatformClient, PlatformProductData, PublishResult, ProductMatch } from './platformClient.js';
import { ShopifyClient } from './shopifyClient.js';
import { WooCommerceClient } from './woocommerceClient.js';

/** Factory that returns the correct PlatformClient for a given platform name. */
export function getPlatformClient(platform: string): PlatformClient {
  switch (platform) {
    case 'woocommerce':
      return new WooCommerceClient();
    case 'shopify':
    default:
      return new ShopifyClient();
  }
}

/** Check if a platform name is configured and available. */
export function isPlatformAvailable(platform: string): boolean {
  if (platform === 'shopify') return true; // Shopify is always available when configured
  if (platform === 'woocommerce') return Boolean(config.wooCommerceStoreUrl && config.wooCommerceConsumerKey && config.wooCommerceConsumerSecret);
  return false;
}
