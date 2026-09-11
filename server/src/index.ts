import 'dotenv/config';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { DraftStore } from './drafts/draftStore.js';
import { parseWorkbook } from './imports/xlsxParser.js';
import { transformToStandard } from './imports/transformWorkbook.js';
import { STANDARD_HEADERS } from './imports/standardFormat.js';
import { AppLogger } from './logging/logger.js';
import { createImportRouter } from './routes/imports.js';
import { createPublishingRouter } from './routes/publishing.js';
import { AuthService } from './auth/authService.js';
import { createAuthRouter } from './auth/authRouter.js';
import { createAuthMiddleware } from './auth/authMiddleware.js';

const app = express();
const logger = new AppLogger(config.logDirectory, config.logDirectory);
const store = new DraftStore(config.databasePath);

// VIC-23: Auto-increment APP_VERSION on code change
config.appVersion = store.computeRuntimeVersion(config.appVersion, store.resolveGitCommit());
console.log(`[eComInt] Runtime version: v${config.appVersion}`);

const authService = new AuthService(config.databasePath);
const authMiddleware = createAuthMiddleware(authService, logger);

// Clean up expired sessions on startup
authService.cleanupExpiredSessions();

// ── Startup Seed (first user only) ─────────────────────────────

try {
  const db = (store as any).database;
  const hasAnyUsers = db.prepare('SELECT 1 FROM users LIMIT 1').get() as { '1': number } | undefined;
  if (!hasAnyUsers) {
    if (fs.existsSync(config.defaultWorkbookPath)) {
      const user = authService.register('admin', 'admin');
      const { rows } = transformToStandard(fs.readFileSync(config.defaultWorkbookPath));
      const seedHeaders = [...STANDARD_HEADERS];
      const ws = XLSX.utils.aoa_to_sheet([seedHeaders, ...rows.map((r) => r.values)]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      const transformedBuffer = Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
      const parsed = parseWorkbook(transformedBuffer, user.id);
      if (parsed.products.length > config.maxImportRows) throw new Error(`The default workbook contains more than ${config.maxImportRows} product rows.`);
      const session = authService.login('admin', 'admin');
      store.createSession(session.token, user.id, session.expiresAt);
      const result = store.mergeWorkbook(path.basename(config.defaultWorkbookPath), user.id, parsed.products);
      store.markInitializationComplete(user.id);
      logger.write('catalog.seed', 'success', { filename: config.defaultWorkbookPath, userId: user.id, ...result.summary, invalid: parsed.invalidRowCount, duplicateRowsSkipped: parsed.duplicateRowsSkipped, importErrors: parsed.importErrors.length });
      console.log(`[eComInt] Initial setup complete. Default login: admin / admin`);
      logger.write('catalog.seed', 'info', { message: 'Default login credentials: admin / admin' });
    } else {
      logger.write('catalog.seed', 'info', { status: 'default-workbook-not-found' });
    }
  } else {
    logger.write('catalog.restore', 'success', { reason: 'existing-users' });
    // Reassign orphaned rows (created before multi-tenancy) to the first user
    const firstUser = db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get() as { id: string } | undefined;
    if (firstUser) {
      const reassignedProducts = Number(db.prepare("UPDATE products SET user_id = ? WHERE user_id IS NULL").run(firstUser.id).changes);
      const reassignedDrafts = Number(db.prepare("UPDATE drafts SET user_id = ? WHERE user_id IS NULL").run(firstUser.id).changes);
      if (reassignedProducts > 0 || reassignedDrafts > 0) {
        logger.write('catalog.restore', 'success', { reason: 'reassigned-orphaned-data', userId: firstUser.id, products: reassignedProducts, drafts: reassignedDrafts });
      }
    }
  }
} catch (error) {
  logger.write('catalog.startup', 'failure', { error: error instanceof Error ? error.message : 'Catalog initialization failed.' });
}

// ── Middleware ───────────────────────────────────────────────────

app.use(express.json({ limit: '2mb' }));
app.use(authMiddleware);

// ── Routes ───────────────────────────────────────────────────────

app.get('/api/health', (_request, response) => response.json({ ok: true, version: config.appVersion }));
app.get('/api/ready', (_request, response) => {
  const missing: string[] = [];
  if (!config.shopifyAdminAccessToken) missing.push('SHOPIFY_ADMIN_ACCESS_TOKEN');
  if (!config.shopifyLocationId) missing.push('SHOPIFY_LOCATION_ID');
  const wooMissing: string[] = [];
  if (!config.wooCommerceStoreUrl) wooMissing.push('WOOCOMMERCE_STORE_URL');
  if (!config.wooCommerceConsumerKey) wooMissing.push('WOOCOMMERCE_CONSUMER_KEY');
  if (!config.wooCommerceConsumerSecret) wooMissing.push('WOOCOMMERCE_CONSUMER_SECRET');
  // App password is needed for WordPress media library uploads (Strategy 2).
  // SERVER_URL (Strategy 1) works without it.
  const wooAppPasswordMissing: string[] = [];
  if (!config.wooCommerceUsername) wooAppPasswordMissing.push('WOOCOMMERCE_USERNAME');
  if (!config.wooCommerceAppPassword) wooAppPasswordMissing.push('WOOCOMMERCE_APP_PASSWORD');
  response.json({
    ok: true,
    version: config.appVersion,
    shopifyConfigured: missing.length === 0,
    storeDomain: config.storeDomain,
    missing,
    collections: config.shopifyCollections,
    wooCategories: config.wooCategories,
    wooConfigured: wooMissing.length === 0,
    wooStoreUrl: config.wooCommerceStoreUrl,
    wooMissing,
    wooAppPasswordMissing,
    wooMediaUploadReady: wooAppPasswordMissing.length === 0,
    serverUrl: config.serverUrl,
  });
});
app.use('/api/auth', createAuthRouter(authService, logger));
app.use(createImportRouter(store, logger));
app.use(createPublishingRouter(store, logger));
app.use('/productimage', express.static(config.productImageDirectory, { maxAge: '1d', index: false }));

const clientDist = path.resolve(process.cwd(), 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api(?:\/|$)|\/productimage(?:\/|$)).*/, (_request, response) => {
    response.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  logger.write('http.error', 'failure', { error: message });
  response.status(500).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`eComInt server listening on http://localhost:${config.port}`);
});
