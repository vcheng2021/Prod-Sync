import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { DraftStore } from './drafts/draftStore.js';
import { createImportRouter } from './routes/imports.js';
import { createPublishingRouter } from './routes/publishing.js';

const app = express();
const store = new DraftStore(config.databasePath);

app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_request, response) => response.json({ ok: true, store: config.storeDomain }));
app.use(createImportRouter(store));
app.use(createPublishingRouter(store));
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
  response.status(500).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`eComInt server listening on http://localhost:${config.port}`);
});
