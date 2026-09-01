import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { DraftResponse, DraftSummary, EnrichedProductDetails, ProductDraft, PublishStatus, WorkbookImportSummary } from '../types.js';

const ENRICHMENT_CACHE_VERSION = '4';
const normalizeKey = (value: string): string => value.trim().toLocaleLowerCase();
const currencyValue = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

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
        supplier_product_key TEXT NOT NULL DEFAULT '',
        supplier_product_key_normalized TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL,
        image_local_filename TEXT NOT NULL DEFAULT '',
        image_local_url TEXT NOT NULL DEFAULT '',
        image_status TEXT NOT NULL,
        title TEXT NOT NULL,
        source_url TEXT NOT NULL,
        stock_on_hand REAL,
        case_price REAL,
        unit_price REAL,
          suggested_sale_price REAL,
        inventory_quantity INTEGER NOT NULL DEFAULT 0,
        sale_price_overridden INTEGER NOT NULL DEFAULT 0,
        description_html TEXT NOT NULL,
        brand TEXT NOT NULL,
        country TEXT NOT NULL,
        region TEXT NOT NULL,
        product_type TEXT NOT NULL,
        supplier_type TEXT NOT NULL DEFAULT '',
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
        is_featured INTEGER NOT NULL DEFAULT 0,
        publish_to_online_store INTEGER NOT NULL DEFAULT 1,
        collection_ids TEXT NOT NULL DEFAULT '[]',
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
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing('products', 'image_local_filename', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'image_local_url', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'supplier_product_key', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'supplier_product_key_normalized', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'suggested_sale_price', 'REAL');
    this.addColumnIfMissing('products', 'inventory_quantity', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('products', 'sale_price_overridden', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('products', 'is_featured', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('products', 'publish_to_online_store', 'INTEGER NOT NULL DEFAULT 1');
    this.addColumnIfMissing('products', 'collection_ids', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('products', 'supplier_type', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('source_cache', 'parser_version', "TEXT NOT NULL DEFAULT '1'");
    this.database.exec("UPDATE products SET collection_ids = '[]' WHERE collection_ids IS NULL OR collection_ids = ''");
    this.migrateLegacyCurrentDraft();
    this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS products_supplier_key_idx ON products (draft_id, supplier_product_key_normalized) WHERE supplier_product_key_normalized <> ''");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private migrateLegacyCurrentDraft(): void {
    const currentDraft = this.getCurrentDraftRow();
    if (!currentDraft) return;
    const rows = this.database.prepare('SELECT * FROM products WHERE draft_id = ? ORDER BY row_number, id').all(currentDraft.id) as ProductRow[];
    if (!rows.some((row) => !row.supplier_product_key_normalized)) return;

    const updateLegacy = this.database.prepare(`UPDATE products SET supplier_product_key = ?, supplier_product_key_normalized = ?, suggested_sale_price = ?, inventory_quantity = ?, validation_errors = ? WHERE id = ?`);
    const deleteDuplicate = this.database.prepare('DELETE FROM products WHERE id = ?');
    const transaction = this.database.transaction(() => {
      const seen = new Map<string, ProductRow>();
      for (const row of rows) {
        if (row.supplier_product_key_normalized) {
          seen.set(row.supplier_product_key_normalized, row);
          continue;
        }
        const supplierProductKey = this.legacySupplierProductKey(row.raw_json);
        if (!supplierProductKey) {
          updateLegacy.run('', '', row.suggested_sale_price, row.inventory_quantity, JSON.stringify(this.withValidationError(row, 'Supplier product key could not be recovered from the legacy row; re-import this product.')), row.id);
          continue;
        }
        const normalizedKey = normalizeKey(supplierProductKey);
        const existing = seen.get(normalizedKey);
        if (existing) {
          if (this.supplierFingerprint(existing) === this.supplierFingerprint(row)) {
            deleteDuplicate.run(row.id);
          } else {
            updateLegacy.run('', '', row.suggested_sale_price, row.inventory_quantity, JSON.stringify(this.withValidationError(row, 'Conflicting legacy rows share this supplier product key; re-import this product.')), row.id);
          }
          continue;
        }
        const suggestedSalePrice = row.suggested_sale_price ?? (row.unit_price === null ? null : currencyValue(row.unit_price * 1.25));
        const inventoryQuantity = row.stock_on_hand !== null && row.stock_on_hand > 2 ? 1 : 0;
        updateLegacy.run(supplierProductKey, normalizedKey, suggestedSalePrice, inventoryQuantity, row.validation_errors, row.id);
        seen.set(normalizedKey, { ...row, supplier_product_key_normalized: normalizedKey });
      }
    });
    transaction();
  }

  private legacySupplierProductKey(rawJson: string): string {
    const raw = JSON.parse(rawJson) as Record<string, unknown>;
    const value = raw['body-xxs'] ?? raw['Column 2'] ?? Object.values(raw)[1];
    return value === null || value === undefined ? '' : String(value).trim();
  }

  private supplierFingerprint(row: ProductRow): string {
    return JSON.stringify([row.image_url, row.title, row.source_url, row.stock_on_hand, row.case_price, row.unit_price, row.supplier_type]);
  }

  private withValidationError(row: ProductRow, message: string): string[] {
    const errors = JSON.parse(row.validation_errors || '[]') as string[];
    return errors.includes(message) ? errors : [...errors, message];
  }

  createDraft(filename: string, products: ProductDraft[]): DraftResponse {
    return this.mergeWorkbook(filename, products).draft;
  }

  mergeWorkbook(filename: string, products: ProductDraft[]): { draft: DraftResponse; summary: WorkbookImportSummary } {
    const currentDraft = this.getCurrentDraftRow();
    const draftId = currentDraft?.id ?? products[0]?.draftId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const insertDraft = this.database.prepare('INSERT INTO drafts (id, filename, created_at, updated_at) VALUES (?, ?, ?, ?)');
    const insertProduct = this.database.prepare(`INSERT INTO products (
      id, draft_id, row_number, supplier_product_key, supplier_product_key_normalized, image_url, image_status, title, source_url, stock_on_hand, case_price, unit_price, suggested_sale_price, inventory_quantity, sale_price_overridden,
      description_html, brand, country, region, product_type, supplier_type, abv, container_type, style, enrichment_status,
      enrichment_error, enrichment_fetched_at, selected, publish_status, publish_error, shopify_product_id,
      shopify_match_count, is_featured, publish_to_online_store, collection_ids, validation_errors, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const findProduct = this.database.prepare('SELECT * FROM products WHERE draft_id = ? AND supplier_product_key_normalized = ?') as Database.Statement;
    const updateProduct = this.database.prepare(`UPDATE products SET
      row_number = ?, supplier_product_key = ?, image_url = ?, image_local_filename = ?, image_local_url = ?, image_status = ?, title = ?, source_url = ?, stock_on_hand = ?, case_price = ?, unit_price = ?, suggested_sale_price = ?,
      description_html = ?, brand = ?, country = ?, region = ?, product_type = ?, supplier_type = ?, abv = ?, container_type = ?, style = ?, enrichment_status = ?, enrichment_error = ?, enrichment_fetched_at = ?,
      validation_errors = ?, raw_json = ? WHERE id = ? AND draft_id = ?`);
    const transaction = this.database.transaction(() => {
      if (!currentDraft) insertDraft.run(draftId, filename, now, now);
      else this.database.prepare('UPDATE drafts SET filename = ?, updated_at = ? WHERE id = ?').run(filename, now, draftId);
      const summary: WorkbookImportSummary = { added: 0, updated: 0, unchanged: 0, invalid: 0, duplicateRowsSkipped: 0 };
      for (const product of products) {
        const normalizedKey = normalizeKey(product.supplierProductKey);
        if (!normalizedKey) {
          summary.invalid += 1;
          continue;
        }
        const existing = findProduct.get(draftId, normalizedKey) as ProductRow | undefined;
        if (!existing) {
          insertProduct.run(
            product.id, draftId, product.rowNumber, product.supplierProductKey, normalizedKey, product.imageUrl, product.imageStatus, product.title, product.sourceUrl,
            product.stockOnHand, product.casePrice, product.unitPrice, product.suggestedSalePrice, product.inventoryQuantity, 0, product.descriptionHtml, product.brand, product.country,
            product.region, product.productType, product.supplierType, product.abv, product.containerType, product.style, product.enrichmentStatus,
            product.enrichmentError, product.enrichmentFetchedAt, product.selected ? 1 : 0, product.publishStatus, product.publishError,
            product.shopifyProductId, product.shopifyMatchCount, product.featured ? 1 : 0, product.publishToOnlineStore ? 1 : 0, JSON.stringify(product.selectedCollectionIds ?? []), JSON.stringify(product.validationErrors), JSON.stringify(product.raw),
          );
          summary.added += 1;
          continue;
        }
        const previousAutomaticPrice = existing.unit_price === null ? null : currencyValue(existing.unit_price * 1.25);
        const preserveAutomaticPrice = existing.sale_price_overridden === 0 && (existing.suggested_sale_price === null || existing.suggested_sale_price === previousAutomaticPrice);
        const suggestedSalePrice = preserveAutomaticPrice ? product.suggestedSalePrice : existing.suggested_sale_price;
        const sourceChanged = existing.source_url !== product.sourceUrl;
        const imageChanged = existing.image_url !== product.imageUrl;
        const unchanged = existing.supplier_product_key === product.supplierProductKey && existing.image_url === product.imageUrl && existing.title === product.title && existing.source_url === product.sourceUrl && existing.stock_on_hand === product.stockOnHand && existing.case_price === product.casePrice && existing.unit_price === product.unitPrice && existing.supplier_type === product.supplierType;
        updateProduct.run(
          product.rowNumber, product.supplierProductKey, product.imageUrl, imageChanged ? '' : existing.image_local_filename, imageChanged ? '' : existing.image_local_url, imageChanged ? product.imageStatus : existing.image_status, product.title, product.sourceUrl,
          product.stockOnHand, product.casePrice, product.unitPrice, suggestedSalePrice, sourceChanged ? existing.description_html : existing.description_html,
          existing.brand, existing.country, existing.region, existing.product_type, product.supplierType, existing.abv, existing.container_type, existing.style,
          sourceChanged ? (product.sourceUrl ? 'pending' : 'not-provided') : existing.enrichment_status, sourceChanged ? '' : existing.enrichment_error,
          sourceChanged ? null : existing.enrichment_fetched_at, JSON.stringify(product.validationErrors), JSON.stringify(product.raw), existing.id, draftId,
        );
        summary[unchanged ? 'unchanged' : 'updated'] += 1;
      }
      this.database.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(now, draftId);
      return summary;
    });
    const summary = transaction() as WorkbookImportSummary;
    return { draft: this.getDraft(draftId), summary };
  }

  private getCurrentDraftRow(): DraftRow | undefined {
    return this.database.prepare('SELECT * FROM drafts ORDER BY updated_at DESC, created_at DESC LIMIT 1').get() as DraftRow | undefined;
  }

  getCurrentDraft(): DraftResponse | null {
    const draft = this.getCurrentDraftRow();
    return draft ? this.getDraft(draft.id) : null;
  }

  hasProducts(): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM products LIMIT 1').get());
  }

  hasInitializationMarker(): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM app_state WHERE key = 'initial_seed_completed'").get());
  }

  markInitializationComplete(): void {
    this.database.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('initial_seed_completed', 'true')").run();
  }

  getOwnedImageFilenames(): string[] {
    const rows = this.database.prepare("SELECT image_local_filename FROM products WHERE image_local_filename <> ''").all() as Array<{ image_local_filename: string }>;
    return rows.map((row) => row.image_local_filename);
  }

  purgeCatalog(): { products: number; drafts: number; sourceCache: number; publishEvents: number; imageFilenames: string[] } {
    const imageFilenames = this.getOwnedImageFilenames();
    const transaction = this.database.transaction(() => {
      const products = Number((this.database.prepare('SELECT COUNT(*) AS count FROM products').get() as { count: number }).count);
      const drafts = Number((this.database.prepare('SELECT COUNT(*) AS count FROM drafts').get() as { count: number }).count);
      const sourceCache = Number((this.database.prepare('SELECT COUNT(*) AS count FROM source_cache').get() as { count: number }).count);
      const publishEvents = Number((this.database.prepare('SELECT COUNT(*) AS count FROM publish_events').get() as { count: number }).count);
      this.database.prepare('DELETE FROM publish_events').run();
      this.database.prepare('DELETE FROM source_cache').run();
      this.database.prepare('DELETE FROM products').run();
      this.database.prepare('DELETE FROM drafts').run();
      this.markInitializationComplete();
      return { products, drafts, sourceCache, publishEvents, imageFilenames };
    });
    return transaction() as { products: number; drafts: number; sourceCache: number; publishEvents: number; imageFilenames: string[] };
  }

  getDraft(draftId: string): DraftResponse {
    const draft = this.database.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId) as DraftRow | undefined;
    if (!draft) throw new Error('Draft not found.');
    const products = this.database.prepare('SELECT * FROM products WHERE draft_id = ? ORDER BY row_number').all(draftId) as ProductRow[];
    return { draft: this.toSummary(draft, products), products: products.map((product) => this.toProduct(product)) };
  }

  updateProduct(draftId: string, productId: string, patch: Partial<ProductDraft>): ProductDraft {
    this.updateProducts(draftId, [{ id: productId, changes: patch }]);
    return this.getDraft(draftId).products.find((product) => product.id === productId) ?? (() => { throw new Error('Product not found.'); })();
  }

  updateProducts(draftId: string, updates: Array<{ id: string; changes: Partial<ProductDraft> }>): ProductDraft[] {
    const columns: Record<string, string> = {
      imageUrl: 'image_url', title: 'title', stockOnHand: 'stock_on_hand', casePrice: 'case_price', unitPrice: 'unit_price',
      suggestedSalePrice: 'suggested_sale_price', inventoryQuantity: 'inventory_quantity', descriptionHtml: 'description_html', brand: 'brand', country: 'country', region: 'region', productType: 'product_type',
      abv: 'abv', containerType: 'container_type', style: 'style', selected: 'selected', featured: 'is_featured', publishToOnlineStore: 'publish_to_online_store', selectedCollectionIds: 'collection_ids',
    };
    const transaction = this.database.transaction(() => {
      const now = new Date().toISOString();
      for (const update of updates) {
        const keys = Object.keys(update.changes);
        const changes = update.changes as Record<string, unknown>;
        if (keys.some((key) => !Object.hasOwn(columns, key))) throw new Error(`Unsupported product field in save: ${keys.find((key) => !Object.hasOwn(columns, key))}.`);
        const existing = this.database.prepare('SELECT id FROM products WHERE id = ? AND draft_id = ?').get(update.id, draftId);
        if (!existing) throw new Error(`Product ${update.id} was not found in this catalog.`);
        if (!keys.length) continue;
        const assignments = keys.map((key) => `${columns[key]} = ?`);
        const values = keys.map((key) => (key === 'selected' || key === 'featured' || key === 'publishToOnlineStore') ? (changes[key] ? 1 : 0) : key === 'selectedCollectionIds' ? JSON.stringify(changes[key] ?? []) : changes[key]);
        if (keys.includes('suggestedSalePrice')) assignments.push('sale_price_overridden = 1');
        values.push(update.id, draftId);
        this.database.prepare(`UPDATE products SET ${assignments.join(', ')} WHERE id = ? AND draft_id = ?`).run(...values);
      }
      if (updates.some((update) => Object.keys(update.changes).length > 0)) {
        this.database.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(now, draftId);
      }
    });
    transaction();
    const products = this.getDraft(draftId).products;
    return updates.map((update) => products.find((product) => product.id === update.id) as ProductDraft);
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
    return row ? { details: JSON.parse(row.details_json || '{}') as EnrichedProductDetails, status: row.status as ProductDraft['enrichmentStatus'], error: row.error, fetchedAt: row.fetched_at } : null;
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
      failedProducts: products.filter((product) => product.publish_status === 'failed' || product.publish_status === 'skipped').length,
    };
  }

  private toProduct(row: ProductRow): ProductDraft {
    const validationErrors = (JSON.parse(row.validation_errors || '[]') as string[]).filter((error) =>
      error !== 'Duplicate title in this import.' &&
      !(row.unit_price === null && error === 'Unit price must be greater than zero (column J).'));
    return {
      id: row.id, draftId: row.draft_id, rowNumber: row.row_number, imageUrl: row.image_url, imageLocalFilename: row.image_local_filename, imageLocalUrl: row.image_local_url, imageStatus: row.image_status as ProductDraft['imageStatus'],
      supplierProductKey: row.supplier_product_key, title: row.title, sourceUrl: row.source_url, stockOnHand: row.stock_on_hand, casePrice: row.case_price, unitPrice: row.unit_price,
      suggestedSalePrice: row.suggested_sale_price, inventoryQuantity: row.inventory_quantity,
      descriptionHtml: row.description_html, brand: row.brand, country: row.country, region: row.region, productType: row.product_type, supplierType: row.supplier_type,
      abv: row.abv, containerType: row.container_type, style: row.style, enrichmentStatus: row.enrichment_status as ProductDraft['enrichmentStatus'],
      enrichmentError: row.enrichment_error, enrichmentFetchedAt: row.enrichment_fetched_at, selected: Boolean(row.selected), publishStatus: row.publish_status as PublishStatus,
      publishError: row.publish_error, shopifyProductId: row.shopify_product_id, shopifyMatchCount: row.shopify_match_count,
      validationErrors, raw: JSON.parse(row.raw_json || '{}') as Record<string, unknown>, featured: Boolean(row.is_featured),
      publishToOnlineStore: Boolean(row.publish_to_online_store),
      selectedCollectionIds: JSON.parse(row.collection_ids || '[]') as string[],
    };
  }
}

type DraftRow = { id: string; filename: string; created_at: string; updated_at: string };
type ProductRow = {
  id: string; draft_id: string; row_number: number; supplier_product_key: string; supplier_product_key_normalized: string; image_url: string; image_local_filename: string; image_local_url: string; image_status: string; title: string; source_url: string;
  stock_on_hand: number | null; case_price: number | null; unit_price: number | null; suggested_sale_price: number | null; inventory_quantity: number; sale_price_overridden: number; description_html: string; brand: string;
  country: string; region: string; product_type: string; supplier_type: string; abv: string; container_type: string; style: string; enrichment_status: string;
  enrichment_error: string; enrichment_fetched_at: string | null; selected: number; publish_status: string; publish_error: string;
  shopify_product_id: string | null; shopify_match_count: number | null; is_featured: number; publish_to_online_store: number; collection_ids: string; validation_errors: string; raw_json: string;
};
type CacheRow = { details_json: string; status: string; error: string; fetched_at: string; parser_version: string };
