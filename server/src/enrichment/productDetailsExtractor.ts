import * as cheerio from 'cheerio';
import type { EnrichedProductDetails } from '../types.js';
import { plainTextToHtml, sanitizeDescription } from './htmlSanitizer.js';

const fieldAliases: Record<keyof Omit<EnrichedProductDetails, 'descriptionHtml'>, string[]> = {
  brand: ['brand', 'brand name'],
  country: ['country', 'origin'],
  region: ['region'],
  productType: ['product type', 'type'],
  abv: ['abv %', 'abv', 'alcohol volume', 'alcohol content'],
  containerType: ['container type', 'packaging'],
  style: ['style', 'wine style', 'spirit style'],
};

const normalizeLabel = (label: string): string => label.toLocaleLowerCase().replace(/[:\s-]+/g, ' ').trim();

const fieldMatches = (label: string, aliases: string[]): boolean => {
  const normalizedLabel = normalizeLabel(label);
  return aliases.some((alias) => normalizeLabel(alias) === normalizedLabel);
};

const findLabeledValue = ($: cheerio.CheerioAPI, aliases: string[]): string => {
  let result = '';

  $('tr').each((_, element) => {
    if (result) return;
    const cells = $(element).find('th, td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length >= 2 && fieldMatches(cells[0], aliases)) result = cells[1];
  });

  $('.product-extra-info, .product-attribute__item').each((_, element) => {
    if (result) return;
    const label = $(element).find('.product-extra-info__heading, .product-attribute__item-key, .key').first().text().trim();
    const value = $(element).find('.product-extra-info__text, .product-attribute__item-value, .val').first().text().trim();
    if (value && fieldMatches(label, aliases)) result = value;
  });

  $('dt').each((_, element) => {
    if (result) return;
    const value = $(element).next('dd').text().replace(/\s+/g, ' ').trim();
    if (value && fieldMatches($(element).text(), aliases)) result = value;
  });

  $('li, section, article, div, p').each((_, element) => {
    if (result) return;
    const children = $(element).children().toArray();
    for (let index = 0; index < children.length - 1; index += 1) {
      const label = $(children[index]).text().replace(/\s+/g, ' ').trim();
      const value = $(children[index + 1]).text().replace(/\s+/g, ' ').trim();
      if (value && fieldMatches(label, aliases)) {
        result = value;
        break;
      }
    }
  });

  const escapedAliases = aliases.map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const labeledValue = new RegExp(`^\\s*(?:${escapedAliases})\\s*[:\\-]\\s*(.+)$`, 'i');
  $('li, p, span, div').each((_, element) => {
    if (result || $(element).children().length > 0) return;
    const match = labeledValue.exec($(element).text().replace(/\s+/g, ' ').trim());
    if (match?.[1]) result = match[1].trim();
  });
  return result;
};

const isUsefulDescription = (text: string): boolean => {
  if (text.length < 20) return false;
  if (/paramount liquor is australia|evolution rewards|liquor categories|areas served/i.test(text)) return false;
  return true;
};

const parseStructuredData = ($: cheerio.CheerioAPI): Record<string, unknown>[] => {
  const products: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const type = record['@type'];
    if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) products.push(record);
    Object.values(record).forEach(visit);
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      visit(JSON.parse($(element).text()));
    } catch {
    }
  });
  return products;
};

const structuredText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && 'name' in value) return String((value as { name: unknown }).name ?? '').trim();
  return '';
};

const extractAboutThisProduct = ($: cheerio.CheerioAPI): string => {
  const headingSelectors = 'h1, h2, h3, h4, h5, h6';
  let result = '';
  $(headingSelectors).each((_, element) => {
    if (result || normalizeLabel($(element).text()) !== 'about this product') return;
    const parts: string[] = [];
    let sibling = $(element).next();
    while (sibling.length && !sibling.is(headingSelectors)) {
      const html = $.html(sibling) ?? '';
      if (html) parts.push(html);
      sibling = sibling.next();
    }
    if (parts.length === 0) {
      const container = $(element).closest('section, article, div');
      container.find('p, ul, ol').each((__, content) => {
        if (!$(content).find(headingSelectors).length) parts.push($.html(content) ?? '');
      });
    }
    const sanitized = sanitizeDescription(parts.join(''));
    if (sanitized.replace(/<[^>]+>/g, '').trim().length >= 20) result = sanitized;
  });
  return result;
};

const extractDescription = ($: cheerio.CheerioAPI, structuredProducts: Record<string, unknown>[]): string => {
  const aboutDescription = extractAboutThisProduct($);
  if (aboutDescription) return aboutDescription;

  const structuredDescription = structuredProducts.map((product) => structuredText(product.description)).find((value) => isUsefulDescription(value));
  if (structuredDescription) return plainTextToHtml(structuredDescription);

  const candidates = [
    '[itemprop="description"]',
    '[data-product-description]',
    '.product__description',
    '.product-description',
    '.product-detail__description',
    '.product-details__description',
    'meta[name="description"]',
  ];
  for (const selector of candidates) {
    const element = $(selector).first();
    if (!element.length) continue;
    const content = selector.startsWith('meta') ? element.attr('content') ?? '' : element.html() ?? '';
    const text = element.text().replace(/\s+/g, ' ').trim();
    if (!isUsefulDescription(text)) continue;
    const sanitized = selector.startsWith('meta') ? plainTextToHtml(content) : sanitizeDescription(content);
    if (sanitized.replace(/<[^>]+>/g, '').trim().length >= 20) return sanitized;
  }

  const paragraphs = $('main p, article p, [role="main"] p')
    .map((_, element) => $(element).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter((text) => isUsefulDescription(text) && text.length >= 40)
    .slice(0, 4);
  return plainTextToHtml(paragraphs.join('\n\n'));
};

export const extractProductDetails = (html: string): EnrichedProductDetails => {
  const $ = cheerio.load(html);
  const structuredProducts = parseStructuredData($);
  const details = {} as Omit<EnrichedProductDetails, 'descriptionHtml'>;
  for (const [field, aliases] of Object.entries(fieldAliases) as [keyof typeof details, string[]][]) {
    const structuredValue = structuredProducts.map((product) => {
      if (field === 'brand') return structuredText(product.brand);
      if (field === 'productType') return structuredText(product.category);
      if (field === 'country') return structuredText(product.countryOfOrigin);
      return '';
    }).find(Boolean) ?? '';
    details[field] = findLabeledValue($, aliases) || structuredValue;
  }
  return { ...details, descriptionHtml: extractDescription($, structuredProducts) };
};

export interface SupplierProductPayload {
  sku?: string;
  name?: string;
  brand?: string;
  country?: string;
  region?: string;
  category_level_1?: string;
  category_level_2?: string;
  category_level_3?: string;
  abv?: string | number;
  item_container_type?: string;
  description?: { html?: string };
  meta_description?: string;
  country_of_manufacture?: string;
  custom_attributesV2?: { items?: Array<{ code?: string; value?: string }> };
}

const supplierFieldAliases: Record<keyof Omit<EnrichedProductDetails, 'descriptionHtml'>, string[]> = {
  brand: ['brand', 'brand_name', 'brandname', 'manufacturer'],
  country: ['country', 'country_of_origin', 'country_of_manufacture', 'origin'],
  region: ['region', 'wine_region'],
  productType: ['product_type', 'producttype', 'type', 'category'],
  abv: ['abv', 'abv_percent', 'alcohol_volume', 'alcohol_content'],
  containerType: ['container_type', 'containertype', 'container', 'packaging'],
  style: ['style', 'wine_style', 'spirit_style'],
};

const normalizeAttributeCode = (code: string): string => code.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const extractSupplierProductDetails = (payload: SupplierProductPayload): EnrichedProductDetails => {
  const attributes = new Map(
    (payload.custom_attributesV2?.items ?? [])
      .filter((attribute): attribute is { code: string; value: string } => Boolean(attribute.code && attribute.value))
      .map((attribute) => [normalizeAttributeCode(attribute.code), attribute.value.trim()]),
  );
  const details = {} as Omit<EnrichedProductDetails, 'descriptionHtml'>;
  for (const [field, aliases] of Object.entries(supplierFieldAliases) as [keyof typeof details, string[]][]) {
    details[field] = aliases.map(normalizeAttributeCode).map((alias) => attributes.get(alias) ?? '').find(Boolean) ?? '';
  }
  details.brand ||= payload.brand?.trim() ?? '';
  details.country ||= payload.country?.trim() ?? '';
  details.region ||= payload.region?.trim() ?? '';
  details.productType ||= payload.category_level_2?.trim() ?? '';
  details.abv ||= payload.abv === undefined ? '' : String(payload.abv).trim();
  details.containerType ||= payload.item_container_type?.trim() ?? '';
  details.style ||= payload.category_level_3?.trim() ?? '';
  if (!details.country && payload.country_of_manufacture) details.country = payload.country_of_manufacture.trim();
  const description = payload.description?.html?.trim() || payload.meta_description?.trim() || '';
  return { ...details, descriptionHtml: description ? sanitizeDescription(description) || plainTextToHtml(description) : '' };
};
