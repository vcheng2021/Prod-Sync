import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DraftResponse, DraftSummary, EnrichedProductDetails, ProductDraft, PublishStatus } from '../types.js';

const ENRICHMENT_CACHE_VERSION = '4';

export class DraftStore {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma('journal_mode = WAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        image_url TEXT NOT NULL,
        image_local_filename TEXT NOT NULL DEFAULT '',
        image_local_url TEXT NOT NULL DEFAULT '',
        image_status TEXT NOT NULL,
        title TEXT NOT NULL,
        source_url TEXT NOT NULL,
        stock_on_hand REAL,
        case_price REAL,
        unit_price REAL,
        description_html TEXT NOT NULL,
        brand TEXT NOT NULL,
        country TEXT NOT NULL,
        region TEXT NOT NULL,
        product_type TEXT NOT NULL,
        abv TEXT NOT NULL,
        container_type TEXT NOT NULL,
        style TEXT NOT NULL,
        enrichment_status TEXT NOT NULL,
        enrichment_error TEXT NOT NULL,
        enrichment_fetched_at TEXT,
        selected INTEGER NOT NULL,
        publish_status TEXT NOT NULL,
        publish_error TEXT NOT NULL,
        shopify_product_id TEXT,
        shopify_match_count INTEGER,
        validation_errors TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        FOREIGN KEY (draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS source_cache (
        url TEXT PRIMARY KEY,
        details_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        parser_version TEXT NOT NULL DEFAULT '1'
      );
      CREATE TABLE IF NOT EXISTS publish_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        status TEXT NOT NULL,
        shopify_product_id TEXT,
        error TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing('products', 'image_local_filename', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'image_local_url', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('source_cache', 'parser_version', "TEXT NOT NULL DEFAULT '1'");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  createDraft(filename: string, products: ProductDraft[]): DraftResponse {
    const draftId = products[0]?.draftId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const insertDraft = this.database.prepare('INSERT INTO drafts (id, filename, created_at, updated_at) VALUES (?, ?, ?, ?)');
    const insertProduct = this.database.prepare(`INSERT INTO products (
      id, draft_id, row_number, image_url, image_status, title, source_url, stock_on_hand, case_price, unit_price,
      description_html, brand, country, region, product_type, abv, container_type, style, enrichment_status,
      enrichment_error, enrichment_fetched_at, selected, publish_status, publish_error, shopify_product_id,
      shopify_match_count, validation_errors, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const transaction = this.database.transaction(() => {
      insertDraft.run(draftId, filename, now, now);
      for (const product of products) {
        insertProduct.run(
          product.id, draftId, product.rowNumber, product.imageUrl, product.imageStatus, product.title, product.sourceUrl,
          product.stockOnHand, product.casePrice, product.unitPrice, product.descriptionHtml, product.brand, product.country,
          product.region, product.productType, product.abv, product.containerType, product.style, product.enrichmentStatus,
          product.enrichmentError, product.enrichmentFetchedAt, product.selected ? 1 : 0, product.publishStatus, product.publishError,
          product.shopifyProductId, product.shopifyMatchCount, JSON.stringify(product.validationErrors), JSON.stringify(product.raw),
        );
      }
    });
    transaction();
    return this.getDraft(draftId);
  }

  getDraft(draftId: string): DraftResponse {
    const draft = this.database.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId) as DraftRow | undefined;
    if (!draft) throw new Error('Draft not found.');
    const products = this.database.prepare('SELECT * FROM products WHERE draft_id = ? ORDER BY row_number').all(draftId) as ProductRow[];
    return { draft: this.toSummary(draft, products), products: products.map((product) => this.toProduct(product)) };
  }

  updateProduct(draftId: string, productId: string, patch: Partial<ProductDraft>): ProductDraft {
    const allowed = ['imageUrl', 'title', 'stockOnHand', 'casePrice', 'unitPrice', 'descriptionHtml', 'brand', 'country', 'region', 'productType', 'abv', 'containerType', 'style', 'selected'];
    const columns: Record<string, string> = {
      imageUrl: 'image_url', title: 'title', stockOnHand: 'stock_on_hand', casePrice: 'case_price', unitPrice: 'unit_price',
      descriptionHtml: 'description_html', brand: 'brand', country: 'country', region: 'region', productType: 'product_type',
      abv: 'abv', containerType: 'container_type', style: 'style', selected: 'selected',
    };
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (entries.length > 0) {
      const setClause = entries.map(([key]) => `${columns[key]} = ?`).join(', ');
      const values = entries.map(([key, value]) => key === 'selected' ? (value ? 1 : 0) : value);
      values.push(productId, draftId);
      this.database.prepare(`UPDATE products SET ${setClause} WHERE id = ? AND draft_id = ?`).run(...values);
      this.database.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), draftId);
    }
    return this.getDraft(draftId).products.find((product) => product.id === productId) ?? (() => { throw new Error('Product not found.'); })();
  }

  saveEnrichment(draftId: string, productId: string, result: { status: ProductDraft['enrichmentStatus']; details: EnrichedProductDetails; error: string }): void {
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE products SET description_html = ?, brand = ?, country = ?, region = ?, product_type = ?, abv = ?, container_type = ?, style = ?, enrichment_status = ?, enrichment_error = ?, enrichment_fetched_at = ? WHERE id = ? AND draft_id = ?`)
      .run(result.details.descriptionHtml, result.details.brand, result.details.country, result.details.region, result.details.productType, result.details.abv, result.details.containerType, result.details.style, result.status, result.error, now, productId, draftId);
    this.database.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(now, draftId);
  }

  saveImageStatus(draftId: string, productId: string, status: ProductDraft['imageStatus'], error = ''): void {
    this.database.prepare('UPDATE products SET image_status = ?, publish_error = CASE WHEN ? != \'\' THEN ? ELSE publish_error END WHERE id = ? AND draft_id = ?')
      .run(status, error, error, productId, draftId);
  }

  saveImageResult(draftId: string, productId: string, result: { status: ProductDraft['imageStatus']; localFilename: string; localUrl: string; error: string }): void {
    this.database.prepare('UPDATE products SET image_status = ?, image_local_filename = ?, image_local_url = ?, publish_error = CASE WHEN ? != \'\' THEN ? ELSE publish_error END WHERE id = ? AND draft_id = ?')
      .run(result.status, result.localFilename, result.localUrl, result.error, result.error, productId, draftId);
  }

  savePublishResult(draftId: string, productId: string, status: PublishStatus, shopifyProductId: string | null, error: string): void {
    const now = new Date().toISOString();
    this.database.prepare('UPDATE products SET publish_status = ?, shopify_product_id = ?, shopify_match_count = ?, publish_error = ? WHERE id = ? AND draft_id = ?')
      .run(status, shopifyProductId, shopifyProductId ? 1 : null, error, productId, draftId);
    this.database.prepare('INSERT INTO publish_events (draft_id, product_id, status, shopify_product_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(draftId, productId, status, shopifyProductId, error, now);
    this.database.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(now, draftId);
  }

  getCachedEnrichment(url: string): { details: EnrichedProductDetails; status: ProductDraft['enrichmentStatus']; error: string; fetchedAt: string } | null {
    const row = this.database.prepare('SELECT * FROM source_cache WHERE url = ? AND parser_version = ?').get(url, ENRICHMENT_CACHE_VERSION) as CacheRow | undefined;
    return row ? { details: JSON.parse(row.details_json) as EnrichedProductDetails, status: row.status as ProductDraft['enrichmentStatus'], error: row.error, fetchedAt: row.fetched_at } : null;
  }

  saveCachedEnrichment(url: string, result: { details: EnrichedProductDetails; status: ProductDraft['enrichmentStatus']; error: string }): void {
    this.database.prepare('INSERT OR REPLACE INTO source_cache (url, details_json, status, error, fetched_at, parser_version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(url, JSON.stringify(result.details), result.status, result.error, new Date().toISOString(), ENRICHMENT_CACHE_VERSION);
  }

  private toSummary(draft: DraftRow, products: ProductRow[]): DraftSummary {
    return {
      id: draft.id, filename: draft.filename, createdAt: draft.created_at, updatedAt: draft.updated_at,
      totalProducts: products.length, selectedProducts: products.filter((product) => product.selected).length,
      readyProducts: products.filter((product) => product.enrichment_status === 'ready').length,
      failedProducts: products.filter((product) => product.publish_status === 'failed').length,
    };
  }

  private toProduct(row: ProductRow): ProductDraft {
    const validationErrors = (JSON.parse(row.validation_errors) as string[]).filter((error) =>
      error !== 'Duplicate title in this import.' &&
      !(row.unit_price === null && error === 'Unit price must be greater than zero (column J).'));
    return {
      id: row.id, draftId: row.draft_id, rowNumber: row.row_number, imageUrl: row.image_url, imageLocalFilename: row.image_local_filename, imageLocalUrl: row.image_local_url, imageStatus: row.image_status as ProductDraft['imageStatus'],
      title: row.title, sourceUrl: row.source_url, stockOnHand: row.stock_on_hand, casePrice: row.case_price, unitPrice: row.unit_price,
      descriptionHtml: row.description_html, brand: row.brand, country: row.country, region: row.region, productType: row.product_type,
      abv: row.abv, containerType: row.container_type, style: row.style, enrichmentStatus: row.enrichment_status as ProductDraft['enrichmentStatus'],
      enrichmentError: row.enrichment_error, enrichmentFetchedAt: row.enrichment_fetched_at, selected: Boolean(row.selected), publishStatus: row.publish_status as PublishStatus,
      publishError: row.publish_error, shopifyProductId: row.shopify_product_id, shopifyMatchCount: row.shopify_match_count,
      validationErrors, raw: JSON.parse(row.raw_json) as Record<string, unknown>,
    };
  }
}

type DraftRow = { id: string; filename: string; created_at: string; updated_at: string };
type ProductRow = {
  id: string; draft_id: string; row_number: number; image_url: string; image_local_filename: string; image_local_url: string; image_status: string; title: string; source_url: string;
  stock_on_hand: number | null; case_price: number | null; unit_price: number | null; description_html: string; brand: string;
  country: string; region: string; product_type: string; abv: string; container_type: string; style: string; enrichment_status: string;
  enrichment_error: string; enrichment_fetched_at: string | null; selected: number; publish_status: string; publish_error: string;
  shopify_product_id: string | null; shopify_match_count: number | null; validation_errors: string; raw_json: string;
};
type CacheRow = { details_json: string; status: string; error: string; fetched_at: string; parser_version: string };
