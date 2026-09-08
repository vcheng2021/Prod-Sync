# Site Design Spec: Product List + Detail Pane (Vican Visions)

**Page title:** "Title (Small font)" — small font heading at top of the page.

## Layout: Two-column split view

### Left column — Product List
- A vertical scrollable list of product rows.
- Each row displays: **Image, Product Title (opens link), Unit Price, Sale Price, Stock**, etc.
- Rows are separated by horizontal divider lines.
- The **currently selected row is highlighted** (shown in the mockup as a red divider/underline).

### Right column — Product Details Pane
- Contains a large **image box** at the top (main product image display).
- Below the image box, a vertical list of detail sections:
  1. **Product Details**
  2. **Categories**
  3. **Supplier Data**
  4. **Suggested Data** (app-generated data)
  5. **About this product**, containing:
     - Main Image
     - Gallery images (0–5 optional images)
     - Product Description (rich text box)
     - Product Attributes (rich text box)
     - Brand, Country
     - Region, Product Type
     - Product Style (aka Container Type)
     - **Note:** Hide ABV% field when supplier = "vican"

## Key behavior (core interactive detail)

- The list (left) and detail pane (right) are **separated by a vertical divider line**.
- When the user selects/clicks a different row in the left list, the **right-hand detail pane dynamically slides up or down** so that the **top of the detail box stays vertically aligned with the currently selected row**.
- In other words: the detail pane's vertical position is **synced to track the selected row's position** as the user scrolls or clicks through the list — it is not fixed/static, and not simply centered on screen.

## Suggested implementation notes for Claude Code

- Left panel: scrollable list component, each item clickable, tracks `selectedIndex` / `selectedId`.
- Right panel: absolutely/relatively positioned detail container whose `top` offset is calculated from the selected row's `offsetTop` (or bounding rect) within the scroll container, animated with a CSS transition (e.g., `transition: top 0.2s ease`) for the "sliding" effect.
- Use a layout with two flex/grid columns divided by a vertical border.
- Conditionally render/hide the ABV% field based on `supplier === 'vican'`.
