# eComInt client

The client is a React 19 single-page workspace bundled with Vite. The root project starts it with `npm run dev:client`; direct client commands use the `client` directory.

## Responsibilities

- `src/App.tsx` owns catalog selection, filtering, staged edits, source retrieval, publishing review, issue-log display, and Reset page state.
- `src/api.ts` defines the browser-to-server JSON contracts. It contains no credentials or Shopify configuration.
- `src/App.css` and `src/workspace.css` contain the application styling.

Ordinary field edits update the local React draft and are collected by product ID in a dirty-field map. **Save changes** sends only changed allowlisted fields to `PATCH /api/drafts/:draftId/products`. Publishing sends the same staged changes with the selected product IDs so the server persists them before calling Shopify. The local suggested sale price maps to the Shopify variant retail `price`; local unit price maps to the Shopify inventory-item `cost` (“Cost per item”). Retrieval responses are merged with pending edits so source enrichment cannot overwrite a manual change that has not been saved yet.

The **Posting issues** metric calls `GET /api/issues?draftId=...` and renders structured failure records from the server log. The **Reset page** action clears the client draft and transient UI state without calling the destructive database purge endpoint.

## Development

```powershell
npm install
npm run dev:client
```

Vite proxies `/api` and `/productimage` requests to `http://localhost:8787`. Run the root server separately with `npm run dev:server`, or start both processes with `./start.ps1`. Validate the client with:

```powershell
npm run typecheck
npm run build
npm run lint
```

The client must never receive `SHOPIFY_ADMIN_ACCESS_TOKEN`; Shopify calls are made by the server.
