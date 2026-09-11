import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { DraftStore } from '../drafts/draftStore.js';
import { downloadProductImage } from '../enrichment/imageDownloader.js';
import { fetchProductDetails } from '../enrichment/sourcePageFetcher.js';
import { transformToStandard } from '../imports/transformWorkbook.js';
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
      // VIC-18: Allow client-supplied supplier override to control column mapping during transformation
      const supplierOverride = request.body.supplier as string | undefined;
      const { headers, rows, supplier: detectedSupplier } = transformToStandard(request.file.buffer, supplierOverride);
      const supplier = supplierOverride ?? detectedSupplier;
      // Convert standard-format rows back to an xlsx buffer for xlsxParser
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map((r) => r.values)]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      const transformedBuffer = Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
      const parsed = parseWorkbook(transformedBuffer, draftId, supplier);
      if (parsed.invalidRowCount > 0) {
        logger.writeImportEvent('import.validation_errors', { filename: request.file.originalname, draftId, invalidRowCount: parsed.invalidRowCount, importErrors: parsed.importErrors });
      }
      if (parsed.products.length > config.maxImportRows) {
        logger.writeImportEvent('import.too_many_rows', { filename: request.file.originalname, draftId, productCount: parsed.products.length, maxRows: config.maxImportRows });
        return response.status(400).json({ error: `The workbook contains more than ${config.maxImportRows} product rows.` });
      }
      const result = store.mergeWorkbook(request.file.originalname, request.userId!, parsed.products);
      const importSummary = { ...result.summary, invalid: parsed.invalidRowCount, duplicateRowsSkipped: parsed.duplicateRowsSkipped };
      logger.write('workbook.merge', 'success', { filename: request.file.originalname, ...importSummary, importErrors: parsed.importErrors.length });
      return response.status(200).json({ ...result.draft, sheetName: parsed.sheetName, headers: parsed.headers, importErrors: parsed.importErrors, importSummary });
    } catch (error) {
      logger.writeImportEvent('import.failure', { filename: request.file?.originalname, draftId: crypto.randomUUID(), error: error instanceof Error ? error.message : 'Import failed.' });
      return next(error);
    }
  });

  router.get('/api/drafts/current', (request, response, next) => {
    try {
      const supplier = typeof request.query.supplier === 'string' ? request.query.supplier : undefined;
      if (supplier) {
        return response.json(store.getCurrentDraftBySupplier(request.userId!, supplier));
      }
      return response.json(store.getCurrentDraft(request.userId!));
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

  router.get('/api/productsload', (request, response, next) => {
    try {
      const draftId = typeof request.query.draftId === 'string' ? request.query.draftId : undefined;
      const entries = logger.readProductsLoad(draftId ? undefined : 100);
      const filtered = draftId ? entries.filter((entry) => entry.draftId === draftId) : entries;
      return response.json(filtered.slice(0, 100));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/api/drafts/:draftId', (request, response, next) => {
    try {
      return response.json(store.getDraft(request.params.draftId, request.userId!));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/api/drafts/:draftId/products/:productId', (request, response, next) => {
    try {
      return response.json(store.updateProduct(request.params.draftId, request.userId!, request.params.productId, request.body));
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
      const products = store.updateProducts(request.params.draftId, request.userId!, updates as Array<{ id: string; changes: Partial<ProductDraft> }>);
      logger.write('product.save', 'success', { draftId: request.params.draftId, productCount: products.length, fieldCount: updates.reduce((total, entry) => total + Object.keys(entry.changes).length, 0) });
      return response.json({ products, draft: store.getDraft(request.params.draftId, request.userId!) });
    } catch (error) {
      logger.write('product.save', 'failure', { draftId: request.params.draftId, error: error instanceof Error ? error.message : 'Could not save product changes.' });
      return next(error);
    }
  });

  router.post('/api/database/purge', (request, response, next) => {
    try {
      if (request.body?.confirmation !== 'PURGE') return response.status(400).json({ error: 'Type PURGE to confirm database deletion.' });
      const result = store.purgeCatalog(request.userId!);
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
      const product = store.getDraft(request.params.draftId, request.userId!).products.find((entry) => entry.id === request.params.productId);
      if (!product) return response.status(404).json({ error: 'Product not found.' });
      if (!product.selected) return response.status(400).json({ error: 'Check this product before retrieving source data.' });
      // VIC-20 Issue 7: Source page retrieval (enrichment) is separated from image
      // download. Images are only fetched via the dedicated /images endpoint.
      if (product.sourceUrl) {
        const cached = store.getCachedEnrichment(request.userId!, product.sourceUrl);
        const result = cached ?? await fetchProductDetails(product.sourceUrl, product.supplier);
        if (!cached) store.saveCachedEnrichment(request.userId!, product.sourceUrl, result as { details: typeof result.details; status: typeof result.status; error: string; partialDetails?: Partial<typeof result.details>; failedFields: string[] });
        const enrichmentPartial = !!(result as { partialDetails?: unknown }).partialDetails;
        const failedFields = (result as { failedFields?: string[] }).failedFields ?? [];
        store.saveEnrichment(request.params.draftId, request.userId!, product.id, {
          status: result.status,
          details: result.details,
          error: result.error,
          enrichmentPartial,
          failedFields,
        });
        if (enrichmentPartial || failedFields.length > 0) {
          logger.writeProductsLoad({
            timestamp: new Date().toISOString(),
            productId: product.id,
            supplierProductKey: product.supplierProductKey,
            title: product.title,
            sourceUrl: product.sourceUrl,
            fieldsLoaded: enrichmentPartial ? [] : [],
            fieldsFailed: failedFields,
            error: result.error,
            draftId: request.params.draftId,
          });
        }
      }
      logger.write('product.retrieve', 'success', { draftId: request.params.draftId, productId: product.id });
      return response.json(store.getDraft(request.params.draftId, request.userId!).products.find((entry) => entry.id === product.id));
    } catch (error) {
      logger.write('product.retrieve', 'failure', { draftId: request.params.draftId, productId: request.params.productId, error: error instanceof Error ? error.message : 'Source data could not be retrieved.' });
      return next(error);
    }
  });

  // VIC-20 Issue 7: Dedicated endpoint for downloading a product image, separate
  // from source page retrieval. Images are only downloaded here — never during
  // import or checkbox toggles — giving the user explicit control.
  router.post('/api/drafts/:draftId/products/:productId/images', async (request, response, next) => {
    try {
      const product = store.getDraft(request.params.draftId, request.userId!).products.find((entry) => entry.id === request.params.productId);
      if (!product) return response.status(404).json({ error: 'Product not found.' });
      if (!product.imageUrl) return response.status(400).json({ error: 'This product has no image URL.' });
      const result = await downloadProductImage(product.imageUrl, product.id);
      store.saveImageResult(request.params.draftId, request.userId!, product.id, result);
      logger.write('product.image', result.status === 'valid' ? 'success' : 'failure', { draftId: request.params.draftId, productId: product.id, status: result.status, error: result.error });
      return response.json(store.getDraft(request.params.draftId, request.userId!).products.find((entry) => entry.id === product.id));
    } catch (error) {
      logger.write('product.image', 'failure', { draftId: request.params.draftId, productId: request.params.productId, error: error instanceof Error ? error.message : 'Image could not be downloaded.' });
      return next(error);
    }
  });

  // VIC-24: Batch image download endpoint — downloads images for multiple
  // products in parallel (up to config.imageDownloadConcurrency at a time).
  // Applies to all specified products regardless of selection state.
  router.post('/api/drafts/:draftId/products/images/batch', async (request, response, next) => {
    try {
      const { productIds } = request.body as { productIds: string[] }
      if (!Array.isArray(productIds)) return response.status(400).json({ error: 'productIds array is required.' })

      const draft = store.getDraft(request.params.draftId, request.userId!)
      const productMap = new Map(draft.products.map((p) => [p.id, p]))

      // Filter to products that actually need download
      const needsDownload = productIds.filter(
        (id) => {
          const p = productMap.get(id)
          return p && p.imageUrl && p.imageStatus !== 'valid' && !p.imageLocalUrl
        },
      )

      if (needsDownload.length === 0) return response.json({ products: draft.products })

      logger.write('product.images.batch', 'info', { draftId: request.params.draftId, requested: productIds.length, toDownload: needsDownload.length })

      // Process downloads with configurable concurrency
      const concurrency = Math.max(1, config.imageDownloadConcurrency)
      for (let i = 0; i < needsDownload.length; i += concurrency) {
        const batch = needsDownload.slice(i, i + concurrency)
        await Promise.all(
          batch.map(async (id) => {
            try {
              const product = productMap.get(id)!
              const result = await downloadProductImage(product.imageUrl!, product.id)
              store.saveImageResult(request.params.draftId, request.userId!, product.id, result)
              logger.write('product.image', result.status === 'valid' ? 'success' : 'failure', { draftId: request.params.draftId, productId: product.id, status: result.status, error: result.error })
            } catch (error) {
              logger.write('product.image', 'failure', { draftId: request.params.draftId, productId: id, error: error instanceof Error ? error.message : String(error) })
            }
          }),
        )
      }

      // Re-fetch the updated draft
      const updated = store.getDraft(request.params.draftId, request.userId!)
      return response.json(updated.products)
    } catch (error) {
      logger.write('product.images.batch', 'failure', { draftId: request.params.draftId, error: error instanceof Error ? error.message : 'Batch image download failed.' })
      return next(error)
    }
  });

  router.post('/api/drafts/:draftId/products/:productId/refresh', async (request, response, next) => {
    try {
      const product = store.getDraft(request.params.draftId, request.userId!).products.find((entry) => entry.id === request.params.productId);
      if (!product) return response.status(404).json({ error: 'Product not found.' });
      if (!product.selected) return response.status(400).json({ error: 'Check this product before refreshing source data.' });
      if (!product.sourceUrl) return response.status(400).json({ error: 'This product has no source URL.' });
      const result = await fetchProductDetails(product.sourceUrl, product.supplier);
      store.saveCachedEnrichment(request.userId!, product.sourceUrl, result);
      store.saveEnrichment(request.params.draftId, request.userId!, product.id, result);
      logger.write('product.refresh', 'success', { draftId: request.params.draftId, productId: product.id });
      return response.json(store.getDraft(request.params.draftId, request.userId!).products.find((entry) => entry.id === product.id));
    } catch (error) {
      logger.write('product.refresh', 'failure', { draftId: request.params.draftId, productId: request.params.productId, error: error instanceof Error ? error.message : 'Source data could not be refreshed.' });
      return next(error);
    }
  });

  return router;
};
