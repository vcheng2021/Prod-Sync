import { useEffect, useMemo, useState } from 'react'
import {
  exportDraftUrl,
  getCurrentDraft,
  importWorkbook,
  publishProducts,
  purgeDatabase,
  retrieveProduct,
  saveProducts,
  updateProduct,
  type DraftResponse,
  type ProductDraft,
} from './api'
import './App.css'
import './workspace.css'

const PAGE_SIZE = 40
type StatusFilter = 'all' | 'pending' | 'ready' | 'failed' | 'published'
type TitleSort = 'none' | 'asc' | 'desc'
type FilterField = 'title' | 'unitPrice' | 'suggestedSalePrice' | 'casePrice' | 'stockOnHand' | 'inventoryQuantity' | 'imageStatus' | 'enrichmentStatus' | 'publishStatus'

const filterFields: Array<{ field: FilterField; label: string }> = [
  { field: 'title', label: 'Product' },
  { field: 'unitPrice', label: 'Unit price' },
  { field: 'suggestedSalePrice', label: 'Sale price' },
  { field: 'casePrice', label: 'Case price' },
  { field: 'stockOnHand', label: 'Stock' },
  { field: 'inventoryQuantity', label: 'Shopify inventory' },
  { field: 'imageStatus', label: 'Image' },
  { field: 'enrichmentStatus', label: 'Source' },
  { field: 'publishStatus', label: 'Shopify' },
]

const statusText: Record<string, string> = {
  pending: 'Pending',
  ready: 'Ready',
  failed: 'Needs attention',
  blocked: 'Blocked',
  'not-provided': 'Not provided',
  published: 'Published',
  publishing: 'Posting',
  skipped: 'Skipped',
}

const money = (value: number | null) => value === null ? '-' : `$${value.toFixed(2)}`

const filterValue = (product: ProductDraft, field: FilterField): string => {
  if (field === 'title') return product.title || 'Untitled product'
  if (field === 'unitPrice') return money(product.unitPrice)
  if (field === 'suggestedSalePrice') return money(product.suggestedSalePrice)
  if (field === 'casePrice') return money(product.casePrice)
  if (field === 'stockOnHand') return product.stockOnHand === null ? '-' : String(product.stockOnHand)
  if (field === 'inventoryQuantity') return String(product.inventoryQuantity)
  if (field === 'imageStatus') return statusText[product.imageStatus] ?? product.imageStatus
  if (field === 'enrichmentStatus') return statusText[product.enrichmentStatus] ?? product.enrichmentStatus
  return statusText[product.publishStatus] ?? product.publishStatus
}

interface FilterMenuProps {
  label: string
  options: string[]
  selected: string[]
  onChange: (values: string[]) => void
}

function FilterMenu({ label, options, selected, onChange }: FilterMenuProps) {
  const [search, setSearch] = useState('')
  const visibleOptions = options.filter((option) => option.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const toggleValue = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value])
  }

  return (
    <details className="column-filter">
      <summary>{label}{selected.length > 0 && <span className="filter-count">{selected.length}</span>}</summary>
      <div className="filter-popover">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${label.toLocaleLowerCase()}`} aria-label={`Search ${label} filter values`} />
        <div className="filter-options">
          {visibleOptions.map((option) => <label key={option}><input type="checkbox" checked={selected.includes(option)} onChange={() => toggleValue(option)} /><span>{option}</span></label>)}
          {visibleOptions.length === 0 && <small>No matching values</small>}
        </div>
        {selected.length > 0 && <button type="button" className="text-button" onClick={() => onChange([])}>Clear {label}</button>}
      </div>
    </details>
  )
}

function App() {
  const [draft, setDraft] = useState<DraftResponse | null>(null)
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [titleSort, setTitleSort] = useState<TitleSort>('none')
  const [columnFilters, setColumnFilters] = useState<Partial<Record<FilterField, string[]>>>({})
  const [page, setPage] = useState(1)
  const [activeProductId, setActiveProductId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirtyFields, setDirtyFields] = useState<Record<string, Partial<ProductDraft>>>({})
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [purgeConfirmation, setPurgeConfirmation] = useState('')
  const [startupLoading, setStartupLoading] = useState(true)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [confirmPost, setConfirmPost] = useState(false)
  const [retrievingProductId, setRetrievingProductId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const activeProduct = draft?.products.find((product) => product.id === activeProductId) ?? draft?.products[0] ?? null
  const hasUnsavedChanges = Object.keys(dirtyFields).length > 0

  useEffect(() => {
    let mounted = true
    void getCurrentDraft()
      .then((currentDraft) => {
        if (!mounted || !currentDraft) return
        setDraft(currentDraft)
        setActiveProductId(currentDraft.products[0]?.id ?? null)
        setMessage(`${currentDraft.products.length.toLocaleString()} products restored from SQLite.`)
      })
      .catch((requestError: unknown) => {
        if (mounted) setError(requestError instanceof Error ? requestError.message : 'The saved catalog could not be loaded.')
      })
      .finally(() => {
        if (mounted) setStartupLoading(false)
      })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    setPage(1)
  }, [query, statusFilter, columnFilters, titleSort])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  const filterOptions = useMemo(() => {
    const products = draft?.products ?? []
    return Object.fromEntries(filterFields.map(({ field }) => [field, Array.from(new Set(products.map((product) => filterValue(product, field)))).sort((left, right) => left.localeCompare(right))])) as Record<FilterField, string[]>
  }, [draft?.products])

  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const filtered = (draft?.products ?? []).filter((product) => {
      const matchesQuery = !needle || product.title.toLocaleLowerCase().includes(needle) || product.sourceUrl.toLocaleLowerCase().includes(needle)
      const matchesStatus = statusFilter === 'all' ||
        (statusFilter === 'pending' && product.publishStatus === 'pending') ||
        (statusFilter === 'ready' && product.enrichmentStatus === 'ready' && product.validationErrors.length === 0) ||
        (statusFilter === 'failed' && (product.enrichmentStatus === 'failed' || product.publishStatus === 'failed')) ||
        (statusFilter === 'published' && product.publishStatus === 'published')
      const matchesColumns = filterFields.every(({ field }) => {
        const selectedValues = columnFilters[field] ?? []
        return selectedValues.length === 0 || selectedValues.includes(filterValue(product, field))
      })
      return matchesQuery && matchesStatus && matchesColumns
    })
    if (titleSort === 'none') return filtered
    return [...filtered].sort((left, right) => {
      const comparison = left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
      return titleSort === 'asc' ? comparison : -comparison
    })
  }, [columnFilters, draft?.products, query, statusFilter, titleSort])

  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE))
  const visibleProducts = filteredProducts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const selectedProducts = draft?.products.filter((product) => product.selected) ?? []
  const validSelectedProducts = selectedProducts.filter((product) => product.validationErrors.length === 0 && product.suggestedSalePrice !== null && product.suggestedSalePrice > 0 && Number.isInteger(product.inventoryQuantity) && product.inventoryQuantity >= 0)

  const replaceProduct = (product: ProductDraft) => {
    setDraft((current) => current ? { ...current, products: current.products.map((entry) => entry.id === product.id ? product : entry) } : current)
  }

  const patchProduct = (productId: string, patch: Partial<ProductDraft>) => {
    setDraft((current) => {
      if (!current) return current
      const existingProduct = current.products.find((product) => product.id === productId)
      const selectionDelta = 'selected' in patch && existingProduct ? Number(Boolean(patch.selected)) - Number(existingProduct.selected) : 0
      return {
        ...current,
        draft: { ...current.draft, selectedProducts: current.draft.selectedProducts + selectionDelta },
        products: current.products.map((product) => product.id === productId ? { ...product, ...patch } : product),
      }
    })
    if (Object.keys(patch).length === 1 && 'selected' in patch) {
      void updateProduct(draft?.draft.id ?? '', productId, patch)
        .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : 'Could not save the selection.'))
      return
    }
    setDirtyFields((current) => ({ ...current, [productId]: { ...(current[productId] ?? {}), ...patch } }))
  }

  const handleSave = async () => {
    if (!draft || !hasUnsavedChanges || saving) return
    const changes = Object.entries(dirtyFields).map(([id, productChanges]) => ({ id, changes: productChanges }))
    setSaving(true)
    setError('')
    try {
      const result = await saveProducts(draft.draft.id, changes)
      setDraft(result.draft)
      setDirtyFields((current) => {
        const remaining = { ...current }
        for (const change of changes) {
          const pending = remaining[change.id]
          if (!pending) continue
          const unresolved = Object.fromEntries(Object.entries(pending).filter(([field, value]) => change.changes[field as keyof ProductDraft] !== value)) as Partial<ProductDraft>
          if (Object.keys(unresolved).length) remaining[change.id] = unresolved
          else delete remaining[change.id]
        }
        return remaining
      })
      setMessage(`Saved ${changes.length.toLocaleString()} product${changes.length === 1 ? '' : 's'} with changed fields only.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save the product changes.')
    } finally {
      setSaving(false)
    }
  }

  const handleImport = async (file: File) => {
    if (hasUnsavedChanges && !window.confirm('You have unsaved changes. Import this workbook and discard them?')) return
    setBusy(true)
    setError('')
    setMessage('Reading workbook. Source data will be retrieved only when you request it for a checked row.')
    try {
      const result = await importWorkbook(file)
      setDraft(result)
      setDirtyFields({})
      setImportErrors(result.importErrors)
      setActiveProductId(result.products[0]?.id ?? null)
      setMessage(`${result.products.length.toLocaleString()} products merged from ${result.sheetName}: ${result.importSummary.added} added, ${result.importSummary.updated} updated, ${result.importSummary.unchanged} unchanged, ${result.importSummary.duplicateRowsSkipped} exact duplicates skipped.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The workbook could not be imported.')
      setMessage('')
    } finally {
      setBusy(false)
    }
  }

  const handleNewImport = () => {
    if (hasUnsavedChanges && !window.confirm('You have unsaved changes. Start a new workbook import and discard them?')) return
    setDraft(null)
    setDirtyFields({})
    setImportErrors([])
    setMessage('')
    setError('')
  }

  const handlePurge = async () => {
    if (purgeConfirmation !== 'PURGE' || saving || publishing) return
    setBusy(true)
    setError('')
    try {
      await purgeDatabase()
      setDraft(null)
      setDirtyFields({})
      setImportErrors([])
      setActiveProductId(null)
      setPurgeOpen(false)
      setPurgeConfirmation('')
      setMessage('Database content purged. Choose a workbook to start fresh.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The database could not be purged.')
    } finally {
      setBusy(false)
    }
  }

  const toggleAllVisible = () => {
    const shouldSelect = visibleProducts.some((product) => !product.selected)
    for (const product of visibleProducts) patchProduct(product.id, { selected: shouldSelect })
  }

  const handleRetrieve = async (product: ProductDraft) => {
    if (!draft || !product.selected || (!product.sourceUrl && !product.imageUrl)) return
    setActiveProductId(product.id)
    setRetrievingProductId(product.id)
    setBusy(true)
    setError('')
    try {
      const retrievedProduct = await retrieveProduct(draft.draft.id, product.id)
      replaceProduct(retrievedProduct)
      const retrievedParts = [
        retrievedProduct.imageStatus === 'valid' ? 'image' : '',
        retrievedProduct.enrichmentStatus === 'ready' ? 'source details' : '',
      ].filter(Boolean)
      setMessage(retrievedParts.length > 0
        ? `${retrievedParts.join(' and ')} retrieved for ${product.title || 'the selected product'}.`
        : `No product-specific source data was found for ${product.title || 'the selected product'}.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Source data could not be retrieved.')
    } finally {
      setBusy(false)
      setRetrievingProductId(null)
    }
  }

  const retrieveLabel = (product: ProductDraft) => {
    if (!product.selected) return 'Check row first'
    if (retrievingProductId === product.id) return 'Retrieving...'
    if (product.enrichmentStatus === 'failed' || product.enrichmentStatus === 'blocked' || product.imageStatus === 'failed' || product.imageStatus === 'blocked') return 'Retry source data'
    if (product.enrichmentStatus === 'ready' || product.imageStatus === 'valid') return 'Retrieve again'
    return 'Retrieve source data'
  }

  const handlePublish = async () => {
    if (!draft || !confirmPost || validSelectedProducts.length === 0) return
    setPublishing(true)
    setError('')
    try {
      const result = await publishProducts(draft.draft.id, validSelectedProducts.map((product) => product.id))
      setDraft(result.draft)
      setReviewOpen(false)
      setConfirmPost(false)
      const failed = result.results.filter((entry) => entry.status === 'failed' || entry.status === 'skipped').length
      setMessage(failed ? `Posting finished with ${failed} row${failed === 1 ? '' : 's'} needing attention.` : `${result.results.length} product${result.results.length === 1 ? '' : 's'} posted to Shopify.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Products could not be posted.')
    } finally {
      setPublishing(false)
    }
  }

  const renderStatus = (status: string) => <span className={`status status-${status}`}>{statusText[status] ?? status}</span>

  const renderNumberInput = (label: string, field: 'stockOnHand' | 'casePrice' | 'unitPrice' | 'suggestedSalePrice' | 'inventoryQuantity', value: number | null) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min="0"
        step={field === 'inventoryQuantity' || field === 'stockOnHand' ? '1' : '0.01'}
        value={value ?? ''}
        onChange={(event) => patchProduct(activeProduct!.id, { [field]: event.target.value === '' ? null : Number(event.target.value) } as Partial<ProductDraft>)}
      />
    </label>
  )

  if (!draft) {
    return (
      <main className="app-shell landing-shell">
        <header className="brandbar">
          <div className="brandmark"><span className="brand-dot" /> CELLAR / DRIVE</div>
          <span className="connection-pill">Shopify connected</span>
        </header>
        <section className="import-hero">
          <div className="eyebrow">SUPPLIER PRODUCT DESK / 01</div>
          <h1 className="page-title">Cellar Drive product update</h1>
          <p className="hero-copy">Load a workbook, enrich each row from its source page, make the edits that matter, then post only the products you approve.</p>
          <label className={`upload-zone ${busy ? 'is-busy' : ''}`}>
            <input type="file" accept=".xlsx" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImport(file) }} />
            <span className="upload-kicker">{startupLoading ? 'LOADING SAVED CATALOG' : busy ? 'PROCESSING WORKBOOK' : 'DROP OR CHOOSE XLSX'}</span>
            <strong>{startupLoading ? 'Restoring your product workspace...' : busy ? 'Merging workbook into SQLite...' : 'Upload supplier workbook'}</strong>
            <span>Check a row, then choose when its column A image and column F source page are retrieved.</span>
          </label>
          {message && <p className="notice notice-info">{message}</p>}
          {error && <p className="notice notice-error">{error}</p>}
          <div className="mapping-strip">
            <span><b>A</b> image</span><span><b>E</b> title</span><span><b>F</b> source page</span><span><b>G</b> stock</span><span><b>I</b> case</span><span><b>J</b> unit price</span>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell workspace-shell">
      <header className="brandbar">
        <div className="brandmark"><span className="brand-dot" /> CELLAR / DRIVE <span className="brand-context">PRODUCT DESK</span></div>
        <div className="header-actions"><span className="connection-pill">cb1710-2.myshopify.com</span><button type="button" className="button button-primary" disabled={!hasUnsavedChanges || saving} onClick={() => void handleSave()}>{saving ? 'Saving...' : hasUnsavedChanges ? 'Save changes' : 'Saved'}</button><button type="button" className="button button-quiet" onClick={handleNewImport}>New import</button><button type="button" className="button button-danger" onClick={() => setPurgeOpen(true)}>Purge database</button></div>
      </header>

      <section className="workspace-heading">
        <div><div className="eyebrow">IMPORT / {draft.draft.filename}</div><h1 className="page-title">Cellar Drive product update</h1><p>Review the source data. Shape the details. Post with intent.</p></div>
        <a className="button button-secondary" href={exportDraftUrl(draft.draft.id)} download>Export all data</a>
      </section>

      <section className="metric-row">
        <div><span>Rows loaded</span><strong>{draft.draft.totalProducts.toLocaleString()}</strong></div>
        <div><span>Selected</span><strong>{draft.draft.selectedProducts.toLocaleString()}</strong></div>
        <div><span>Source pages ready</span><strong>{draft.draft.readyProducts.toLocaleString()}</strong></div>
        <div><span>Posting issues</span><strong className={draft.draft.failedProducts ? 'metric-alert' : ''}>{draft.draft.failedProducts.toLocaleString()}</strong></div>
      </section>

      <section className="toolbar">
        <label className="search-field"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title or source URL" /></label>
        <label className="filter-field"><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}><option value="all">All rows</option><option value="pending">Pending</option><option value="ready">Ready</option><option value="failed">Needs attention</option><option value="published">Published</option></select></label>
        <button type="button" className="button button-secondary" onClick={toggleAllVisible}>{visibleProducts.every((product) => product.selected) ? 'Clear visible' : 'Select visible'}</button>
        <button type="button" className="button button-primary" disabled={validSelectedProducts.length === 0 || publishing} onClick={() => setReviewOpen(true)}>{publishing ? 'Posting...' : `Post selected (${validSelectedProducts.length})`}</button>
      </section>

      <section className="filter-bar" aria-label="Column filters">
        <div className="filter-bar-label"><span>Filter columns</span><small>{Object.values(columnFilters).reduce((total, values) => total + (values?.length ?? 0), 0)} active</small></div>
        {filterFields.map(({ field, label }) => <FilterMenu key={field} label={label} options={filterOptions[field]} selected={columnFilters[field] ?? []} onChange={(values) => setColumnFilters((current) => ({ ...current, [field]: values }))} />)}
        <label className="filter-field title-sort"><span>Title sort</span><select value={titleSort} onChange={(event) => setTitleSort(event.target.value as TitleSort)}><option value="none">Original order</option><option value="asc">A to Z</option><option value="desc">Z to A</option></select></label>
        <button type="button" className="text-button" disabled={Object.keys(columnFilters).length === 0 && titleSort === 'none'} onClick={() => { setColumnFilters({}); setTitleSort('none') }}>Clear filters</button>
      </section>

      {message && <p className="notice notice-info workspace-notice">{message}</p>}
      {error && <p className="notice notice-error workspace-notice">{error}</p>}

      <section className="workspace-grid">
        <div className="table-panel">
          <div className="table-meta"><span>{filteredProducts.length.toLocaleString()} matching rows</span><span>Page {page} of {pageCount}</span></div>
          <div className="table-wrap"><table><thead><tr><th className="check-column"><input type="checkbox" checked={visibleProducts.length > 0 && visibleProducts.every((product) => product.selected)} onChange={toggleAllVisible} aria-label="Select all visible products" /></th><th>Product</th><th>Unit / case</th><th>Stock</th><th>Source</th><th>Shopify</th><th>Source data</th></tr></thead><tbody>
            {visibleProducts.map((product) => <tr key={product.id} className={activeProduct?.id === product.id ? 'is-active' : ''} onClick={() => setActiveProductId(product.id)}>
              <td className="check-column" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={product.selected} onChange={(event) => patchProduct(product.id, { selected: event.target.checked })} aria-label={`Select ${product.title}`} /></td>
              <td><div className="product-cell"><div className="thumb">{product.imageLocalUrl ? <img src={product.imageLocalUrl} alt="" loading="lazy" /> : <span>{product.imageStatus === 'pending' ? '...' : 'IMG'}</span>}</div><div><strong>{product.title || 'Untitled product'}</strong><small>Row {product.rowNumber} {product.validationErrors.length ? ` / ${product.validationErrors.length} issue${product.validationErrors.length === 1 ? '' : 's'}` : ''}</small></div></div></td>
              <td><strong>{money(product.unitPrice)}</strong><small>{money(product.casePrice)} case</small></td>
              <td>{product.stockOnHand ?? '-'}</td>
              <td>{renderStatus(product.enrichmentStatus)}</td>
              <td>{renderStatus(product.publishStatus)}</td>
              <td className="source-action" onClick={(event) => event.stopPropagation()}><button type="button" className="row-action" disabled={busy || !product.selected || (!product.sourceUrl && !product.imageUrl)} onClick={() => void handleRetrieve(product)}>{retrieveLabel(product)}</button></td>
            </tr>)}
          </tbody></table>{visibleProducts.length === 0 && <div className="empty-state">No products match this view.</div>}</div>
          <div className="pagination"><button type="button" className="button button-secondary" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button><span>{page} / {pageCount}</span><button type="button" className="button button-secondary" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>Next</button></div>
        </div>

        <aside className="editor-panel">
          {activeProduct ? <>
            <div className="editor-header"><div><div className="eyebrow">ROW {activeProduct.rowNumber}</div><h2>Product detail</h2></div>{renderStatus(activeProduct.enrichmentStatus)}</div>
            <label className="field"><span>Title</span><input value={activeProduct.title} onChange={(event) => patchProduct(activeProduct.id, { title: event.target.value })} /></label>
            <div className="field-grid">{renderNumberInput('Unit price', 'unitPrice', activeProduct.unitPrice)}{renderNumberInput('Suggested sale price', 'suggestedSalePrice', activeProduct.suggestedSalePrice)}{renderNumberInput('Case price', 'casePrice', activeProduct.casePrice)}{renderNumberInput('Supplier stock on hand', 'stockOnHand', activeProduct.stockOnHand)}{renderNumberInput('Shopify inventory', 'inventoryQuantity', activeProduct.inventoryQuantity)}</div>
            <div className="source-line"><span>Source page</span>{activeProduct.sourceUrl ? <a href={activeProduct.sourceUrl} target="_blank" rel="noreferrer">Open source</a> : <em>Not provided</em>}<button type="button" className="text-button" disabled={busy || !activeProduct.selected || (!activeProduct.sourceUrl && !activeProduct.imageUrl)} onClick={() => void handleRetrieve(activeProduct)}>{retrieveLabel(activeProduct)}</button></div>
            <div className="about-heading"><div><div className="eyebrow">CONTENT BLOCK</div><h3>About this product</h3></div><span>Editable</span></div>
            <section className="image-details" aria-label="Retrieved image details">
              <div className="image-details-heading"><span>Image details</span>{renderStatus(activeProduct.imageStatus)}</div>
              <div className="image-details-body">
                <div className="editor-image">{activeProduct.imageLocalUrl ? <img src={activeProduct.imageLocalUrl} alt={`Retrieved image for ${activeProduct.title}`} /> : <span>{activeProduct.imageStatus === 'pending' ? 'Not retrieved' : 'No saved image'}</span>}</div>
                <dl className="image-meta">
                  <div><dt>Column A source</dt><dd>{activeProduct.imageUrl ? <a href={activeProduct.imageUrl} target="_blank" rel="noreferrer">Open image source</a> : 'Not provided'}</dd></div>
                  <div><dt>Saved file</dt><dd>{activeProduct.imageLocalFilename || 'Not retrieved'}</dd></div>
                  <div><dt>Retrieval</dt><dd>{activeProduct.imageStatus === 'valid' ? 'Downloaded to productimage' : 'Available after source retrieval'}</dd></div>
                </dl>
              </div>
            </section>
            {activeProduct.enrichmentError && <p className="source-error">Source retrieval: {activeProduct.enrichmentError}</p>}
            <label className="field"><span>Description</span><textarea rows={6} value={activeProduct.descriptionHtml} onChange={(event) => patchProduct(activeProduct.id, { descriptionHtml: event.target.value })} placeholder="Fetched description or your own copy" /></label>
            <div className="detail-fields">{(['brand', 'country', 'region', 'productType', 'abv', 'containerType', 'style'] as const).map((field) => <label className="field" key={field}><span>{field === 'abv' ? 'ABV %' : field === 'productType' ? 'Product Type' : field === 'containerType' ? 'Container Type' : field[0].toLocaleUpperCase() + field.slice(1)}</span><input value={activeProduct[field]} onChange={(event) => patchProduct(activeProduct.id, { [field]: event.target.value } as Partial<ProductDraft>)} /></label>)}</div>
            {activeProduct.validationErrors.length > 0 && <div className="validation-box"><strong>Needs attention</strong>{activeProduct.validationErrors.map((validationError) => <span key={validationError}>{validationError}</span>)}</div>}
          </> : <div className="empty-state">Choose a product to edit.</div>}
        </aside>
      </section>

      {importErrors.length > 0 && <details className="import-errors"><summary>{importErrors.length.toLocaleString()} import warnings</summary><div>{importErrors.slice(0, 100).map((importError) => <p key={importError}>{importError}</p>)}{importErrors.length > 100 && <p>Showing the first 100 warnings. Export all data for the complete working set.</p>}</div></details>}

      {reviewOpen && <div className="modal-backdrop" role="presentation"><section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><div className="eyebrow">FINAL CHECK</div><h2 id="review-title">Post {validSelectedProducts.length} selected product{validSelectedProducts.length === 1 ? '' : 's'}?</h2><p>Suggested sale price and Shopify inventory will be sent to the configured Shopify location.</p><div className="review-list">{validSelectedProducts.slice(0, 8).map((product) => <div key={product.id}><span>{product.title}</span><strong>{money(product.suggestedSalePrice)} / {product.inventoryQuantity} units</strong></div>)}{validSelectedProducts.length > 8 && <small>Plus {validSelectedProducts.length - 8} more selected products.</small>}</div><label className="confirm-check"><input type="checkbox" checked={confirmPost} onChange={(event) => setConfirmPost(event.target.checked)} /> I confirm these selected products are ready to post.</label><div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => { setReviewOpen(false); setConfirmPost(false) }}>Cancel</button><button type="button" className="button button-primary" disabled={!confirmPost || publishing} onClick={() => void handlePublish()}>{publishing ? 'Posting...' : 'Confirm and post'}</button></div></section></div>}
      {purgeOpen && <div className="modal-backdrop" role="presentation"><section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="purge-title"><div className="eyebrow">DESTRUCTIVE ACTION</div><h2 id="purge-title">Purge the database?</h2><p>This removes catalog products, publish history, cached source data, and downloaded product images. The operation cannot be undone. Type PURGE to continue.</p><label className="field"><span>Confirmation</span><input value={purgeConfirmation} onChange={(event) => setPurgeConfirmation(event.target.value)} autoComplete="off" /></label><div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => { setPurgeOpen(false); setPurgeConfirmation('') }}>Cancel</button><button type="button" className="button button-danger" disabled={purgeConfirmation !== 'PURGE' || busy} onClick={() => void handlePurge()}>{busy ? 'Purging...' : 'Purge database'}</button></div></section></div>}
    </main>
  )
}

export default App
