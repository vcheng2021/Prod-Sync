# eComInt Change History

## 2026-08-28

### Product editing and publishing

- Fixed the publish path so staged browser edits are included in `POST /api/drafts/:draftId/publish` and persisted through `DraftStore.updateProducts` before the server reads products for Shopify.
- Covered all supported editable fields, including title, unit price, case price, supplier stock, suggested sale price, Shopify inventory, description, and About fields.
- Preserved pending browser edits when a source retrieval response is merged into the client draft.
- Kept manually edited suggested sale prices as overrides during later workbook merges while still recalculating prices that remain automatic.
- Mapped the local supplier unit price to Shopify's inventory-item `cost` field through `inventoryItemUpdate`, which appears in Shopify as Cost per item. The suggested sale price remains the variant retail `price`; Shopify's calculated variant `unitPrice` is not overwritten.

### Shopify inventory

- Added unique `@idempotent(key: ...)` directives and UUID keys to `inventoryActivate` and `inventorySetQuantities` for Admin API version `2026-07`.
- Preserved Shopify GraphQL transport error codes and mutation field paths in publish errors where Shopify supplies them.
- Documented the required `write_inventory` scope and the installing user's permission to activate inventory at the configured location. Scope changes require app reauthorization or reinstall.

### Issues and reset behavior

- Added `GET /api/issues?draftId=<id>`, which reads reverse-chronological failure records from `logs/ecomint.log` and returns up to 100 entries for the requested draft.
- Added a clickable Posting issues metric that displays event names, timestamps, product IDs, Shopify errors, field paths, and structured log details.
- Added the Reset page action. It clears the visible client draft, filters, selections, messages, issue state, modal state, and unsaved browser edits without deleting SQLite, logs, or images.
- Kept Purge database as the explicit destructive action for clearing persisted catalog state.

### Verification

- `npm run typecheck` passes.
- `npm run build` passes for the Vite client and TypeScript server.
- The live `/api/issues` endpoint returns structured failure records without exposing credentials.
