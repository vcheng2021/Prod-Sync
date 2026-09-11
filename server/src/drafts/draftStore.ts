import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
        updated_at TEXT NOT NULL,
        user_id TEXT
      );
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        supplier_product_key TEXT NOT NULL DEFAULT '',
        supplier_product_key_normalized TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL,
        image_urls TEXT NOT NULL DEFAULT '[]',
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
        source_platform TEXT NOT NULL DEFAULT '',
        abv TEXT NOT NULL,
        container_type TEXT NOT NULL,
        style TEXT NOT NULL,
        enrichment_status TEXT NOT NULL,
        enrichment_error TEXT NOT NULL,
        enrichment_fetched_at TEXT,
        enrichment_partial INTEGER NOT NULL DEFAULT 0,
        failed_enrichment_fields TEXT NOT NULL DEFAULT '[]',
        supplier TEXT NOT NULL DEFAULT 'cellar',
        product_attributes TEXT NOT NULL DEFAULT '',
        product_description TEXT NOT NULL DEFAULT '',
        aliexpress_images TEXT NOT NULL DEFAULT '[]',
        original_product_attributes TEXT NOT NULL DEFAULT '',
        original_product_description TEXT NOT NULL DEFAULT '',
        selected_image_index INTEGER NOT NULL DEFAULT 0,
        cost_price REAL,
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
        parser_version TEXT NOT NULL DEFAULT '1',
        user_id TEXT
      );
      CREATE TABLE IF NOT EXISTS publish_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        status TEXT NOT NULL,
        shopify_product_id TEXT,
        error TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        user_id TEXT
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS platform_configs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        config_json TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
    this.addColumnIfMissing('products', 'image_local_filename', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'image_local_url', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'image_urls', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('products', 'supplier_product_key', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'supplier_product_key_normalized', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'suggested_sale_price', 'REAL');
    this.addColumnIfMissing('products', 'inventory_quantity', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('products', 'sale_price_overridden', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('products', 'is_featured', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('products', 'publish_to_online_store', 'INTEGER NOT NULL DEFAULT 1');
    this.addColumnIfMissing('products', 'collection_ids', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('products', 'supplier_type', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'source_platform', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'enrichment_partial', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('products', 'failed_enrichment_fields', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('products', 'supplier', "TEXT NOT NULL DEFAULT 'cellar'");
    this.addColumnIfMissing('products', 'product_attributes', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'product_description', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'aliexpress_images', "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing('products', 'original_product_attributes', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'original_product_description', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('products', 'selected_image_index', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('products', 'cost_price', 'REAL');
    this.addColumnIfMissing('source_cache', 'parser_version', "TEXT NOT NULL DEFAULT '1'");
    this.addColumnIfMissing('source_cache', 'user_id', "TEXT");
    this.addColumnIfMissing('publish_events', 'user_id', "TEXT");
    this.addColumnIfMissing('app_state', 'user_id', "TEXT");
    this.addColumnIfMissing('drafts', 'user_id', "TEXT");
    this.addColumnIfMissing('products', 'user_id', "TEXT");
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

  // ── User Management ──────────────────────────────────────────────────

  createUser(username: string, passwordHash: string): { id: string; username: string } {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.database.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, username, passwordHash, now, now);
    return { id, username };
  }

  findUserByUsername(username: string): { id: string; password_hash: string } | undefined {
    return this.database.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username.trim()) as { id: string; password_hash: string } | undefined;
  }

  createSession(token: string, userId: string, expiresAt: string): void {
    this.database.prepare('INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, new Date().toISOString(), expiresAt);
  }

  validateSession(token: string): { id: string; username: string } | null {
    const row = this.database.prepare(`
      SELECT us.user_id, u.username FROM user_sessions us
      JOIN users u ON us.user_id = u.id
      WHERE us.token = ? AND us.expires_at > ?
    `).get(token, new Date().toISOString()) as { user_id: string; username: string } | undefined;
    if (!row) return null;
    return { id: row.user_id, username: row.username };
  }

  deleteSession(token: string): void {
    this.database.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
  }

  cleanupExpiredSessions(): void {
    this.database.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(new Date().toISOString());
  }

  // ── Platform Configs ─────────────────────────────────────────────────

  savePlatformConfig(userId: string, platform: string, configJson: string, isActive: boolean): void {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const existing = this.database.prepare('SELECT id FROM platform_configs WHERE user_id = ? AND platform = ?').get(userId, platform) as { id: string } | undefined;
    if (existing) {
      this.database.prepare('UPDATE platform_configs SET config_json = ?, is_active = ?, updated_at = ? WHERE id = ?').run(configJson, isActive ? 1 : 0, now, existing.id);
    } else {
      this.database.prepare('INSERT INTO platform_configs (id, user_id, platform, config_json, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, userId, platform, configJson, isActive ? 1 : 0, now, now);
    }
  }

  getPlatformConfig(userId: string, platform: string): { id: string; configJson: string; isActive: boolean } | null {
    const row = this.database.prepare('SELECT id, config_json, is_active FROM platform_configs WHERE user_id = ? AND platform = ?').get(userId, platform) as { id: string; config_json: string; is_active: number } | undefined;
    if (!row) return null;
    return { id: row.id, configJson: row.config_json, isActive: row.is_active === 1 };
  }

  getActivePlatform(userId: string): string | null {
    const row = this.database.prepare('SELECT platform FROM platform_configs WHERE user_id = ? AND is_active = 1 LIMIT 1').get(userId) as { platform: string } | undefined;
    return row?.platform ?? null;
  }

  // ── User-Scoped Draft Operations ─────────────────────────────────────

  createDraft(filename: string, userId: string, products: ProductDraft[]): DraftResponse {
    return this.mergeWorkbook(filename, userId, products).draft;
  }

  mergeWorkbook(filename: string, userId: string, products: ProductDraft[]): { draft: DraftResponse; summary: WorkbookImportSummary } {
    const currentDraft = this.getCurrentDraftRow(userId);
    const draftId = currentDraft?.id ?? products[0]?.draftId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const insertDraft = this.database.prepare('INSERT INTO drafts (id, filename, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)');
    const insertProduct = this.database.prepare(`INSERT INTO products (
      id, draft_id, user_id, row_number, supplier_product_key, supplier_product_key_normalized, image_url, image_urls, image_status, title, source_url, stock_on_hand, case_price, unit_price, suggested_sale_price, inventory_quantity, sale_price_overridden,
      description_html, brand, country, region, product_type, supplier_type, source_platform, abv, container_type, style, enrichment_status,
      enrichment_error, enrichment_fetched_at, enrichment_partial, failed_enrichment_fields, selected, publish_status, publish_error, shopify_product_id,
      shopify_match_count, is_featured, publish_to_online_store, collection_ids, aliexpress_images, selected_image_index, cost_price, validation_errors, raw_json, supplier
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const findProduct = this.database.prepare('SELECT * FROM products WHERE draft_id = ? AND supplier_product_key_normalized = ? AND user_id = ?') as Database.Statement;
    const updateProduct = this.database.prepare(`UPDATE products SET
      row_number = ?, supplier_product_key = ?, image_url = ?, image_urls = ?, image_local_filename = ?, image_local_url = ?, image_status = ?, title = ?, source_url = ?, stock_on_hand = ?, case_price = ?, unit_price = ?, suggested_sale_price = ?,
      description_html = ?, brand = ?, country = ?, region = ?, product_type = ?, supplier_type = ?, source_platform = ?, abv = ?, container_type = ?, style = ?, enrichment_status = ?, enrichment_error = ?, enrichment_fetched_at = ?,
      aliexpress_images = ?, validation_errors = ?, raw_json = ?, supplier = ? WHERE id = ? AND draft_id = ? AND user_id = ?`);
    const transaction = this.database.transaction(() => {
      if (!currentDraft) insertDraft.run(draftId, filename, now, now, userId);
      else this.database.prepare('UPDATE drafts SET filename = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(filename, now, draftId, userId);
      const summary: WorkbookImportSummary = { added: 0, updated: 0, unchanged: 0, invalid: 0, duplicateRowsSkipped: 0 };
      for (const product of products) {
        const normalizedKey = normalizeKey(product.supplierProductKey);
        if (!normalizedKey) { summary.invalid += 1; continue; }
        const existing = findProduct.get(draftId, normalizedKey, userId) as ProductRow | undefined;
        if (!existing) {
          insertProduct.run(
            product.id, draftId, userId, product.rowNumber, product.supplierProductKey, normalizedKey, product.imageUrl, JSON.stringify(product.imageUrls ?? []), product.imageStatus, product.title, product.sourceUrl,
            product.stockOnHand, product.casePrice, product.unitPrice, product.suggestedSalePrice, product.inventoryQuantity, 0, product.descriptionHtml, product.brand, product.country,
            product.region, product.productType, product.supplierType, product.sourcePlatform ?? '', product.abv, product.containerType, product.style, product.enrichmentStatus,
            product.enrichmentError, product.enrichmentFetchedAt, product.enrichmentPartial ? 1 : 0, JSON.stringify(product.failedEnrichmentFields ?? []), product.selected ? 1 : 0, product.publishStatus, product.publishError,
            product.shopifyProductId, product.shopifyMatchCount, product.featured ? 1 : 0, product.publishToOnlineStore ? 1 : 0, JSON.stringify(product.selectedCollectionIds ?? []), JSON.stringify(product.aliexpressImages ?? []), product.selectedImageIndex, product.costPrice, JSON.stringify(product.validationErrors), JSON.stringify(product.raw), product.supplier,
          );
          summary.added += 1; continue;
        }
        const previousAutomaticPrice = existing.unit_price === null ? null : currencyValue(existing.unit_price * 1.25);
        const preserveAutomaticPrice = existing.sale_price_overridden === 0 && (existing.suggested_sale_price === null || existing.suggested_sale_price === previousAutomaticPrice);
        const suggestedSalePrice = preserveAutomaticPrice ? product.suggestedSalePrice : existing.suggested_sale_price;
        const sourceChanged = existing.source_url !== product.sourceUrl;
        const imageChanged = existing.image_url !== product.imageUrl;
        const unchanged = existing.supplier_product_key === product.supplierProductKey && existing.image_url === product.imageUrl && existing.title === product.title && existing.source_url === product.sourceUrl && existing.stock_on_hand === product.stockOnHand && existing.case_price === product.casePrice && existing.unit_price === product.unitPrice && existing.supplier_type === product.supplierType;
        updateProduct.run(
          product.rowNumber, product.supplierProductKey, product.imageUrl, JSON.stringify(product.imageUrls ?? []), imageChanged ? '' : existing.image_local_filename, imageChanged ? '' : existing.image_local_url, imageChanged ? product.imageStatus : existing.image_status, product.title, product.sourceUrl,
          product.stockOnHand, product.casePrice, product.unitPrice, suggestedSalePrice, sourceChanged ? existing.description_html : existing.description_html,
          existing.brand, existing.country, existing.region, existing.product_type, product.supplierType, existing.source_platform ?? '', existing.abv, existing.container_type, existing.style,
          sourceChanged ? (product.sourceUrl ? 'pending' : 'not-provided') : existing.enrichment_status, sourceChanged ? '' : existing.enrichment_error,
          sourceChanged ? null : existing.enrichment_fetched_at, JSON.stringify(product.aliexpressImages ?? []), JSON.stringify(product.validationErrors), JSON.stringify(product.raw), product.supplier, existing.id, draftId, userId,
        );
        summary[unchanged ? 'unchanged' : 'updated'] += 1;
      }
      this.database.prepare('UPDATE drafts SET updated_at = ? WHERE id = ? AND user_id = ?').run(now, draftId, userId);
      return summary;
    });
    const summary = transaction() as WorkbookImportSummary;
    return { draft: this.getDraft(draftId, userId), summary };
  }

  private getCurrentDraftRow(userId: string): DraftRow | undefined {
    return this.database.prepare('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1').get(userId) as DraftRow | undefined;
  }

  getCurrentDraft(userId: string): DraftResponse | null {
    const draft = this.getCurrentDraftRow(userId);
    return draft ? this.getDraft(draft.id, userId) : null;
  }

  // VIC-22: Get the most recently updated draft that has at least one product
  // matching the given supplier. Returns null if no matching draft exists.
  // VIC-23: Filter the returned products to only those matching the requested supplier.
  getCurrentDraftBySupplier(userId: string, supplier: string): DraftResponse | null {
    const row = this.database.prepare(
      `SELECT d.* FROM drafts d
       JOIN products p ON p.draft_id = d.id
       WHERE d.user_id = ? AND p.supplier = ?
       ORDER BY d.updated_at DESC, d.created_at DESC
       LIMIT 1`
    ).get(userId, supplier) as DraftRow | undefined;
    if (!row) return null;
    const fullDraft = this.getDraft(row.id, userId);
    const supplierProducts = fullDraft.products.filter((p) => p.supplier === supplier);
    return {
      draft: { ...fullDraft.draft, totalProducts: supplierProducts.length },
      products: supplierProducts,
    };
  }

  hasProducts(userId: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM products WHERE user_id = ? LIMIT 1').get(userId));
  }

  hasInitializationMarker(userId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM app_state WHERE key = 'initial_seed_completed' AND user_id = ?").get(userId));
  }

  markInitializationComplete(userId: string): void {
    this.database.prepare("INSERT OR REPLACE INTO app_state (key, value, user_id) VALUES ('initial_seed_completed', 'true', ?)").run(userId);
  }

  // ── App runtime version auto-increment (VIC-23) ─────────────────────

  getAppState(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM app_state WHERE key = ? AND user_id IS NULL").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setAppState(key: string, value: string): void {
    this.database.prepare("INSERT OR REPLACE INTO app_state (key, value, user_id) VALUES (?, ?, NULL)").run(key, value);
  }

  /**
   * VIC-23: Resolve the current git commit hash. Tries `git rev-parse HEAD`
   * first; falls back to reading a build-time injected fingerprint file
   * (written by the Dockerfile at build time when git is unavailable
   * at runtime, e.g. in the Docker image).
   */
  resolveGitCommit(): string | null {
    // 1. Try git rev-parse HEAD (local dev, or containers with git installed)
    try {
      const hash = execFileSync('git', ['rev-parse', 'HEAD'], {
        timeout: 5_000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (hash && hash.length >= 7) return hash;
    } catch {
      // git not available — fall through to build-commit file
    }
    // 2. Fallback: build-time inject file (Docker runtime)
    const fingerprintFiles = [
      path.resolve(process.cwd(), '.build-commit'),
      '/app/.build-commit',
    ];
    for (const file of fingerprintFiles) {
      try {
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, 'utf8').trim();
          if (content && content !== 'unknown') return content;
        }
      } catch {
        // file not readable — try next
      }
    }
    // 3. Fallback: env var
    const envHash = process.env.APP_BUILD_COMMIT;
    if (envHash && envHash !== 'unknown') return envHash;
    return null;
  }

  /**
   * VIC-23: Compute the runtime version. On first call (no stored commit),
   * the version starts at the `APP_VERSION` env value. On each subsequent
   * startup where the git commit hash differs from the stored one, the patch
   * segment (third number) is incremented by 1. The version and commit hash
   * are persisted in the `app_state` table so they survive restarts.
   *
   * The returned runtime version is the canonical version served by
   * `/api/health` and `/api/ready` (the caller should set `config.appVersion`
   * to the return value).
   */
  computeRuntimeVersion(baseVersion: string, gitCommit: string | null): string {
    const storedCommit = this.getAppState('app_last_commit');
    const storedVersion = this.getAppState('app_runtime_version');

    // If git is unavailable and no stored version, fall back to baseVersion
    const commitChanged = gitCommit && (!storedCommit || storedCommit !== gitCommit);

    if (!commitChanged) {
      // Unchanged code — return stored version (or baseVersion if first startup)
      return storedVersion ?? baseVersion;
    }

    // Code has changed (new commit) — increment the patch segment
    let version: string;
    if (storedVersion) {
      // Parse stored version and increment patch
      const parts = storedVersion.split('.').map(Number);
      if (parts.length >= 3 && !parts.slice(0, 3).some(Number.isNaN)) {
        parts[2] += 1;
        version = parts.slice(0, 3).join('.');
      } else {
        version = storedVersion; // can't parse — don't guess
      }
    } else {
      // First startup with this commit — use baseVersion as-is
      version = baseVersion;
    }

    // Persist the new version + commit
    this.setAppState('app_runtime_version', version);
    this.setAppState('app_last_commit', gitCommit!);

    return version;
  }

  getOwnedImageFilenames(userId: string): string[] {
    const rows = this.database.prepare("SELECT image_local_filename FROM products WHERE image_local_filename <> '' AND user_id = ?").all(userId) as Array<{ image_local_filename: string }>;
    return rows.map((row) => row.image_local_filename);
  }

  purgeCatalog(userId: string): { products: number; drafts: number; sourceCache: number; publishEvents: number; imageFilenames: string[] } {
    const imageFilenames = this.getOwnedImageFilenames(userId);
    const transaction = this.database.transaction(() => {
      const products = Number((this.database.prepare('SELECT COUNT(*) AS count FROM products WHERE user_id = ?').get(userId) as { count: number }).count);
      const drafts = Number((this.database.prepare('SELECT COUNT(*) AS count FROM drafts WHERE user_id = ?').get(userId) as { count: number }).count);
      const sourceCache = Number((this.database.prepare('SELECT COUNT(*) AS count FROM source_cache WHERE user_id = ?').get(userId) as { count: number }).count);
      const publishEvents = Number((this.database.prepare('SELECT COUNT(*) AS count FROM publish_events WHERE user_id = ?').get(userId) as { count: number }).count);
      this.database.prepare('DELETE FROM publish_events WHERE user_id = ?').run(userId);
      this.database.prepare('DELETE FROM source_cache WHERE user_id = ?').run(userId);
      this.database.prepare('DELETE FROM products WHERE user_id = ?').run(userId);
      this.database.prepare('DELETE FROM drafts WHERE user_id = ?').run(userId);
      this.markInitializationComplete(userId);
      return { products, drafts, sourceCache, publishEvents, imageFilenames };
    });
    return transaction() as { products: number; drafts: number; sourceCache: number; publishEvents: number; imageFilenames: string[] };
  }

  getDraft(draftId: string, userId: string): DraftResponse {
    const draft = this.database.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(draftId, userId) as DraftRow | undefined;
    if (!draft) throw new Error('Draft not found.');
    const products = this.database.prepare('SELECT * FROM products WHERE draft_id = ? AND user_id = ? ORDER BY row_number').all(draftId, userId) as ProductRow[];
    return { draft: this.toSummary(draft, products), products: products.map((product) => this.toProduct(product)) };
  }

  updateProduct(draftId: string, userId: string, productId: string, patch: Partial<ProductDraft>): ProductDraft {
    this.updateProducts(draftId, userId, [{ id: productId, changes: patch }]);
    return this.getDraft(draftId, userId).products.find((product) => product.id === productId) ?? (() => { throw new Error('Product not found.'); })();
  }

  updateProducts(draftId: string, userId: string, updates: Array<{ id: string; changes: Partial<ProductDraft> }>): ProductDraft[] {
    const columns: Record<string, string> = {
      imageUrl: 'image_url', imageUrls: 'image_urls', title: 'title', stockOnHand: 'stock_on_hand', casePrice: 'case_price', unitPrice: 'unit_price',
      suggestedSalePrice: 'suggested_sale_price', inventoryQuantity: 'inventory_quantity', descriptionHtml: 'description_html', brand: 'brand', country: 'country', region: 'region', productType: 'product_type',
      abv: 'abv', containerType: 'container_type', style: 'style', selected: 'selected', featured: 'is_featured', publishToOnlineStore: 'publish_to_online_store', selectedCollectionIds: 'collection_ids',
      selectedImageIndex: 'selected_image_index', costPrice: 'cost_price', sourcePlatform: 'source_platform',
      // VIC-17: AliExpress-specific editable fields
      productAttributes: 'product_attributes', productDescription: 'product_description',
      aliexpressImages: 'aliexpress_images',
      // VIC-18: Supplier routing
      supplier: 'supplier',
    };
    const transaction = this.database.transaction(() => {
      const now = new Date().toISOString();
      for (const update of updates) {
        const keys = Object.keys(update.changes);
        const changes = update.changes as Record<string, unknown>;
        if (keys.some((key) => !Object.hasOwn(columns, key))) throw new Error(`Unsupported product field in save: ${keys.find((key) => !Object.hasOwn(columns, key))}.`);
        const existing = this.database.prepare('SELECT id FROM products WHERE id = ? AND draft_id = ? AND user_id = ?').get(update.id, draftId, userId);
        if (!existing) throw new Error(`Product ${update.id} was not found in this catalog.`);
        if (!keys.length) continue;
        const assignments = keys.map((key) => `${columns[key]} = ?`);
        const values = keys.map((key) => (key === 'selected' || key === 'featured' || key === 'publishToOnlineStore') ? (changes[key] ? 1 : 0) : (key === 'selectedCollectionIds' || key === 'aliexpressImages') ? JSON.stringify(changes[key] ?? []) : changes[key]);
        if (keys.includes('suggestedSalePrice')) assignments.push('sale_price_overridden = 1');
        values.push(update.id, draftId, userId);
        this.database.prepare(`UPDATE products SET ${assignments.join(', ')} WHERE id = ? AND draft_id = ? AND user_id = ?`).run(...values);
      }
      if (updates.some((update) => Object.keys(update.changes).length > 0)) {
        this.database.prepare('UPDATE drafts SET updated_at = ? WHERE id = ? AND user_id = ?').run(now, draftId, userId);
      }
    });
    transaction();
    const products = this.getDraft(draftId, userId).products;
    return updates.map((update) => products.find((product) => product.id === update.id) as ProductDraft);
  }

  saveEnrichment(draftId: string, userId: string, productId: string, result: { status: ProductDraft['enrichmentStatus']; details: EnrichedProductDetails; error: string; enrichmentPartial?: boolean; failedFields?: string[] }): void {
    const now = new Date().toISOString();

    // Determine the original values for AliExpress fields (to keep for reset)
    const existingProduct = this.database.prepare('SELECT product_attributes, product_description, aliexpress_images, original_product_attributes, original_product_description, selected_image_index FROM products WHERE id = ? AND draft_id = ? AND user_id = ?').get(productId, draftId, userId) as {
      product_attributes: string;
      product_description: string;
      aliexpress_images: string;
      original_product_attributes: string;
      original_product_description: string;
      selected_image_index: number | null;
    } | undefined;

    // Set original values if not already set (first retrieval)
    const originalAttributes = existingProduct?.original_product_attributes || result.details.productAttributes || '';
    const originalDescription = existingProduct?.original_product_description || result.details.productDescription || '';

    this.database.prepare(`UPDATE products SET
      description_html = ?,
      brand = ?,
      country = ?,
      region = ?,
      product_type = ?,
      abv = ?,
      container_type = ?,
      style = ?,
      enrichment_status = ?,
      enrichment_error = ?,
      enrichment_fetched_at = ?,
      enrichment_partial = ?,
      failed_enrichment_fields = ?,
      product_attributes = ?,
      product_description = ?,
      aliexpress_images = ?,
      original_product_attributes = ?,
      original_product_description = ?,
      selected_image_index = ?
     WHERE id = ? AND draft_id = ? AND user_id = ?`)
      .run(
        result.details.descriptionHtml,
        result.details.brand,
        result.details.country,
        result.details.region,
        result.details.productType,
        result.details.abv,
        result.details.containerType,
        result.details.style,
        result.status,
        result.error,
        now,
        result.enrichmentPartial ? 1 : 0,
        JSON.stringify(result.failedFields ?? []),
        result.details.productAttributes || existingProduct?.product_attributes || '',
        result.details.productDescription || existingProduct?.product_description || '',
        JSON.stringify(result.details.aliexpressImages ?? []),
        originalAttributes,
        originalDescription,
        result.details.aliexpressImages ? 0 : (existingProduct?.selected_image_index ?? 0),
        productId,
        draftId,
        userId
      );
    this.database.prepare('UPDATE drafts SET updated_at = ? WHERE id = ? AND user_id = ?').run(now, draftId, userId);
  }

  saveImageStatus(draftId: string, userId: string, productId: string, status: ProductDraft['imageStatus'], error = ''): void {
    this.database.prepare('UPDATE products SET image_status = ?, publish_error = CASE WHEN ? != \'\' THEN ? ELSE publish_error END WHERE id = ? AND draft_id = ? AND user_id = ?')
      .run(status, error, error, productId, draftId, userId);
  }

  saveImageResult(draftId: string, userId: string, productId: string, result: { status: ProductDraft['imageStatus']; localFilename: string; localUrl: string; error: string }): void {
    this.database.prepare('UPDATE products SET image_status = ?, image_local_filename = ?, image_local_url = ?, publish_error = CASE WHEN ? != \'\' THEN ? ELSE publish_error END WHERE id = ? AND draft_id = ? AND user_id = ?')
      .run(result.status, result.localFilename, result.localUrl, result.error, result.error, productId, draftId, userId);
  }

  savePublishResult(draftId: string, userId: string, productId: string, status: PublishStatus, shopifyProductId: string | null, error: string): void {
    const now = new Date().toISOString();
    this.database.prepare('UPDATE products SET publish_status = ?, shopify_product_id = ?, shopify_match_count = ?, publish_error = ? WHERE id = ? AND draft_id = ? AND user_id = ?')
      .run(status, shopifyProductId, shopifyProductId ? 1 : null, error, productId, draftId, userId);
    this.database.prepare('INSERT INTO publish_events (draft_id, user_id, product_id, status, shopify_product_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(draftId, userId, productId, status, shopifyProductId, error, now);
    this.database.prepare('UPDATE drafts SET updated_at = ? WHERE id = ? AND user_id = ?').run(now, draftId, userId);
  }

  getCachedEnrichment(userId: string, url: string): { details: EnrichedProductDetails; status: ProductDraft['enrichmentStatus']; error: string; fetchedAt: string } | null {
    const row = this.database.prepare('SELECT * FROM source_cache WHERE url = ? AND parser_version = ? AND user_id = ?').get(url, ENRICHMENT_CACHE_VERSION, userId) as CacheRow | undefined;
    return row ? { details: JSON.parse(row.details_json || '{}') as EnrichedProductDetails, status: row.status as ProductDraft['enrichmentStatus'], error: row.error, fetchedAt: row.fetched_at } : null;
  }

  saveCachedEnrichment(userId: string, url: string, result: { details: EnrichedProductDetails; status: ProductDraft['enrichmentStatus']; error: string }): void {
    this.database.prepare('INSERT OR REPLACE INTO source_cache (url, details_json, status, error, fetched_at, parser_version, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(url, JSON.stringify(result.details), result.status, result.error, new Date().toISOString(), ENRICHMENT_CACHE_VERSION, userId);
  }

  // ── Internal Helpers ─────────────────────────────────────────────────

  private migrateLegacyCurrentDraft(): void {
    const rows = this.database.prepare('SELECT * FROM products ORDER BY row_number, id').all() as ProductRow[];
    if (!rows.some((row) => !row.supplier_product_key_normalized)) return;
    const updateLegacy = this.database.prepare(`UPDATE products SET supplier_product_key = ?, supplier_product_key_normalized = ?, suggested_sale_price = ?, inventory_quantity = ?, validation_errors = ? WHERE id = ?`);
    const deleteDuplicate = this.database.prepare('DELETE FROM products WHERE id = ?');
    const transaction = this.database.transaction(() => {
      const seen = new Map<string, ProductRow>();
      for (const row of rows) {
        if (row.supplier_product_key_normalized) { seen.set(row.supplier_product_key_normalized, row); continue; }
        const supplierProductKey = this.legacySupplierProductKey(row.raw_json);
        if (!supplierProductKey) { updateLegacy.run('', '', row.suggested_sale_price, row.inventory_quantity, JSON.stringify(this.withValidationError(row, 'Supplier product key could not be recovered.')), row.id); continue; }
        const normalizedKey = normalizeKey(supplierProductKey);
        const existing = seen.get(normalizedKey);
        if (existing) {
          if (this.supplierFingerprint(existing) === this.supplierFingerprint(row)) { deleteDuplicate.run(row.id); }
          else { updateLegacy.run('', '', row.suggested_sale_price, row.inventory_quantity, JSON.stringify(this.withValidationError(row, 'Conflicting legacy rows share this key.')), row.id); }
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

  private toSummary(draft: DraftRow, products: ProductRow[]): DraftSummary {
    return { id: draft.id, filename: draft.filename, createdAt: draft.created_at, updatedAt: draft.updated_at, totalProducts: products.length, selectedProducts: products.filter((product) => product.selected).length, readyProducts: products.filter((product) => product.enrichment_status === 'ready').length, failedProducts: products.filter((product) => product.publish_status === 'failed' || product.publish_status === 'skipped').length, supplier: products[0]?.supplier ?? 'cellar' };
  }

  private toProduct(row: ProductRow): ProductDraft {
    const validationErrors = (JSON.parse(row.validation_errors || '[]') as string[]).filter((error) => error !== 'Duplicate title in this import.' && !(row.unit_price === null && error === 'Unit price must be greater than zero (column J).'));
    const imageUrls: string[] = JSON.parse(row.image_urls || '[]');
    return {
      id: row.id, draftId: row.draft_id, rowNumber: row.row_number, imageUrl: row.image_url, imageUrls, imageLocalFilename: row.image_local_filename, imageLocalUrl: row.image_local_url, imageStatus: row.image_status as ProductDraft['imageStatus'],
      supplierProductKey: row.supplier_product_key, title: row.title, sourceUrl: row.source_url, stockOnHand: row.stock_on_hand, casePrice: row.case_price, unitPrice: row.unit_price,
      suggestedSalePrice: row.suggested_sale_price, inventoryQuantity: row.inventory_quantity,
      descriptionHtml: row.description_html, brand: row.brand, country: row.country, region: row.region, productType: row.product_type, supplierType: row.supplier_type, sourcePlatform: row.source_platform,
      abv: row.abv, containerType: row.container_type, style: row.style, enrichmentStatus: row.enrichment_status as ProductDraft['enrichmentStatus'],
      enrichmentError: row.enrichment_error, enrichmentFetchedAt: row.enrichment_fetched_at, selected: Boolean(row.selected), publishStatus: row.publish_status as PublishStatus,
      publishError: row.publish_error, shopifyProductId: row.shopify_product_id, shopifyMatchCount: row.shopify_match_count,
      validationErrors, raw: JSON.parse(row.raw_json || '{}') as Record<string, unknown>, featured: Boolean(row.is_featured),
      publishToOnlineStore: Boolean(row.publish_to_online_store),
      selectedCollectionIds: JSON.parse(row.collection_ids || '[]') as string[],
      enrichmentPartial: Boolean(row.enrichment_partial), failedEnrichmentFields: JSON.parse(row.failed_enrichment_fields || '[]'),
      supplier: row.supplier, productAttributes: row.product_attributes, productDescription: row.product_description,
      aliexpressImages: JSON.parse(row.aliexpress_images || '[]'), originalProductAttributes: row.original_product_attributes, originalProductDescription: row.original_product_description,
      selectedImageIndex: row.selected_image_index, costPrice: row.cost_price,
    };
  }
}

type DraftRow = { id: string; filename: string; created_at: string; updated_at: string; user_id?: string };
type ProductRow = {
  id: string; draft_id: string; user_id: string; row_number: number; supplier_product_key: string; supplier_product_key_normalized: string; image_url: string; image_urls: string; image_local_filename: string; image_local_url: string; image_status: string; title: string; source_url: string;
  stock_on_hand: number | null; case_price: number | null; unit_price: number | null; suggested_sale_price: number | null; inventory_quantity: number; sale_price_overridden: number; description_html: string; brand: string;
  country: string; region: string; product_type: string; supplier_type: string; source_platform: string; abv: string; container_type: string; style: string; enrichment_status: string;
  enrichment_error: string; enrichment_fetched_at: string | null; enrichment_partial: number; failed_enrichment_fields: string; supplier: string; product_attributes: string; product_description: string; aliexpress_images: string; original_product_attributes: string; original_product_description: string;
  selected_image_index: number; cost_price: number | null;
  selected: number; publish_status: string; publish_error: string;
  shopify_product_id: string | null; shopify_match_count: number | null; is_featured: number; publish_to_online_store: number; collection_ids: string; validation_errors: string; raw_json: string;
};
type CacheRow = { details_json: string; status: string; error: string; fetched_at: string; parser_version: string; user_id?: string };
