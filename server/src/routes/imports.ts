import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { DraftStore } from '../drafts/draftStore.js';
import { downloadProductImage } from '../enrichment/imageDownloader.js';
import { fetchProductDetails } from '../enrichment/sourcePageFetcher.js';
import { parseWorkbook } from '../imports/xlsxParser.js';
import { AppLogger } from '../logging/logger.js';
import type { ProductDraft } from '../types.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

export const createImportRouter = (store: DraftStore, logger: AppLogger): Router => {
  const router = Router();

  router.post('/api/imports', upload.single('workbook'), (request, response, next) => {
    try {
      if (!request.file) return response.status(400).json({ error: 'Attach an .xlsx workbook as the workbook field.' });
      if (!request.file.originalname.toLocaleLowerCase().endsWith('.xlsx')) {
        return response.status(400).json({ error: 'Only .xlsx workbooks are supported.' });
      }
      const draftId = crypto.randomUUID();
      const parsed = parseWorkbook(request.file.buffer, draftId);
      if (parsed.products.length > config.maxImportRows) {
        return response.status(400).json({ error: `The workbook contains more than ${config.maxImportRows} product rows.` });
      }
      const result = store.mergeWorkbook(request.file.originalname, parsed.products);
      const importSummary = { ...result.summary, invalid: parsed.invalidRowCount, duplicateRowsSkipped: parsed.duplicateRowsSkipped };
      logger.write('workbook.merge', 'success', { filename: request.file.originalname, ...importSummary, importErrors: parsed.importErrors.length });
      return response.status(200).json({ ...result.draft, sheetName: parsed.sheetName, headers: parsed.headers, importErrors: parsed.importErrors, importSummary });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/api/drafts/current', (_request, response, next) => {
    try {
      return response.json(store.getCurrentDraft());
    } catch (error) {
      logger.write('draft.restore', 'failure', { error: error instanceof Error ? error.message : 'Could not load the current catalog.' });
      return next(error);
    }
  });

  router.get('/api/issues', (request, response, next) => {
    try {
      const draftId = typeof request.query.draftId === 'string' ? request.query.draftId : undefined;
      const issues = logger.readIssues().filter((issue) => !draftId || issue.details.draftId === draftId).slice(0, 100);
      return response.json(issues);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/api/drafts/:draftId', (request, response, next) => {
    try {
      return response.json(store.getDraft(request.params.draftId));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/api/drafts/:draftId/products/:productId', (request, response, next) => {
    try {
      return response.json(store.updateProduct(request.params.draftId, request.params.productId, request.body));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/api/drafts/:draftId/products', (request, response, next) => {
    try {
      const updates = request.body?.products;
      if (!Array.isArray(updates) || updates.some((entry) => !entry || typeof entry.id !== 'string' || !entry.changes || typeof entry.changes !== 'object' || Array.isArray(entry.changes))) {
        return response.status(400).json({ error: 'Expected products with an id and changes object.' });
      }
      const products = store.updateProducts(request.params.draftId, updates as Array<{ id: string; changes: Partial<ProductDraft> }>);
      logger.write('product.save', 'success', { draftId: request.params.draftId, productCount: products.length, fieldCount: updates.reduce((total, entry) => total + Object.keys(entry.changes).length, 0) });
      return response.json({ products, draft: store.getDraft(request.params.draftId) });
    } catch (error) {
      logger.write('product.save', 'failure', { draftId: request.params.draftId, error: error instanceof Error ? error.message : 'Could not save product changes.' });
      return next(error);
    }
  });

  router.post('/api/database/purge', (request, response, next) => {
    try {
      if (request.body?.confirmation !== 'PURGE') return response.status(400).json({ error: 'Type PURGE to confirm database deletion.' });
      const result = store.purgeCatalog();
      const imageRoot = path.resolve(config.productImageDirectory);
      let removedImages = 0;
      for (const filename of result.imageFilenames) {
        const imagePath = path.resolve(imageRoot, filename);
        if (imagePath !== imageRoot && imagePath.startsWith(`${imageRoot}${path.sep}`)) {
          fs.rmSync(imagePath, { force: true });
          removedImages += 1;
        }
      }
      logger.write('database.purge', 'success', { products: result.products, drafts: result.drafts, sourceCache: result.sourceCache, publishEvents: result.publishEvents, removedImages });
      return response.json({ draft: null, ...result, imageFilenames: undefined, removedImages });
    } catch (error) {
      logger.write('database.purge', 'failure', { error: error instanceof Error ? error.message : 'Could not purge the database.' });
      return next(error);
    }
  });

  router.post('/api/drafts/:draftId/products/:productId/retrieve', async (request, response, next) => {
    try {
      const product = store.getDraft(request.params.draftId).products.find((entry) => entry.id === request.params.productId);
      if (!product) return response.status(404).json({ error: 'Product not found.' });
      if (!product.selected) return response.status(400).json({ error: 'Check this product before retrieving source data.' });
      await Promise.all([
        product.sourceUrl ? (async () => {
          const cached = store.getCachedEnrichment(product.sourceUrl);
          const result = cached ?? await fetchProductDetails(product.sourceUrl);
          if (!cached) store.saveCachedEnrichment(product.sourceUrl, result);
          store.saveEnrichment(request.params.draftId, product.id, {
            status: result.status,
            details: result.details,
            error: result.error,
          });
        })() : Promise.resolve(),
        product.imageUrl ? (async () => {
          const result = await downloadProductImage(product.imageUrl, product.id);
          store.saveImageResult(request.params.draftId, product.id, result);
        })() : Promise.resolve(),
      ]);
      logger.write('product.retrieve', 'success', { draftId: request.params.draftId, productId: product.id });
      return response.json(store.getDraft(request.params.draftId).products.find((entry) => entry.id === product.id));
    } catch (error) {
      logger.write('product.retrieve', 'failure', { draftId: request.params.draftId, productId: request.params.productId, error: error instanceof Error ? error.message : 'Source data could not be retrieved.' });
      return next(error);
    }
  });

  router.post('/api/drafts/:draftId/products/:productId/refresh', async (request, response, next) => {
    try {
      const product = store.getDraft(request.params.draftId).products.find((entry) => entry.id === request.params.productId);
      if (!product) return response.status(404).json({ error: 'Product not found.' });
      if (!product.selected) return response.status(400).json({ error: 'Check this product before refreshing source data.' });
      if (!product.sourceUrl) return response.status(400).json({ error: 'This product has no source URL.' });
      const result = await fetchProductDetails(product.sourceUrl);
      store.saveCachedEnrichment(product.sourceUrl, result);
      store.saveEnrichment(request.params.draftId, product.id, result);
      logger.write('product.refresh', 'success', { draftId: request.params.draftId, productId: product.id });
      return response.json(store.getDraft(request.params.draftId).products.find((entry) => entry.id === product.id));
    } catch (error) {
      logger.write('product.refresh', 'failure', { draftId: request.params.draftId, productId: request.params.productId, error: error instanceof Error ? error.message : 'Source data could not be refreshed.' });
      return next(error);
    }
  });

  return router;
};
