import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { config } from '../config.js';

export interface ImageDownloadResult {
  status: 'valid' | 'failed' | 'blocked';
  localFilename: string;
  localUrl: string;
  error: string;
}

const isPrivateAddress = (address: string): boolean => {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return true;
};

const validateUrl = async (rawUrl: string): Promise<URL> => {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Only HTTPS image URLs are allowed.');
  if (url.username || url.password) throw new Error('Image URL credentials are not allowed.');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('Local image URLs are blocked.');
  if (config.sourceUrlAllowlist.length > 0 && !config.sourceUrlAllowlist.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  )) throw new Error('Image host is not in the configured allowlist.');
  const addresses = await dns.lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Private or unavailable image address is blocked.');
  }
  return url;
};

const extensionForContentType = (contentType: string, url: URL): string => {
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  const knownExtensions: Record<string, string> = {
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };
  if (knownExtensions[mediaType]) return knownExtensions[mediaType];
  const extension = path.extname(url.pathname).toLowerCase();
  return /^\.(avif|gif|jpe?g|png|webp)$/.test(extension) ? extension : '.img';
};

const classifyError = (message: string): 'failed' | 'blocked' =>
  /blocked|allowlist|HTTPS|credentials|private|Local image/i.test(message) ? 'blocked' : 'failed';

export const downloadProductImage = async (
  rawUrl: string,
  productId: string,
): Promise<ImageDownloadResult> => {
  try {
    let url = await validateUrl(rawUrl);
    let response: Response | null = null;
    for (let redirect = 0; redirect <= config.imageMaxRedirects; redirect += 1) {
      response = await fetch(url, {
        headers: { Accept: 'image/*', 'User-Agent': 'eComInt product importer/1.0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(config.imageRequestTimeoutMs),
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location || redirect === config.imageMaxRedirects) throw new Error('Too many or invalid image redirects.');
      url = await validateUrl(new URL(location, url).toString());
    }

    if (!response || !response.ok) throw new Error(`Image returned HTTP ${response?.status ?? 'unknown'}.`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) throw new Error('URL did not return an image.');
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > config.imageMaxBytes) throw new Error('Image is too large.');

    const image = new Uint8Array(await response.arrayBuffer());
    if (image.byteLength === 0) throw new Error('Image response was empty.');
    if (image.byteLength > config.imageMaxBytes) throw new Error('Image is too large.');

    const extension = extensionForContentType(contentType, url);
    const digest = crypto.createHash('sha256').update(rawUrl).digest('hex').slice(0, 12);
    const localFilename = `${productId}-${digest}${extension}`;
    await fs.mkdir(config.productImageDirectory, { recursive: true });
    try {
      await fs.writeFile(path.join(config.productImageDirectory, localFilename), image, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    return { status: 'valid', localFilename, localUrl: `/productimage/${encodeURIComponent(localFilename)}`, error: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Image download failed.';
    return { status: classifyError(message), localFilename: '', localUrl: '', error: message };
  }
};
