import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { DraftStore } from './drafts/draftStore.js';
import { parseWorkbook } from './imports/xlsxParser.js';
import { AppLogger } from './logging/logger.js';
import { createImportRouter } from './routes/imports.js';
import { createPublishingRouter } from './routes/publishing.js';

const app = express();
const logger = new AppLogger(config.logDirectory);
const store = new DraftStore(config.databasePath);

try {
  if (!store.hasInitializationMarker()) {
    if (store.hasProducts()) {
      store.markInitializationComplete();
      logger.write('catalog.restore', 'success', { reason: 'existing-database-content' });
    } else if (fs.existsSync(config.defaultWorkbookPath)) {
      const parsed = parseWorkbook(fs.readFileSync(config.defaultWorkbookPath), crypto.randomUUID());
      if (parsed.products.length > config.maxImportRows) throw new Error(`The default workbook contains more than ${config.maxImportRows} product rows.`);
      const result = store.mergeWorkbook(path.basename(config.defaultWorkbookPath), parsed.products);
      store.markInitializationComplete();
      logger.write('catalog.seed', 'success', { filename: config.defaultWorkbookPath, ...result.summary, invalid: parsed.invalidRowCount, duplicateRowsSkipped: parsed.duplicateRowsSkipped, importErrors: parsed.importErrors.length });
    } else {
      logger.write('catalog.seed', 'info', { status: 'default-workbook-not-found', filename: config.defaultWorkbookPath });
    }
  } else {
    logger.write('catalog.restore', 'success', { reason: 'initial-seed-completed' });
  }
} catch (error) {
  logger.write('catalog.startup', 'failure', { error: error instanceof Error ? error.message : 'Catalog initialization failed.' });
}

app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_request, response) => response.json({ ok: true, version: config.appVersion }));
app.get('/api/ready', (_request, response) => {
  const missing: string[] = []
  if (!config.shopifyAdminAccessToken) missing.push('SHOPIFY_ADMIN_ACCESS_TOKEN')
  if (!config.shopifyLocationId) missing.push('SHOPIFY_LOCATION_ID')
  response.json({
    ok: true,
    version: config.appVersion,
    shopifyConfigured: missing.length === 0,
    storeDomain: config.storeDomain,
    missing,
    collections: config.shopifyCollections,
  });
});
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
