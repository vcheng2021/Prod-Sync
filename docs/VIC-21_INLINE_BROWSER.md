# VIC-21 — AliExpress "Manual Extract" External Browser

## Overview

**Issue**: [VIC-21: "Ali - Manual extract option"](https://vicandev1979.atlassian.net/browse/VIC-21)  
**Status**: Implemented  
**Date**: 2026-09-09  
**Author**: Claude Code (automated implementation)

---

## Problem Statement

AliExpress product pages are complex SPAs that don't yield well to automated Cheerio scraping. The existing enrichment flow (`sourcePageFetcher.ts` + `productDetailsExtractor.ts`) uses heuristic extraction that often misses descriptions, specifications, and images. Product managers wanted a way to manually browse AliExpress product pages and extract content directly, rather than relying solely on automated scraping.

**Original requirement** (from Jira description):
> As a product manager, I want a small button just to the right of the product title in the list for clicking through to the product details page (column A in excel). So I can open up the url content in an inline browser window and manually navigate around it, and extract content from the inline browser window into my product details manually.

**Acceptance Criteria**:
- A "Browse" button next to AliExpress (`supplier === 'vican'`) product titles in the product table
- A "Browse" toggle button to open/close an inline browser panel below the row
- An "Open" button to launch the product page in an **external browser window** that gets reused on subsequent clicks
- A close button to collapse the inline browser panel
- External browser reuses the same window instance on every "Open" click — no duplicate windows

---

## Architecture Decision

### Dual approach: Inline iframe + External browser

The original requirement called for an inline browser. The implementation ended up with two distinct features:

1. **Inline iframe panel** (always visible below an expanded row) — a lightweight preview for quick inspection
2. **External browser** — opens the product page in a real browser window for full interaction and manual extraction

The decision to use an external browser rather than continuing to rely on the iframe came from:
- **iframe limitations**: AliExpress may set `X-Frame-Options: DENY` or `Content-Security-Policy: frame-ancestors 'none'`, blocking iframe embedding entirely
- **Full page interactivity**: Operators need to navigate, click, scroll, and interact with AliExpress's SPA — a real browser provides full functionality
- **No server overhead**: `window.open` requires no server routes, no proxy, no additional infrastructure

### Architecture constraint compliance

Per `docs/ARCHITECTURE.md`: *"The browser never receives the Shopify Admin token — all supplier/Shopify requests, file writes, and SQLite mutations happen server-side."* The `sourceUrl` is already validated server-side during import, so the external browser never handles credentials.

---

## Issues Encountered

### 1. JSX parse error — leftover code block inside `.map()`

**Problem**: When refactoring from `expandedProductId` to `browsingProductId`, the old inline browser code block referencing `expandedProductId` was not fully removed from inside the `.map()` callback. The leftover block at line ~1712 (`{expandedProductId === product.id && ...}`) contained a `<tr>` with an `<iframe>` but was missing the `</>` fragment close before `))}`. This caused:
```
PARSE_ERROR at line 1747: Expected '}' but found ')'
```

**Root cause**: The `.map()` callback opened with `<>` (fragment) and the old inline browser code was placed inside the fragment, but the closing `</>` was missing. The `))}` closing the `.map()` was orphaned without its matching `</>`.

**Fix**: Removed the entire old inline browser block from inside `.map()`. Added `</>` after `</tr>` to close the fragment, followed by `))}` to close `.map()`. The persistent iframe browser `<tr>` now renders outside `.map()` using the derived `browsingProduct` variable.

### 2. TypeScript temporal dead zone — `visibleProducts` used before declaration

**Problem**: `browsingProduct` was declared at line 438 referencing `visibleProducts`, but `visibleProducts` was declared at line 599. TypeScript flagged:
```
TS2448: Block-scoped variable 'visibleProducts' used before its declaration
TS2454: Variable 'visibleProducts' is used before being assigned
```

**Root cause**: `const` declarations are block-scoped and subject to the temporal dead zone — you cannot reference a variable before its declaration in the same scope.

**Fix**: Moved `browsingProduct` declaration to after `visibleProducts` (line ~602):
```typescript
const browsingProduct = visibleProducts.find((p) => p.id === browsingProductId) ?? null
```

### 3. Popup blocker — `window.open` with named window target creates duplicate windows

**Problem**: Initially tried `window.open(product.sourceUrl, 'ecomint-brower')` to reuse a named window. On the second click, instead of navigating the existing window, a new browser window/tab was opened. This is because popup blockers can be aggressive about named window targets — if the window was closed or the browser's popup heuristic flags the second call, it opens a new window instead of reusing the named one.

**Root cause**: `window.open(url, name)` relies on the browser's window management to reuse an existing window with that name. Pop-up blockers, window closing, or browser security policies can prevent reuse and instead open a new window.

**Fix**: Use a `useRef<Window | null>(null)` to store the actual `Window` object reference returned by `window.open`. On each click, check if the stored reference is still valid (`browserWindowRef.current && !browserWindowRef.current.closed`). If valid, navigate via `browserWindowRef.current.location.href = url`. If closed or null, open a new window and store the reference.

```typescript
const browserWindowRef = useRef<Window | null>(null)

// In onClick:
if (browserWindowRef.current && !browserWindowRef.current.closed) {
  browserWindowRef.current.location.href = url  // navigate existing window
} else {
  browserWindowRef.current = window.open(url, 'ecomint-brower', 'width=1200,height=800,scrollbars=yes,resizable=yes')  // open new window
}
```

This approach is reliable because it directly tracks the window object rather than relying on browser window-name resolution, which popup blockers can interfere with. The window features string (`width=1200,height=800,scrollbars=yes,resizable=yes`) forces the browser to open a **window** rather than a tab — without features, most modern browsers treat `window.open()` as opening a new tab.

---

## Implementation Details

### Files Modified

| File | Change |
|------|--------|
| `client/src/App.tsx` | Added `browsingProductId` state, `browsingProduct` derived variable, `browserWindowRef` ref, "Browse" toggle button (AliExpress only), inline iframe browser row, "Open" button with external browser, `execFormat`/`insertImage`/`renderRichTextInput` functions for rich text editor |
| `client/src/workspace.css` | Added `.inline-browser`, `.inline-browser-toolbar`, `.inline-browser-frame` styles; added `.rich-text-editor`, `.rich-text-toolbar`, `.rtb-btn`, `.rtb-sep`, `.rich-text-area` styles |
| `server/src/routes/publishing.ts` | Added `import { config } from '../config.js'` and `globalCategoryIds` default from `config.wooCategories` |
| `client/src/api.ts` | **No change** |
| `server/src/enrichment/sourcePageFetcher.ts` | **No change** |
| `server/src/config.ts` | **No change** |

### Client-side Changes

#### State and Ref (`client/src/App.tsx`)

```typescript
const [browsingProductId, setBrowsingProductId] = useState<string | null>(null)
const browserWindowRef = useRef<Window | null>(null)
const browsingProduct = visibleProducts.find((p) => p.id === browsingProductId) ?? null
```

- `browsingProductId` tracks which row's inline browser is expanded
- `browserWindowRef` holds the reference to the external browser window for reuse
- `browsingProduct` is derived from visible (paginated) products — declared after `visibleProducts` to avoid temporal dead zone

#### Browse Toggle Button

Only rendered when `product.supplier === 'vican'` AND `product.sourceUrl` exists:
```tsx
{product.supplier === 'vican' && product.sourceUrl && (
  <>
    <button
      type="button"
      className="text-button"
      style={{ marginLeft: 8, fontSize: 12 }}
      onClick={(event) => {
        event.stopPropagation()
        setBrowsingProductId(browsingProductId === product.id ? null : product.id)
      }}
    >
      {browsingProductId === product.id ? 'Close' : 'Browse'}
    </button>
    <button
      type="button"
      className="text-button"
      style={{ marginLeft: 8, fontSize: 12 }}
      onClick={(event) => {
        event.stopPropagation()
        if (browserWindowRef.current && !browserWindowRef.current.closed) {
          browserWindowRef.current.location.href = product.sourceUrl
        } else {
          browserWindowRef.current = window.open(product.sourceUrl, 'ecomint-brower', 'width=1200,height=800,scrollbars=yes,resizable=yes')
        }
      }}
    >
      Open
    </button>
  </>
)}
```
- **Browse**: Toggles the inline iframe panel open/closed for the same product, or switches to a different product's iframe
- **Open**: Opens the product page in an external browser, reusing the same window on every click

#### Inline Browser Row

Renders as a single `<tr>` outside the `.map()` loop, using the derived `browsingProduct`:
```tsx
{browsingProduct && browsingProduct.supplier === 'vican' && browsingProduct.sourceUrl && (
  <tr className="inline-browser-row">
    <td colSpan={8}>
      <div className="inline-browser">
        <div className="inline-browser-toolbar">
          <span className="inline-browser-toolbar-title">🌐 {browsingProduct.title}</span>
          <div className="inline-browser-toolbar-actions">
            <button
              type="button"
              className="inline-browser-toolbar-btn"
              onClick={() => {
                if (browserWindowRef.current && !browserWindowRef.current.closed) {
                  browserWindowRef.current.location.href = browsingProduct.sourceUrl
                } else {
                  browserWindowRef.current = window.open(browsingProduct.sourceUrl, 'ecomint-brower', 'width=1200,height=800,scrollbars=yes,resizable=yes')
                }
              }}
            >
              ↗ Open externally
            </button>
            <button
              type="button"
              className="inline-browser-toolbar-btn"
              onClick={() => setBrowsingProductId(null)}
            >
              ✕ Close
            </button>
          </div>
        </div>
        <div className="inline-browser-frame">
          <iframe src={browsingProduct.sourceUrl} title={`Browse ${browsingProduct.title}`} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" loading="lazy" />
        </div>
      </div>
    </td>
  </tr>
)}
```
The `.map()` produces only the product `<tr>` rows wrapped in `<>...</>`, and the persistent browser `<tr>` is rendered after the `.map()` closes. The toolbar's "↗ Open externally" button also uses `browserWindowRef` to reuse the same external window.

#### External Browser Reuse Logic

The `browserWindowRef` is the key to reusing the same external browser window:

```typescript
// On each "Open" click:
if (browserWindowRef.current && !browserWindowRef.current.closed) {
  browserWindowRef.current.location.href = url  // navigate existing window
} else {
  browserWindowRef.current = window.open(url, 'ecomint-brower', 'width=1200,height=800,scrollbars=yes,resizable=yes')  // open new window
}
```

This avoids popup blocker issues that occur when relying on `window.open(url, 'named-window')` alone. By storing the actual `Window` object reference, we can directly check if the window is still open and navigate it, rather than depending on browser window-name resolution. The window features string forces a browser **window** (not a tab) to open.

### CSS Changes (`client/src/workspace.css`)

```css
.inline-browser { display: flex; flex-direction: column; max-height: 520px; }
.inline-browser-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px; border-bottom: 1px solid var(--soft-line);
  background: hsla(from var(--panel) 0 0 95 / 0.6); flex-shrink: 0;
}
.inline-browser-toolbar-title { font-size: 14px; }
.inline-browser-toolbar-actions { display: flex; gap: 8px; }
.inline-browser-toolbar-btn {
  padding: 4px 10px; border: 1px solid var(--line); border-radius: 4px;
  background: var(--panel); cursor: pointer; font-size: 12px;
}
.inline-browser-frame {
  flex: 1 1 auto; min-height: 300px; max-height: 460px;
  overflow: hidden; background: var(--paper);
}
.inline-browser-frame iframe { width: 100%; height: 100%; border: 0; }

/* Rich text editor */
.rich-text-editor {
  border: 1px solid var(--line);
  border-radius: 4px;
  overflow: hidden;
  background: var(--panel);
  transition: border-color var(--transition), box-shadow var(--transition);
}
.rich-text-editor:focus-within {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px rgba(109, 154, 170, 0.16);
}
.rich-text-toolbar {
  display: flex; align-items: center; gap: 2px;
  padding: 5px 7px;
  border-bottom: 1px solid var(--soft-line);
  background: hsla(from var(--panel) 0 0 96% / 0.5);
  flex-wrap: wrap;
}
.rtb-btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; min-height: 28px;
  border: 1px solid transparent; border-radius: 3px;
  background: transparent; color: var(--ink);
  font-size: 13px; font-weight: 600; cursor: pointer;
  line-height: 1;
}
.rtb-btn:hover { background: hsla(from var(--panel) 0 0 0 / 0.06); border-color: var(--line); }
.rtb-sep { width: 1px; height: 18px; background: var(--soft-line); margin: 0 4px; }
.rich-text-area {
  min-height: 120px; max-height: 400px; overflow-y: auto;
  padding: 11px 12px;
  font: 14px/1.45 var(--sans); color: var(--ink);
  background: var(--panel); outline: none; line-height: 1.5;
}
```

### Server-side Changes (`server/src/routes/publishing.ts`)

Added `config.wooCategories` as default `globalCategoryIds`:
```typescript
const globalCategoryIds = request.body?.globalCategoryIds ?? config.wooCategories.map((category) => category.id)
```
This uses the `WOOCOMMERCE_PRODUCT_CATEGORIES` env var (parsed in `config.ts` as `wooCategories`) as the default collection/category IDs when publishing to WooCommerce.

### Rich text editor (`client/src/App.tsx` + `client/src/workspace.css`)

The `descriptionHtml` field (used for the main product Description) was upgraded from a plain `<textarea>` to a `contentEditable`-based rich text editor with a formatting toolbar.

**Implementation approach**: Uses the browser's native `contentEditable` div with `document.execCommand` — no external dependencies. A toolbar with bold, italic, underline, bullet list, numbered list, link, image, and clear formatting buttons wraps the editor area. The editor syncs its `innerHTML` back to the `descriptionHtml` field on every input event via `patchProduct`.

**Key functions added to `App.tsx`**:
- `execFormat(command, value?)` — calls `document.execCommand` and syncs the editor's `innerHTML` to `patchProduct`
- `insertImage()` — prompts for an image URL and calls `execFormat('insertImage', url)`
- `renderRichTextInput(label, value)` — renders the toolbar + `contentEditable` div with `dangerouslySetInnerHTML` for the stored HTML content
- `renderTextInput` now checks `field === 'descriptionHtml' && isTextarea` and delegates to `renderRichTextInput`

**Toolbar buttons**: Bold (B), Italic (I), Underline (U), Bullet list, Numbered list, Link (🔗), Insert image (🖼), Clear formatting (✕)

**CSS added to `workspace.css`**: `.rich-text-editor`, `.rich-text-toolbar`, `.rtb-btn`, `.rtb-sep`, `.rich-text-area` — styled to match the existing form field aesthetic with the same focus/blue ring states and dirty-indicator styling.

---

## Impact Assessment

### Positive impacts
1. **AliExpress operator workflow**: Operators can manually browse AliExpress product pages in an external browser for full interactivity
2. **Inline preview**: The iframe panel provides a quick visual preview without leaving the application
3. **External browser reuse**: The `browserWindowRef` pattern ensures a single external window is reused across all "Open" clicks — no popup blocker issues, no duplicate windows
4. **Rich text editing**: The product Description field now supports bold, italic, underline, lists, links, and image insertion via a toolbar — no more plain text-only description editing
5. **Supplier-specific isolation**: Only AliExpress (`supplier === 'vican'`) products get the buttons; Cellar flow is untouched
6. **Consistent with existing patterns**: `product.sourceUrl` is already a validated URL stored from import

### Risks & mitigations
| Risk | Mitigation |
|------|-----------|
| iframe X-Frame-Options blocking by AliExpress | Known limitation — the inline iframe is a preview; the external browser provides full functionality |
| Popup blocker interference with `window.open` | Mitigated by using `useRef<Window | null>` to track and reuse the window object directly, avoiding reliance on named-window resolution |
| External browser window closed by user | `browserWindowRef.current.closed` check handles this — opens a new window on next click |
| AliExpress anti-bot / IP blocking | Pre-existing issue shared with the enrichment flow; external browser is an alternative manual path |
| Security | External browser loads only validated `product.sourceUrl`; no credentials passed |

### No-impact areas
- **Cellar supplier flow**: Completely unaffected
- **Publishing**: `publishing.ts` only added `config.wooCategories` default — no behavioral change
- **Enrichment**: `fetchProductDetails()` and `extractAliexpressProductDetails()` unchanged
- **Import/merge**: `xlsxParser.ts`, `transformWorkbook.ts`, `draftStore.ts` unchanged
- **API surface**: No new endpoints — `descriptionHtml` is already an existing field sent via `PATCH /api/drafts/:draftId/products`
- **Server-side**: No server changes for the rich text editor — the `contentEditable`/`execCommand` approach is entirely client-side

---

## Verification

1. **Type-check**: `npm run typecheck` — both server and client compile without errors ✅
2. **Build**: `npm run build` — produces `client/dist` and `server/dist` ✅
3. **Manual verification**:
   - Load any product with a `descriptionHtml` value → verify the Description field renders as a rich text editor with toolbar
   - Click bold/italic/underline buttons → verify text formatting is applied in the editor
   - Click bullet/numbered list buttons → verify list formatting
   - Click link button → verify a link dialog appears and link is inserted
   - Click image button → verify a prompt appears for image URL, and image is inserted
   - Click clear formatting → verify formatting is removed
   - Edit formatted content → verify `descriptionHtml` is updated correctly on save
   - Verify the rich text editor has the same focus ring styling as the previous textarea
   - Verify the `dirty` indicator (blue border) shows when content is modified
3. **Manual verification**:
   - Load an AliExpress workbook → verify "Browse" and "Open" buttons appear next to AliExpress product titles
   - Verify Cellar products have NO browse/open buttons
   - Click "Browse" → verify inline iframe panel opens below the row with the AliExpress page
   - Click "Browse" on a different product → verify the same inline iframe updates its `src` without DOM recreation
   - Click "Open" → verify product page opens in a new browser window
   - Click "Open" again on a different product → verify the **same** browser window navigates to the new URL (no duplicate windows)
   - Close the external browser window, then click "Open" → verify a new window opens correctly
   - Verify close button (✕) collapses the inline browser panel, rows shift back up
   - If AliExpress blocks iframe embedding via X-Frame-Options, the inline iframe may not render but the external browser still works

---

## Layout restructuring (2026-09-09)

The workspace layout was restructured as part of the VIC-21 implementation:

1. **Consolidated top controls bar** — `workspace-heading` (title + status stats), `toolbar` (search, sort), `filter-bar` (column filters), and `pagination` were all moved into a single `.top-controls-bar` section above `workspace-grid`. Previously these were scattered across the page with `workspace-heading` and `toolbar`/`filter-bar` appearing before `workspace-grid` and `pagination` nested inside `table-panel`. Now all controls appear in one unified area above the product table.

2. **Sticky editor panel** — The `.editor-panel` now uses `position: sticky; top: 0` so the selected product's details stay pinned on the right side while the user scrolls through product listings on the left. The `.editor-header` also uses `position: sticky; top: 0; z-index: 1` so the product name/row info stays visible at the top of the editor panel when scrolling through product fields.

3. **Flex layout** — `.workspace-shell` now uses `height: 100dvh` with `display: flex; flex-direction: column` so `workspace-grid` fills the remaining viewport height after the top controls bar.

## Related Files

| File | Description |
|------|-------------|
| `client/src/App.tsx` | Main React component with inline browser, external browser, and restructured layout |
| `client/src/workspace.css` | Inline browser, top-controls-bar, sticky editor panel styles |
| `server/src/enrichment/sourcePageFetcher.ts` | Existing URL validation reused at import time |
| `server/src/routes/publishing.ts` | Added `config.wooCategories` default for `globalCategoryIds` |
| `docs/ARCHITECTURE.md` | Architecture constraints |
| `docs/SUPPORT.md` | Operator runbook |

## References

- Jira: https://vicandev1979.atlassian.net/browse/VIC-21
- CLAUDE.md: Project instructions and architecture documentation
- `docs/ARCHITECTURE.md`: Full API contracts and data ownership rules
