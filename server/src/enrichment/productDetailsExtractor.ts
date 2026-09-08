import * as cheerio from 'cheerio';
import type { EnrichedProductDetails } from '../types.js';
import { plainTextToHtml, sanitizeDescription } from './htmlSanitizer.js';

const fieldAliases: Record<string, string[]> = {
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
  const details: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(fieldAliases)) {
    const structuredValue = structuredProducts.map((product) => {
      if (field === 'brand') return structuredText(product.brand);
      if (field === 'productType') return structuredText(product.category);
      if (field === 'country') return structuredText(product.countryOfOrigin);
      return '';
    }).find(Boolean) ?? '';
    details[field] = findLabeledValue($, aliases) || structuredValue;
  }
  return { brand: details.brand || '', country: details.country || '', region: details.region || '', productType: details.productType || '', abv: details.abv || '', containerType: details.containerType || '', style: details.style || '', descriptionHtml: extractDescription($, structuredProducts) };
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

const supplierFieldAliases: Record<string, string[]> = {
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
  const details: Record<string, string> = {};
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
  return { brand: details.brand || '', country: details.country || '', region: details.region || '', productType: details.productType || '', abv: details.abv || '', containerType: details.containerType || '', style: details.style || '', descriptionHtml: description ? sanitizeDescription(description) || plainTextToHtml(description) : '' };
}

// ── VIC-17: AliExpress product page extraction ──────────────────────────

/** AliExpress-specific product details extracted from product page HTML. */
export interface AliexpressProductDetails {
  /** Up to 5 image URLs extracted from the AliExpress product gallery. */
  images: string[];
  /** Content from the AliExpress "Description" section (sanitized HTML). */
  descriptionHtml: string;
  /** Content from the AliExpress "Specifications" section (sanitized HTML). */
  attributesHtml: string;
  /** Parsed key-value pairs from specifications (e.g. "Brand Name" → "Vican Visions"). */
  attributeFields: Record<string, string>;
}

/** Extract the AliExpress product image gallery from page HTML or embedded state.
 *
 * AliExpress embeds product images in several locations:
 * - `window.__INITIAL_STATE__` / `window.__INITIAL_DATA__` JSON blobs
 * - `data-src` / `data-lazy` attributes on `<img>` tags
 * - `<img>` tags within gallery containers
 */
function extractAliexpressImages($: cheerio.CheerioAPI, html: string): string[] {
  const images: string[] = [];
  const seen = new Set<string>();
  const addImage = (url: string) => {
    const trimmed = url.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      images.push(trimmed);
    }
  };

  // Strategy 1: Parse embedded JSON state (window.__INITIAL_STATE__)
  const initialStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});?\s*\n/m);
  if (initialStateMatch) {
    try {
      const state = JSON.parse(initialStateMatch[1]) as Record<string, unknown>;
      const findImagesInObject = (obj: unknown): void => {
        if (typeof obj === 'string') {
          if (obj.startsWith('https://') && /\.(jpg|jpeg|png|webp|gif|bmp)/i.test(obj) && obj.includes('/')) addImage(obj);
          return;
        }
        if (Array.isArray(obj)) {
          obj.forEach(findImagesInObject);
          return;
        }
        if (obj && typeof obj === 'object') {
          for (const value of Object.values(obj)) {
            findImagesInObject(value);
          }
        }
      };
      findImagesInObject(state);
    } catch {
      // Fall through to other strategies
    }
  }

  // Strategy 2: Parse window.__INITIAL_DATA__ (newer AliExpress)
  const initialDataMatch = html.match(/window\.__INITIAL_DATA__\s*=\s*({.*?});?\s*\n/m);
  if (initialDataMatch && images.length < 5) {
    try {
      const data = JSON.parse(initialDataMatch[1]) as Record<string, unknown>;
      const findImagesInData = (obj: unknown): void => {
        if (typeof obj === 'string') {
          if (obj.startsWith('https://') && /\.(jpg|jpeg|png|webp|gif|bmp)/i.test(obj)) addImage(obj);
          return;
        }
        if (Array.isArray(obj)) {
          obj.forEach(findImagesInData);
          return;
        }
        if (obj && typeof obj === 'object') {
          for (const value of Object.values(obj)) {
            findImagesInData(value);
          }
        }
      };
      findImagesInData(data);
    } catch {
      // Fall through to DOM strategy
    }
  }

  // Strategy 3: Extract from <img> tags in the page DOM
  const imgSelectors = [
    '.product-image-carousel img',
    '.zoom-gallery img',
    '.product-gallery img',
    '.image-thumb img',
    '.item-gallery img',
    '.ui-pic img',
    '[data-spmage] img',
    '.pic-box img',
  ];

  for (const selector of imgSelectors) {
    if (images.length >= 5) break;
    $(`${selector}`).each((_, element) => {
      if (images.length >= 5) return;
      const src = $(element).attr('data-src') || $(element).attr('data-lazy') || $(element).attr('data-original') || $(element).attr('src') || '';
      if (src) addImage(src);
    });
  }

  // Strategy 4: Extract all image URLs from inline scripts/JSON-LD
  if (images.length < 5) {
    const imageUrlRegex = /"(https:\/\/[^"]*\.(?:jpg|jpeg|png|webp|gif|bmp)[^"]*)"/gi;
    let match: RegExpExecArray | null;
    while ((match = imageUrlRegex.exec(html)) !== null && images.length < 10) {
      const url = match[1].trim();
      if (url.includes('aliexpress') || url.includes(' Alibaba') || /\/(\d{8,})\/[a-z0-9_]+\.(jpg|jpeg|png|webp)/i.test(url)) {
        addImage(url);
      }
    }
  }

  // Strategy 5: Try to find image list in script tags containing "imagePath" or similar
  $('script').each((_, element) => {
    if (images.length >= 5) return;
    const scriptContent = $(element).text();
    const pathMatches = scriptContent.match(/"(?:imagePath|imgUrl|imageUrl|url)"\s*:\s*"(https:\/\/[^"]+)"/gi);
    if (pathMatches) {
      for (const pathMatch of pathMatches) {
        const urlMatch = pathMatch.match(/"(https:\/\/[^"]+)"$/);
        if (urlMatch) addImage(urlMatch[1]);
        if (images.length >= 5) break;
      }
    }
  });

  return images.slice(0, 5);
}

/** Find the heading level of an element (h1=1, h2=2, ..., h6=6).
 * Returns null for elements that are not headings. */
function headingLevel(tagName: string): number | null {
  const tag = tagName.toLowerCase();
  if (tag.startsWith('h') && tag.length === 2 && tag[1] >= '1' && tag[1] <= '6') {
    return parseInt(tag[1], 10);
  }
  return null;
}

/** Check if heading text matches a section name (e.g. "Description", "Specifications"). */
function headingMatches(text: string, target: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === target.toLowerCase() || normalized.startsWith(target.toLowerCase() + ' ');
}

/** Find heading elements whose text matches one of the target names,
 * then collect the content that follows until the next heading of equal
 * or higher level. Returns the combined HTML of the collected content. */
function extractContentAfterHeading($: cheerio.CheerioAPI, targets: string[]): string | null {
  const headingTags = 'h1, h2, h3, h4, h5, h6';

  // Strategy 1: Real heading elements (h1–h6) whose text matches a target.
  const headings = $(headingTags).toArray();
  for (const heading of headings) {
    const $heading = $(heading);
    const headingText = $heading.text().trim();
    const matchedTarget = targets.find((target) => headingMatches(headingText, target));
    if (!matchedTarget) continue;

    const level = headingLevel(heading.tagName) ?? 6;
    const parts: string[] = [];
    let sibling = $heading.next();

    while (sibling.length && !sibling.is(headingTags)) {
      const siblingLevel = headingLevel(sibling[0].tagName);
      if (siblingLevel !== null && siblingLevel <= level) break;
      const html = $.html(sibling);
      if (html) parts.push(html);
      sibling = sibling.next();
    }

    if (parts.length > 0) {
      return parts.join('');
    }
  }

  // Strategy 2: Fallback — any element whose direct text matches a target,
  // then grab following siblings' HTML.
  const allElements = $('*').toArray();
  for (const element of allElements) {
    const $element = $(element);
    if ($element.find(headingTags).length > 0) continue; // skip containers with real headings inside
    const text = $element.text().trim();
    if (text.length === 0 || text.length > 80) continue;
    if (!targets.some((target) => headingMatches(text, target))) continue;

    const siblings = $element.nextAll();
    if (!siblings.length) continue;
    const html = siblings.map((_, el) => $.html(el)).get().filter(Boolean).join('');
    if (html && html.replace(/<[^>]+>/g, '').trim().length >= 20) {
      return html;
    }
  }

  return null;
}

/** Parse key-value pairs from HTML content (table rows, list items, labeled fields). */
function parseAttributePairs(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};

  // Table rows: <tr><td>Label</td><td>Value</td></tr>
  $('tr').each((_, row) => {
    const cells = $(row).find('td, th').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length >= 2 && cells[0] && cells[1]) {
      fields[cells[0]] = fields[cells[0]] ? `${fields[cells[0]]}; ${cells[1]}` : cells[1];
    }
  });

  // List items with label: value format
  $('li').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    const match = text.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (match && match[1].trim() && match[2].trim()) {
      fields[match[1].trim()] = fields[match[1].trim()] ? `${fields[match[1].trim()]}; ${match[2].trim()}` : match[2].trim();
    }
  });

  // Labeled div/span pairs
  $('[class*="attr"], [class*="spec"], [class*="param"], [class*="property"]').each((_, element) => {
    const $element = $(element);
    const label = $element.find('.key, .label, dt').first().text().trim();
    const value = $element.find('.val, .value, dd').first().text().trim();
    if (label && value) {
      fields[label] = fields[label] ? `${fields[label]}; ${value}` : value;
    }
  });

  return fields;
}

/** Convert key-value pairs to a sanitized HTML list. */
function attributesToHtml(attributes: Record<string, string>): string {
  const pairs = Object.entries(attributes);
  if (pairs.length === 0) return '';
  return `<ul>${pairs.map(([label, value]) => `<li><strong>${label}:</strong> ${sanitizeDescription(value)}</li>`).join('')}</ul>`;
}

/** Extract the AliExpress "Description" section content.
 *
 * AliExpress product pages typically have a description module/section
 * with content in embedded HTML within the page.
 */
function extractAliexpressDescription($: cheerio.CheerioAPI, html: string): string {
  // Strategy 1: Find a heading with text "Description" and extract following content
  const headingContent = extractContentAfterHeading($, ['Description', 'Descriptions']);
  if (headingContent) {
    const text = headingContent.replace(/<[^>]+>/g, '').trim();
    if (text.length >= 20) {
      return sanitizeDescription(headingContent) || plainTextToHtml(text);
    }
  }

  // Strategy 2: Look for the description in the main product description area
  const descriptionSelectors = [
    '.product-desc-content',
    '.product-description',
    '.detail-desc',
    '.desc-ladies',
    '.product-detail-content',
    '[class*="description"]',
  ];

  for (const selector of descriptionSelectors) {
    const element = $(selector).first();
    if (element.length) {
      const htmlContent = element.html() ?? '';
      if (htmlContent && sanitizeDescription(htmlContent).replace(/<[^>]+>/g, '').trim().length >= 20) {
        return sanitizeDescription(htmlContent);
      }
    }
  }

  // Strategy 3: Look for description in embedded JSON state
  const initialStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});?\s*\n/m);
  if (initialStateMatch) {
    try {
      const state = JSON.parse(initialStateMatch[1]) as Record<string, unknown>;
      const findDescription = (obj: unknown): string | undefined => {
        if (typeof obj === 'string' && obj.length > 50 && !/^(function|\(\)|window)/.test(obj)) {
          return obj;
        }
        if (obj && typeof obj === 'object') {
          for (const key of Object.keys(obj)) {
            const value = (obj as Record<string, unknown>)[key];
            if (typeof key === 'string' && key.toLowerCase().includes('desc')) {
              const desc = typeof value === 'string' ? value : findDescription(value);
              if (desc && desc.length > 50) return desc;
            }
          }
        }
        return undefined;
      };
      const desc = findDescription(state);
      if (desc) {
        const sanitized = sanitizeDescription(desc) || plainTextToHtml(desc);
        if (sanitized.replace(/<[^>]+>/g, '').trim().length >= 20) return sanitized;
      }
    } catch {
      // Fall through
    }
  }

  // Strategy 4: Look for meta description
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  if (metaDescription && isUsefulDescription(metaDescription)) {
    return plainTextToHtml(metaDescription);
  }

  return '';
}

/** Extract the AliExpress "Specifications" section as both HTML and parsed key-value pairs.
 *
 * AliExpress specifications appear as:
 * - `<tr><td>Attribute name</td><td>Value</td></tr>` in tables
 * - `<li><span>Attribute name</span>: Value</li>` lists
 */
function extractAliexpressAttributes($: cheerio.CheerioAPI, html: string): { attributesHtml: string; attributeFields: Record<string, string> } {
  const attributeFields: Record<string, string> = {};
  let attributesHtml = '';

  // Strategy 1: Find a heading with text "Specifications" and extract following content
  const headingContent = extractContentAfterHeading($, ['Specifications', 'Spec', 'Details', 'Product Details', 'Attributes']);
  if (headingContent) {
    const parsed = parseAttributePairs(headingContent);
    Object.assign(attributeFields, parsed);
  }

  // Strategy 2: Specifications table
  $('table').each((_, table) => {
    if ($(table).find('th:contains("Specification"), th:contains("Attribute"), th:contains("Detail")').length) {
      $(table).find('tr').each((_, row) => {
        const cells = $(row).find('td, th').map((__, cell) => $(cell).text().trim()).get();
        if (cells.length >= 2) {
          const label = cells[0];
          const value = cells[1];
          if (label && value && !label.toLowerCase().includes('specification')) {
            attributeFields[label] = attributeFields[label] ? `${attributeFields[label]}; ${value}` : value;
          }
        }
      });
    }
  });

  // Strategy 3: Property list sections
  $('.product-property-list, .product-desc-page, .detail-common-list').each((_, element) => {
    $(element).find('li, tr').each((_, row) => {
      const cells = $(row).find('span, td, th, label, div').map((__, cell) => $(cell).text().trim()).get();
      if (cells.length >= 2) {
        const label = cells[0];
        const value = cells[1];
        if (label && value) {
          attributeFields[label] = attributeFields[label] ? `${attributeFields[label]}; ${value}` : value;
        }
      }
    });
  });

  // Strategy 4: Key-value pairs in divs
  $('[class*="spec"], [class*="attribute"], [class*="detail"]').each((_, element) => {
    const $element = $(element);
    const text = $element.text().trim();
    if (!text) return;
    const kvRegex = /^([^:：]+)[:：]\s*(.+)$/s;
    const lines = text.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      const match = kvRegex.exec(line.trim());
      if (match) {
        const label = match[1].trim();
        const value = match[2].trim();
        if (label && value && !attributeFields[label]) {
          attributeFields[label] = value;
        }
      }
    }
  });

  // Build HTML representation of attributes
  attributesHtml = attributesToHtml(attributeFields);

  // Strategy 5: Fallback — extract raw HTML of specification sections
  if (!attributesHtml) {
    const specSelectors = [
      '.product-attr',
      '.product-params',
      '.specifications',
      '.product-specs',
      '.detail-info',
      '.item-props',
      '.property-extra',
      '.sku-info',
    ];
    for (const selector of specSelectors) {
      const element = $(selector).first();
      if (element.length) {
        const htmlContent = element.html() ?? element.text();
        if (htmlContent.trim()) {
          attributesHtml = sanitizeDescription(htmlContent);
          break;
        }
      }
    }
  }

  return { attributesHtml, attributeFields };
}

/** Extract AliExpress-specific product details from a product page HTML.
 *
 * This function parses the AliExpress product page structure to extract:
 * - Product gallery images (up to 5)
 * - Product description (from the "Description" section)
 * - Product attributes/specifications (from the "Specifications" section)
 *
 * For non-AliExpress pages, this returns empty fields — the standard
 * `extractProductDetails()` handles Paramount/Cellar extraction.
 */
export const extractAliexpressProductDetails = (html: string): AliexpressProductDetails => {
  const $ = cheerio.load(html);
  const images = extractAliexpressImages($, html);
  const descriptionHtml = extractAliexpressDescription($, html);
  const { attributesHtml, attributeFields } = extractAliexpressAttributes($, html);

  return { images, descriptionHtml, attributesHtml, attributeFields };
};
