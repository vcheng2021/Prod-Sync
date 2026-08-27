import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { DraftStore } from '../drafts/draftStore.js';
import { downloadProductImage } from '../enrichment/imageDownloader.js';
import { fetchProductDetails } from '../enrichment/sourcePageFetcher.js';
import { parseWorkbook } from '../imports/xlsxParser.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

export const createImportRouter = (store: DraftStore): Router => {
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
      const draft = store.createDraft(request.file.originalname, parsed.products);
      return response.status(201).json({ ...draft, sheetName: parsed.sheetName, headers: parsed.headers, importErrors: parsed.importErrors });
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
      return response.json(store.getDraft(request.params.draftId).products.find((entry) => entry.id === product.id));
    } catch (error) {
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
      return response.json(store.getDraft(request.params.draftId).products.find((entry) => entry.id === product.id));
    } catch (error) {
      return next(error);
    }
  });

  return router;
};
