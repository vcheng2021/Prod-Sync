# Plan: Multi-Supplier, Multi-Tenant, Multi-Platform eComInt

## Context

The eComInt app is currently single-user, single-supplier, single-platform (Shopify) with no authentication. The user needs:

1. **Login workflow** — simple username/password auth
2. **Multi-supplier** — cellar (Paramount) and vican (AliExpress), all users see same suppliers
3. **8 image fields** in the standard import format (up to 8 images per product)
4. **Source tracking** — a field identifying where product info came from (aliexpress, ebay, etc.), managed in SQLite
5. **Multi-platform** — Shopify (existing) + WooCommerce (new), user-selectable after login
6. **All credentials configurable in .env** — including WooCommerce parameters

## Current Architecture (Reference)

- **No users, no auth, no sessions**
- Single global `drafts` table, single `app_state` marker
- `xlsxParser.ts` uses hardcoded column indices: 0(image), 1(key), 4(title), 5(source URL), 6(SOH), 8(case), 9(unit), 10(type)
- `ProductDraft.imageUrl: string` — single image
- Single Shopify client in `shopify/adminGraphqlClient.ts`
- `config.ts` has `defaultWorkbookPath` hardcoded to `suppliers/sup2_paramountliquor.xlsx`

## New Standard Import Format (11+ Columns)

All supplier files map to this standard before parsing:

| Standard Col | Header | Content |
|-------------|--------|---------|
| A | `image-1` | Primary image URL |
| B | `image-2` | Image 2 |
| C | `image-3` | Image 3 |
| D | `image-4` | Image 4 |
| E | `image-5` | Image 5 |
| F | `image-6` | Image 6 |
| G | `image-7` | Image 7 |
| H | `image-8` | Image 8 |
| I | `source` | Source platform (aliexpress, ebay, paramount, etc.) |
| J | `body-xxs` | Supplier product key |
| K | `body-xs` | Product title |
| L | `body-xs href` | Source URL |
| M | `heading-xs` | Stock on hand |
| N | `heading-xs 2` | Case price |
| O | `heading-xs 3` | Unit price |
| P | `Type` | Supplier type / category |

**Parser indices change:** images at 0-7, source at 8, key at 9, title at 10, sourceUrl at 11, SOH at 12, casePrice at 14, unitPrice at 15, supplierType at 16.

**ProductDraft changes:**
- `imageUrl: string` → `imageUrls: string[]` (up to 8)
- `sourcePlatform: string` — new field (e.g., "aliexpress", "ebay")
- `imageLocalFilename`, `imageLocalUrl`, `imageStatus` apply to primary image (index 0)
- Additional image statuses stored in `raw` JSON

**Cellar mapping:** Single image → col A, cols B-H empty, `source` = "paramount", then existing fields shifted right by 8 positions.

**AliExpress mapping:** Up to 6 images → cols A-F, `source` = "aliexpress", key derived from URL item ID, title from native col I/J, fragmented price → unit price, source URL = product URL.

## Database Schema

### New Tables

```sql
-- Users table
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- User sessions
CREATE TABLE user_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Source definitions (shared across all users)
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,       -- e.g., "aliexpress", "ebay", "paramount"
  display_name TEXT NOT NULL,       -- e.g., "AliExpress", "eBay", "Cellar"
  platform TEXT NOT NULL,           -- e.g., "aliexpress", "woocommerce"
  column_mapping TEXT NOT NULL,     -- JSON: maps native columns to standard
  active INTEGER NOT NULL DEFAULT 1
);

-- Platform configurations (per user)
CREATE TABLE platform_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,           -- 'shopify' or 'woocommerce'
  config_json TEXT NOT NULL,        -- JSON credentials
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### Modified Tables

```sql
ALTER TABLE drafts ADD COLUMN user_id TEXT;
ALTER TABLE drafts ADD COLUMN platform TEXT DEFAULT 'shopify';
ALTER TABLE products ADD COLUMN user_id TEXT;
ALTER TABLE products ADD COLUMN source_platform TEXT;  -- new
ALTER TABLE products ADD COLUMN image_urls TEXT;        -- JSON array of up to 8 images
ALTER TABLE source_cache ADD COLUMN user_id TEXT;
ALTER TABLE publish_events ADD COLUMN user_id TEXT;
ALTER TABLE app_state ADD COLUMN user_id TEXT;          -- per-user scoping
```

## .env Configuration

```env
# === Auth ===
AUTH_SECRET= (random string for session signing)
SESSION_TIMEOUT_MS=1800000

# === Shopify (existing) ===
SHOPIFY_STORE_DOMAIN=cb1710-2.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_...
SHOPIFY_API_VERSION=2026-07
SHOPIFY_LOCATION_ID=gid://shopify/Location/69140283444
SHOPIFY_FEATURED_COLLECTION_ID=gid://shopify/Collection/320107118644
SHOPIFY_COLLECTION_ID="Spirits:314155073588,Red Wine:285318578228,..."

# === WooCommerce (new) ===
WOOCOMMERCE_STORE_URL=https://your-store.com
WOOCOMMERCE_CONSUMER_KEY=ck_...
WOOCOMMERCE_CONSUMER_SECRET=cs_...
WOOCOMMERCE_API_VERSION=wc/v3
WOOCOMMERCE_EMAIL=admin@store.com

# === General ===
APP_VERSION=0.1.0
PORT=8787
DATABASE_PATH=./data/ecomint.db
PRODUCT_IMAGE_DIRECTORY=./productimage
LOG_DIRECTORY=./logs
MAX_IMPORT_ROWS=10000
SOURCE_URL_ALLOWLIST=
```

### WooCommerce Config JSON Structure (stored in `platform_configs.config_json`)

```json
{
  "storeUrl": "https://your-store.com",
  "consumerKey": "ck_...",
  "consumerSecret": "cs_...",
  "apiVersion": "wc/v3",
  "email": "admin@store.com",
  "stockManagement": true,
  "publishToStore": true
}
```

## Authentication Flow

```
Client → POST /api/auth/register { username, password }
  → Server: bcrypt.hash(password), insert users table

Client → POST /api/auth/login { username, password }
  → Server: verify password, create user_sessions row, return HTTP-only cookie token

Client → GET /api/auth/me (with cookie)
  → Server: validate token, return user + active platform + available sources

Client → POST /api/auth/select-platform { platform }
  → Server: update platform_configs is_active for user

Client → POST /api/auth/logout
  → Server: delete user_sessions row
```

**Auth middleware** validates token on every request (except `/api/auth/*`), sets `request.userId`.

## Architecture Layers

### New Files
| File | Purpose |
|------|---------|
| `server/src/auth/authService.ts` | bcrypt password hashing, session creation/validation |
| `server/src/auth/authMiddleware.ts` | Express middleware, validates session cookie, sets `request.userId` |
| `server/src/auth/authRouter.ts` | register, login, logout, me, select-platform endpoints |
| `server/src/imports/standardFormat.ts` | Standard column definitions (11 columns: 8 images + source + existing fields) |
| `server/src/imports/supplierConfig.ts` | Supplier configs (cellar, vican) with transformation functions |
| `server/src/imports/transformWorkbook.ts` | Transformation layer: native format → standard format |
| `server/src/platforms/platformClient.ts` | PlatformClient interface definition |
| `server/src/platforms/shopify/client.ts` | Shopify implementation of PlatformClient |
| `server/src/platforms/woocommerce/client.ts` | WooCommerce REST API client implementation |
| `server/src/platforms/publisher.ts` | Platform-agnostic publisher, routes to correct client |

### Modified Files
| File | Change |
|------|--------|
| `server/src/config.ts` | Add auth, WooCommerce, platform config keys; `defaultWorkbookPath` becomes dynamic |
| `server/src/types.ts` | `imageUrl` → `imageUrls: string[]`, add `sourcePlatform`, `sourcePlatform` |
| `server/src/drafts/draftStore.ts` | All queries scoped by `user_id`, new columns, JSON image_urls, source_platform |
| `server/src/index.ts` | Auth middleware, user-scoped initialization, platform router |
| `server/src/imports/xlsxParser.ts` | Parse new standard layout (8 images at 0-7, source at 8, key at 9, etc.) |
| `server/src/imports/imports.ts` | Apply transformation before parsing; scope by `request.userId` |
| `server/src/routes/imports.ts` | Pass user context to all operations |
| `server/src/routes/publishing.ts` | Route to correct platform client based on draft's platform |
| `server/src/shopify/productPublisher.ts` | Wrap with PlatformClient interface |
| `client/src/App.tsx` | Login page, supplier selector, platform selector, user context |
| `client/src/api.ts` | Add auth endpoints, cookie handling, platform selection |

## Multi-Supplier Transformation

### Cellar (Paramount Liquor)
- Native: A(image), B(key), E(title), F(source), G(SOH), I(case), J(unit), K(type)
- Transform: Map to standard A-H images (just col A), I(source)="paramount", J(key)=B, K(title)=E, L(source)=F, M(SOH)=G, N(case)=I, O(unit)=J, P(type)=K
- Fill image-2 through image-8 empty

### Vican (AliExpress)
- Native: A(product URL), B-F(images, varies by file), I/J(title), K/L/M(fragmented price)
- Transform: A-F → image-1 through image-6, I(source)="aliexpress", J(key)=extract item ID from URL, K(title)=I/J, L(source)=product URL, M(SOH)=null, N(case)=null, O(unit)=reconstruct from K/L/M, P(type)="AliExpress"
- Fill remaining images empty

## Multi-Platform Publishing

### PlatformClient Interface
```ts
interface PlatformClient {
  queryProducts(title: string): Promise<ProductMatch[]>;
  createProduct(product: ProductData): Promise<PublishResult>;
  updateProduct(product: ProductData): Promise<PublishResult>;
  updateInventory(productId: string, quantity: number): Promise<void>;
  publishToChannel(productId: string, channel: string): Promise<void>;
}
```

### Shopify Client
- Wraps existing `adminGraphqlClient.ts` and `productPublisher.ts`
- Uses GraphQL, `userErrors` checking, `@idempotent` keys

### WooCommerce Client
- REST API, Consumer Key + Secret OAuth 1.0a
- Endpoints: `/wp-json/wc/v3/products`, `/wp-json/wc/v3/products/{id}/reviews`
- Image upload via `/wp-json/media/v1/media`
- Inventory via `/wp-json/wc/v3/products/{id}/stock`
- Returns JSON errors, not `userErrors`

### Publisher
- Gets draft's `platform` field
- Routes to `shopifyClient` or `woocommerceClient`
- Common publish logic (title matching, validation) stays in publisher

## Security

- **Passwords**: bcrypt hashing, never plaintext
- **Sessions**: HTTP-only, Secure, SameSite=Strict cookies with cryptographically random tokens
- **Platform credentials**: Stored server-side only in `platform_configs`, never sent to browser or logged
- **Data isolation**: Every query scoped by `user_id` — no cross-user access
- **Source management**: Sources are shared/app-level, not user-specific
- **Logger**: Existing redaction covers `token|secret|password|authorization|credential|cookie`
- **WooCommerce secrets**: Never logged, stored as `config_json` (encrypted at rest recommended)
- **Input validation**: Username/password validation, parameterized SQL queries
- **Auth middleware**: All endpoints except `/api/auth/*` require valid session

## Image Handling with 8 Fields

- `ProductDraft.imageUrls: string[]` replaces `imageUrl: string`
- DB stores as JSON array: `["url1", "url2", ...]`
- `imageLocalFilename`, `imageLocalUrl`, `imageStatus` apply to primary (index 0)
- Download pipeline: processes primary image on `Retrieve source data`; additional images optionally downloaded
- Client displays all images in a gallery
- Shopify/WooCommerce publish: primary image becomes product image; additional images added as product media

## Source Management in SQLite

- `sources` table: id, name, display_name, platform, column_mapping, active
- Seed the `sources` table with known sources (aliexpress, ebay, paramount, etc.)
- Products store `source_platform` (references a source)
- `GET /api/auth/me` returns available sources
- Source determines the transformation mapping applied during import

## Implementation Phases

### Phase 1: Authentication & User Model
- Create `users`, `user_sessions` tables
- Implement bcrypt password hashing
- Login/register/logout/me endpoints
- Auth middleware
- Client login UI

### Phase 2: Standard Format & Multi-Supplier
- Redefine standard format (8 images + source + existing fields)
- Update `ProductDraft` type (`imageUrls: string[]`, `sourcePlatform`)
- Update `xlsxParser.ts` indices
- Create supplier configs and transformation layer
- Update `imports.ts` to apply transformation before parsing
- Update `draftStore.ts` schema and queries

### Phase 3: Source & Platform Configuration
- Create `sources` table, seed with known sources
- Create `platform_configs` table
- Set up WooCommerce config structure in .env
- Build PlatformClient interface + Shopify + WooCommerce implementations
- Platform selection flow after login
- Update publisher to route to correct platform

### Phase 4: Database Migration & Security Hardening
- Schema migrations for new tables and columns
- `user_id` scoping on all queries
- Session cleanup job
- Cookie security headers
- Verify all credential redaction

## Verification

1. **Auth**: Register → Login → Session cookie → Protected routes → Logout → Session invalidated
2. **Multi-supplier**: Switch cellar/vican → correct transformation → 8 image fields populated → source field set
3. **Multi-tenant**: Two users → data isolated → no cross-access → same sources available to both
4. **Platform**: Select Shopify → publish works; select WooCommerce → publish routes correctly
5. **Security**: bcrypt hashing, HTTP-only cookies, credentials never logged, all queries user-scoped
6. **WooCommerce config**: `.env` keys present, JSON structure valid, client initialized
7. **Backward compatibility**: Existing `sup2_paramountliquor.xlsx` still seeds for first user
8. **TypeScript**: `npm run typecheck` passes
9. **Build**: `npm run build` succeeds
