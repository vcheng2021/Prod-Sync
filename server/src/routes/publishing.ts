import { Router } from 'express';
import type { DraftStore } from '../drafts/draftStore.js';
import { createDraftWorkbook } from '../exports/excelExporter.js';
import { AppLogger } from '../logging/logger.js';
import { publishProduct } from '../shopify/productPublisher.js';

export const createPublishingRouter = (store: DraftStore, logger: AppLogger): Router => {
  const router = Router();

  router.get('/api/drafts/:draftId/export', (request, response, next) => {
    try {
      const draft = store.getDraft(request.params.draftId);
      const workbook = createDraftWorkbook(draft);
      const filename = `ecomint-${draft.draft.id}.xlsx`;
      response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return response.send(workbook);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/api/drafts/:draftId/publish', async (request, response, next) => {
    try {
      if (request.body?.confirmed !== true) return response.status(400).json({ error: 'Confirm the selected products before publishing.' });
      const draft = store.getDraft(request.params.draftId);
      const requestedIds = Array.isArray(request.body.productIds) ? new Set(request.body.productIds as string[]) : null;
      const products = draft.products.filter((product) => product.selected && (!requestedIds || requestedIds.has(product.id)));
      if (!products.length) return response.status(400).json({ error: 'Select at least one product to publish.' });

      const results = [];
      for (const product of products) {
        store.savePublishResult(request.params.draftId, product.id, 'publishing', null, '');
        const result = await publishProduct(product);
        store.savePublishResult(request.params.draftId, product.id, result.status, result.shopifyProductId, result.error);
        logger.write('product.publish', result.status === 'published' ? 'success' : 'failure', { draftId: request.params.draftId, productId: product.id, status: result.status, action: result.action, matchCount: result.matchCount, error: result.error });
        results.push({ productId: product.id, ...result });
      }
      return response.json({ results, draft: store.getDraft(request.params.draftId) });
    } catch (error) {
      logger.write('product.publish', 'failure', { draftId: request.params.draftId, error: error instanceof Error ? error.message : 'Products could not be posted.' });
      return next(error);
    }
  });

  return router;
};
