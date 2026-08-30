import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import {
  exportDraftUrl,
  getIssueLog,
  getCurrentDraft,
  getReadiness,
  importWorkbook,
  publishProducts,
  purgeDatabase,
  retrieveProduct,
  saveProducts,
  updateProduct,
  type DraftResponse,
  type LogIssue,
  type ProductDraft,
  type ReadinessStatus,
} from './api'
import { ToastProvider, useToast } from './components/Toast'
import './App.css'
import './workspace.css'

const PAGE_SIZE = 40
type StatusFilter = 'all' | 'pending' | 'ready' | 'failed' | 'published'
type SortOption = 'none' | 'selected' | 'title-asc' | 'title-desc' | 'source' | 'shopify'
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

const money = (value: number | null) => (value === null ? '—' : `$${value.toFixed(2)}`)
const logDetailValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)

const filterValue = (product: ProductDraft, field: FilterField): string => {
  if (field === 'title') return product.title || 'Untitled product'
  if (field === 'unitPrice') return money(product.unitPrice)
  if (field === 'suggestedSalePrice') return money(product.suggestedSalePrice)
  if (field === 'casePrice') return money(product.casePrice)
  if (field === 'stockOnHand') return product.stockOnHand === null ? '—' : String(product.stockOnHand)
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
  const visibleOptions = options.filter((option) =>
    option.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  )
  const toggleValue = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((entry) => entry !== value)
        : [...selected, value],
    )
  }

  return (
    <details className="column-filter">
      <summary>
        {label}
        {selected.length > 0 && <span className="filter-count">{selected.length}</span>}
      </summary>
      <div className="filter-popover">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={`Search ${label.toLocaleLowerCase()}`}
          aria-label={`Search ${label} filter values`}
        />
        <div className="filter-options">
          {visibleOptions.map((option) => (
            <label key={option}>
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={() => toggleValue(option)}
              />
              <span>{option}</span>
            </label>
          ))}
          {visibleOptions.length === 0 && <small>No matching values</small>}
        </div>
        {selected.length > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={() => onChange([])}
          >
            Clear {label}
          </button>
        )}
      </div>
    </details>
  )
}

function ThemeToggle() {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute('data-theme') === 'dark',
  )

  const toggle = () => {
    const next = !isDark
    setIsDark(next)
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light')
  }

  return (
    <button
      type="button"
      className="button button-quiet"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? '☀️' : '🌙'}
    </button>
  )
}

function BackgroundSettings() {
  const [customBg, setCustomBg] = useState<string | null>(() =>
    localStorage.getItem('ecomint-bg'),
  )
  const [showSettings, setShowSettings] = useState(false)
  const { showToast } = useToast()

  const applyBg = (dataUrl: string) => {
    document.body.style.background =
      'linear-gradient(rgba(0, 0, 0, 0.15), rgba(0, 0, 0, 0.15)), url("' +
      dataUrl +
      '") no-repeat center/cover fixed'
  }

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      showToast('error', 'Please select an image file (PNG, JPG, etc.).')
      return
    }
    event.target.value = ''
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result
      if (typeof dataUrl === 'string') {
        localStorage.setItem('ecomint-bg', dataUrl)
        setCustomBg(dataUrl)
        applyBg(dataUrl)
        setShowSettings(false)
        showToast('success', 'Background image applied.')
      }
    }
    reader.readAsDataURL(file)
  }

  const clearBg = () => {
    document.body.style.background = ''
    localStorage.removeItem('ecomint-bg')
    setCustomBg(null)
    showToast('info', 'Background image cleared.')
  }

  return (
    <>
      <button
        type="button"
        className="button button-quiet"
        onClick={() => setShowSettings(true)}
        aria-label="Change background image"
        title="Change background image"
      >
        🎨
      </button>
      {showSettings && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bg-title"
          >
            <div className="eyebrow">BACKGROUND</div>
            <h2 id="bg-title">Background image</h2>
            <p style={{ color: 'var(--muted)', fontSize: '14px', lineHeight: 1.5, marginTop: 0 }}>
              Upload an image to use as the workspace background. A subtle overlay keeps content readable.
            </p>
            <div
              className="bg-preview"
              style={customBg ? { backgroundImage: `url("${customBg}")` } : undefined}
            >
              {!customBg && 'No image set'}
            </div>
            <div className="bg-upload-row">
              <label className="bg-upload-label">
                <input type="file" accept="image/*" onChange={handleUpload} />
                Choose image file
              </label>
              {customBg && (
                <button
                  type="button"
                  className="button button-danger"
                  onClick={clearBg}
                >
                  Clear
                </button>
              )}
            </div>
            <p className="bg-note">
              Image is stored locally in your browser and applies to this workspace only.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setShowSettings(false)}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}

function AppContent() {
  const { showToast } = useToast()
  const [draft, setDraft] = useState<DraftResponse | null>(null)
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortOption, setSortOption] = useState<SortOption>('none')
  const [retrievingBulk, setRetrievingBulk] = useState(false)
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
  const [issuesOpen, setIssuesOpen] = useState(false)
  const [issuesLoading, setIssuesLoading] = useState(false)
  const [logIssues, setLogIssues] = useState<LogIssue[]>([])
  const [readiness, setReadiness] = useState<ReadinessStatus | null>(null)
  const [clearingChecked, setClearingChecked] = useState(false)

  const activeProduct =
    draft?.products.find((product) => product.id === activeProductId) ??
    draft?.products[0] ??
    null
  const hasUnsavedChanges = Object.keys(dirtyFields).length > 0

  const dirtyFieldsFor = (productId: string): Partial<ProductDraft> =>
    dirtyFields[productId] ?? {}

  // ── Startup: load catalog + Shopify readiness ──
  useEffect(() => {
    let mounted = true
    void getCurrentDraft()
      .then((currentDraft) => {
        if (!mounted || !currentDraft) return
        setDraft(currentDraft)
        setActiveProductId(currentDraft.products[0]?.id ?? null)
        showToast('info', `${currentDraft.products.length.toLocaleString()} products restored from SQLite.`)
      })
      .catch((requestError: unknown) => {
        if (mounted)
          showToast('error', requestError instanceof Error ? requestError.message : 'The saved catalog could not be loaded.')
      })
    void getReadiness()
      .then((status) => {
        if (mounted) setReadiness(status)
      })
      .catch(() => {
        if (mounted) setReadiness(null)
      })
    void Promise.resolve().then(() => {
      if (mounted) setStartupLoading(false)
    })
    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setPage(1)
  }, [query, statusFilter, columnFilters, sortOption])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  // ── Derived: filter options, filtered products, metrics ──
  const filterOptions = useMemo(() => {
    const products = draft?.products ?? []
    return Object.fromEntries(
      filterFields.map(({ field }) => [
        field,
        Array.from(
          new Set(products.map((product) => filterValue(product, field))),
        ).sort((left, right) => left.localeCompare(right)),
      ]),
    ) as Record<FilterField, string[]>
  }, [draft?.products])

  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const filtered = (draft?.products ?? []).filter((product) => {
      const matchesQuery =
        !needle ||
        product.title.toLocaleLowerCase().includes(needle) ||
        product.sourceUrl.toLocaleLowerCase().includes(needle)
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'pending' && product.publishStatus === 'pending') ||
        (statusFilter === 'ready' &&
          product.enrichmentStatus === 'ready' &&
          product.validationErrors.length === 0) ||
        (statusFilter === 'failed' &&
          (product.enrichmentStatus === 'failed' ||
            product.publishStatus === 'failed')) ||
        (statusFilter === 'published' && product.publishStatus === 'published')
      const matchesColumns = filterFields.every(({ field }) => {
        const selectedValues = columnFilters[field] ?? []
        return (
          selectedValues.length === 0 ||
          selectedValues.includes(filterValue(product, field))
        )
      })
      return matchesQuery && matchesStatus && matchesColumns
    })
    if (sortOption === 'none') return filtered
    if (sortOption === 'selected') {
      return [...filtered].sort((left, right) => Number(right.selected) - Number(left.selected))
    }
    if (sortOption === 'title-asc') {
      return [...filtered].sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }))
    }
    if (sortOption === 'title-desc') {
      return [...filtered].sort((left, right) => -left.title.localeCompare(right.title, undefined, { sensitivity: 'base' }))
    }
    if (sortOption === 'source') {
      return [...filtered].sort((left, right) => left.enrichmentStatus.localeCompare(right.enrichmentStatus))
    }
    if (sortOption === 'shopify') {
      return [...filtered].sort((left, right) => left.publishStatus.localeCompare(right.publishStatus))
    }
    return filtered
  }, [columnFilters, draft?.products, query, statusFilter, sortOption])

  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE))
  const visibleProducts = filteredProducts.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  )
  const selectedProducts = draft?.products.filter((product) => product.selected) ?? []
  const validSelectedProducts = selectedProducts.filter(
    (product) =>
      product.validationErrors.length === 0 &&
      product.suggestedSalePrice !== null &&
      product.suggestedSalePrice > 0 &&
      Number.isInteger(product.inventoryQuantity) &&
      product.inventoryQuantity >= 0,
  )
  const issueProducts = (draft?.products ?? []).filter(
    (product) =>
      product.publishError ||
      product.enrichmentError ||
      product.validationErrors.length > 0,
  )

  // ── State helpers ──
  const replaceProduct = (product: ProductDraft) => {
    const pendingChanges = dirtyFields[product.id] ?? {}
    setDraft((current) =>
      current
        ? {
            ...current,
            products: current.products.map((entry) =>
              entry.id === product.id ? { ...product, ...pendingChanges } : entry,
            ),
          }
        : current,
    )
  }

  const patchProduct = (productId: string, patch: Partial<ProductDraft>) => {
    setDraft((current) => {
      if (!current) return current
      const existingProduct = current.products.find(
        (product) => product.id === productId,
      )
      const selectionDelta =
        'selected' in patch && existingProduct
          ? Number(Boolean(patch.selected)) - Number(existingProduct.selected)
          : 0
      return {
        ...current,
        draft: {
          ...current.draft,
          selectedProducts: current.draft.selectedProducts + selectionDelta,
        },
        products: current.products.map((product) =>
          product.id === productId ? { ...product, ...patch } : product,
        ),
      }
    })
    if (Object.keys(patch).length === 1 && 'selected' in patch) {
      void updateProduct(draft?.draft.id ?? '', productId, patch).catch(
        (requestError: unknown) =>
          showToast('error', requestError instanceof Error ? requestError.message : 'Could not save the selection.'),
      )
      return
    }
    setDirtyFields((current) => ({
      ...current,
      [productId]: { ...(current[productId] ?? {}), ...patch },
    }))
  }

  // ── Actions ──
  const handleSave = async () => {
    if (!draft || !hasUnsavedChanges || saving) return
    const changes = Object.entries(dirtyFields).map(([id, productChanges]) => ({
      id,
      changes: productChanges,
    }))
    setSaving(true)
    try {
      const result = await saveProducts(draft.draft.id, changes)
      setDraft(result.draft)
      setDirtyFields((current) => {
        const remaining = { ...current }
        for (const change of changes) {
          const pending = remaining[change.id]
          if (!pending) continue
          const unresolved = Object.fromEntries(
            Object.entries(pending).filter(
              ([field, value]) =>
                change.changes[field as keyof ProductDraft] !== value,
            ),
          ) as Partial<ProductDraft>
          if (Object.keys(unresolved).length) remaining[change.id] = unresolved
          else delete remaining[change.id]
        }
        return remaining
      })
      showToast('success', `Saved ${changes.length.toLocaleString()} product${changes.length === 1 ? '' : 's'}.`)
    } catch (requestError) {
      showToast('error', requestError instanceof Error ? requestError.message : 'Could not save the product changes.')
    } finally {
      setSaving(false)
    }
  }

  const handleImport = async (file: File) => {
    if (hasUnsavedChanges && !confirm('You have unsaved changes. Import this workbook and discard them?')) return
    setBusy(true)
    showToast('info', 'Reading workbook. Source data will be retrieved only when you request it for a checked row.')
    try {
      const result = await importWorkbook(file)
      setDraft(result)
      setDirtyFields({})
      setImportErrors(result.importErrors)
      setActiveProductId(result.products[0]?.id ?? null)
      setQuery('')
      setStatusFilter('all')
      setSortOption('none')
      setColumnFilters({})
      setPage(1)
      setReviewOpen(false)
      setConfirmPost(false)
      showToast(
        'success',
        `${result.products.length.toLocaleString()} products merged from ${result.sheetName}: ${result.importSummary.added} added, ${result.importSummary.updated} updated, ${result.importSummary.unchanged} unchanged, ${result.importSummary.duplicateRowsSkipped} exact duplicates skipped.`,
      )
    } catch (requestError) {
      showToast('error', requestError instanceof Error ? requestError.message : 'The workbook could not be imported.')
    } finally {
      setBusy(false)
    }
  }

  const clearTransientState = () => {
    setDraft(null)
    setDirtyFields({})
    setImportErrors([])
    setActiveProductId(null)
    setQuery('')
    setStatusFilter('all')
    setSortOption('none')
    setColumnFilters({})
    setPage(1)
    setReviewOpen(false)
    setConfirmPost(false)
    setRetrievingProductId(null)
    setIssuesOpen(false)
    setLogIssues([])
    setPurgeOpen(false)
    setPurgeConfirmation('')
  }

  const handleResetPage = () => {
    if (hasUnsavedChanges && !confirm('You have unsaved changes. Start a new workbook import and discard them?')) return
    clearTransientState()
    showToast('info', 'Page reset. Choose a workbook to start fresh.')
  }

  const handlePurge = async () => {
    if (purgeConfirmation !== 'PURGE' || saving || publishing) return
    setBusy(true)
    try {
      await purgeDatabase()
      clearTransientState()
      showToast('success', 'Database purged. Choose a workbook to start fresh.')
    } catch (requestError) {
      showToast('error', requestError instanceof Error ? requestError.message : 'The database could not be purged.')
    } finally {
      setBusy(false)
    }
  }

  const toggleAllVisible = () => {
    const shouldSelect = visibleProducts.some((product) => !product.selected)
    for (const product of visibleProducts) patchProduct(product.id, { selected: shouldSelect })
  }

  const clearAllChecked = () => {
    if (!draft || clearingChecked) return
    setClearingChecked(true)
    const selected = draft.products.filter((product) => product.selected)
    for (const product of selected) patchProduct(product.id, { selected: false })
    setClearingChecked(false)
  }

  const handleRetrieve = async (product: ProductDraft) => {
    if (!draft || !product.selected || (!product.sourceUrl && !product.imageUrl)) return
    setActiveProductId(product.id)
    setRetrievingProductId(product.id)
    setBusy(true)
    try {
      const retrievedProduct = await retrieveProduct(draft.draft.id, product.id)
      replaceProduct(retrievedProduct)
      const retrievedParts = [
        retrievedProduct.imageStatus === 'valid' ? 'image' : '',
        retrievedProduct.enrichmentStatus === 'ready' ? 'source details' : '',
      ].filter(Boolean)
      if (retrievedParts.length > 0)
        showToast('success', `${retrievedParts.join(' and ')} retrieved for ${product.title || 'the selected product'}.`)
      else
        showToast(
          'info',
          `No product-specific source data was found for ${product.title || 'the selected product'}.`,
        )
    } catch (requestError) {
      showToast('error', requestError instanceof Error ? requestError.message : 'Source data could not be retrieved.')
    } finally {
      setBusy(false)
      setRetrievingProductId(null)
    }
  }

  const handleBulkRetrieve = async () => {
    if (!draft || busy) return
    const toRetrieve = selectedProducts.filter((product) => product.sourceUrl || product.imageUrl)
    if (toRetrieve.length === 0) return
    setRetrievingBulk(true)
    try {
      let imageCount = 0
      let sourceCount = 0
      for (const product of toRetrieve) {
        setActiveProductId(product.id)
        try {
          const retrievedProduct = await retrieveProduct(draft.draft.id, product.id)
          replaceProduct(retrievedProduct)
          if (retrievedProduct.imageStatus === 'valid') imageCount++
          if (retrievedProduct.enrichmentStatus === 'ready') sourceCount++
        } catch (requestError) {
          showToast(
            'error',
            `${product.title || 'Product'}: ${requestError instanceof Error ? requestError.message : 'Source data could not be retrieved.'}`,
          )
        }
      }
      const retrievedParts: string[] = []
      if (imageCount > 0) retrievedParts.push(`${imageCount} image${imageCount !== 1 ? 's' : ''}`)
      if (sourceCount > 0) retrievedParts.push(`${sourceCount} source detail${sourceCount !== 1 ? 's' : ''}`)
      if (retrievedParts.length > 0) {
        showToast('success', `Retrieved ${retrievedParts.join(' and ')} across ${toRetrieve.length} selected products.`)
      } else {
        showToast('info', `No product-specific source data was found for ${toRetrieve.length} selected products.`)
      }
    } finally {
      setRetrievingBulk(false)
    }
  }

  const retrieveLabel = (product: ProductDraft) => {
    if (!product.selected) return 'Check row first'
    if (retrievingProductId === product.id) return 'Retrieving…'
    if (
      product.enrichmentStatus === 'failed' ||
      product.enrichmentStatus === 'blocked' ||
      product.imageStatus === 'failed' ||
      product.imageStatus === 'blocked'
    )
      return 'Retry source data'
    if (product.enrichmentStatus === 'ready' || product.imageStatus === 'valid')
      return 'Retrieve again'
    return 'Retrieve source data'
  }

  const handleShowIssues = async () => {
    if (!draft) return
    setIssuesOpen(true)
    setIssuesLoading(true)
    try {
      const issues = await getIssueLog(draft.draft.id)
      setLogIssues(issues)
    } catch (requestError) {
      showToast('error', requestError instanceof Error ? requestError.message : 'The issue log could not be loaded.')
      setLogIssues([])
    } finally {
      setIssuesLoading(false)
    }
  }

  const handlePublish = async () => {
    if (!draft || !confirmPost || validSelectedProducts.length === 0) return
    setPublishing(true)
    try {
      const pendingChanges = Object.entries(dirtyFields).map(([id, productChanges]) => ({
        id,
        changes: { ...productChanges },
      }))
      const publishChanges = validSelectedProducts.reduce(
        (changes, product) => {
          const existing = changes.find((entry) => entry.id === product.id)
          if (existing) existing.changes = { ...existing.changes, selected: true }
          else changes.push({ id: product.id, changes: { selected: true } })
          return changes
        },
        pendingChanges,
      )
      const result = await publishProducts(
        draft.draft.id,
        validSelectedProducts.map((product) => product.id),
        publishChanges,
      )
      setDraft(result.draft)
      setDirtyFields((current) => {
        const remaining = { ...current }
        for (const change of pendingChanges) {
          const pending = remaining[change.id]
          if (!pending) continue
          const unresolved = Object.fromEntries(
            Object.entries(pending).filter(
              ([field, value]) =>
                change.changes[field as keyof ProductDraft] !== value,
            ),
          ) as Partial<ProductDraft>
          if (Object.keys(unresolved).length) remaining[change.id] = unresolved
          else delete remaining[change.id]
        }
        return remaining
      })
      setReviewOpen(false)
      setConfirmPost(false)
      const failed = result.results.filter(
        (entry) => entry.status === 'failed' || entry.status === 'skipped',
      ).length
      showToast(
        failed
          ? 'error'
          : 'success',
        failed
          ? `Posting finished with ${failed} row${failed === 1 ? '' : 's'} needing attention.`
          : `${result.results.length} product${result.results.length === 1 ? '' : 's'} posted to Shopify.`,
      )
    } catch (requestError) {
      showToast('error', requestError instanceof Error ? requestError.message : 'Products could not be posted.')
    } finally {
      setPublishing(false)
    }
  }

  // ── Render helpers ──
  const renderStatus = (status: string) => (
    <span className={`status status-${status}`}>{statusText[status] ?? status}</span>
  )

  const renderNumberInput = (
    label: string,
    field: 'stockOnHand' | 'casePrice' | 'unitPrice' | 'suggestedSalePrice' | 'inventoryQuantity',
    value: number | null,
  ) => {
    const isDirty =
      activeProduct && field in (dirtyFieldsFor(activeProduct.id) ?? {})
    return (
      <label className={`field ${isDirty ? 'dirty' : ''}`}>
        <span>{label}</span>
        <input
          type="number"
          min="0"
          step={field === 'inventoryQuantity' || field === 'stockOnHand' ? '1' : '0.01'}
          value={value ?? ''}
          onChange={(event) =>
            patchProduct(activeProduct!.id, {
              [field]: event.target.value === '' ? null : Number(event.target.value),
            } as Partial<ProductDraft>)
          }
        />
      </label>
    )
  }

  const renderTextInput = (
    label: string,
    field: keyof ProductDraft,
    value: string,
    isTextarea = false,
  ) => {
    const isDirty =
      activeProduct && field in (dirtyFieldsFor(activeProduct.id) ?? {})
    const commonProps = {
      value: value ?? '',
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        patchProduct(activeProduct!.id, { [field]: event.target.value } as Partial<ProductDraft>),
    }
    return (
      <label className={`field ${isDirty ? 'dirty' : ''}`}>
        <span>{label}</span>
        {isTextarea ? (
          <textarea rows={6} {...commonProps} placeholder="Fetched description or your own copy" />
        ) : (
          <input {...commonProps} />
        )}
      </label>
    )
  }

  const renderReadOnlyNumberInput = (label: string, value: number | null) => {
    return (
      <label className="field readonly">
        <span>{label}</span>
        <input type="number" min="0" value={value ?? ''} readOnly />
      </label>
    )
  }

  const renderReadOnlyTextInput = (label: string, value: string) => {
    return (
      <label className="field readonly">
        <span>{label}</span>
        <input value={value ?? ''} readOnly />
      </label>
    )
  }

  if (!draft) {
    return (
      <main className="app-shell landing-shell">
        <header className="brandbar">
          <div className="brandmark">
            <span className="brand-dot" /> CELLAR / DRIVE
          </div>
          <div className="header-actions">
            <ThemeToggle />
            <BackgroundSettings />
            {readiness && (
              <span
                className={`connection-pill ${readiness.shopifyConfigured ? 'connected' : 'disconnected'}`}
                title={
                  readiness.shopifyConfigured
                    ? 'Shopify is connected'
                    : `Shopify not configured: missing ${readiness.missing?.join(', ') ?? 'credentials'}`
                }
              >
                <span className="connection-dot" />
                {readiness.shopifyConfigured
                  ? `Shopify connected: ${readiness.storeDomain}`
                  : `Shopify not configured`}
              </span>
            )}
            {readiness && (
              <span className="version-tag" title="Application version">
                v{readiness.version}
              </span>
            )}
          </div>
        </header>
        <section className="import-hero">
          <div className="eyebrow">SUPPLIER PRODUCT DESK / 01</div>
          <h1 className="page-title">Cellar Drive product update</h1>
          <p className="hero-copy">
            Load a workbook, enrich each row from its source page, make the edits that
            matter, then post only the products you approve.
          </p>
          <label className={`upload-zone ${busy ? 'is-busy' : ''}`}>
            <input
              type="file"
              accept=".xlsx"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleImport(file)
              }}
            />
            <span className="upload-kicker">
              {startupLoading ? 'LOADING SAVED CATALOG' : busy ? 'PROCESSING WORKBOOK' : 'DROP OR CHOOSE XLSX'}
            </span>
            <strong>
              {startupLoading
                ? 'Restoring your product workspace...'
                : busy
                  ? 'Merging workbook into SQLite...'
                  : 'Upload supplier workbook'}
            </strong>
            <span>
              Check a row, then choose when its column A image and column F source page
              are retrieved.
            </span>
          </label>
          <div className="mapping-strip">
            <span>
              <b>A</b> image
            </span>
            <span>
              <b>E</b> title
            </span>
            <span>
              <b>F</b> source page
            </span>
            <span>
              <b>G</b> stock
            </span>
            <span>
              <b>I</b> case
            </span>
            <span>
              <b>J</b> unit price
            </span>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell workspace-shell">
      {/* ── Header ── */}
      <header className="brandbar">
        <div className="brandmark">
          <span className="brand-dot" /> CELLAR / DRIVE <span className="brand-context">PRODUCT DESK</span>
        </div>
        <div className="header-actions">
          <ThemeToggle />
          <BackgroundSettings />
          {readiness && (
            <span
              className={`connection-pill ${readiness.shopifyConfigured ? 'connected' : 'disconnected'}`}
              title={
                readiness.shopifyConfigured
                  ? `Shopify connected: ${readiness.storeDomain}`
                  : `Shopify not configured: missing ${readiness.missing?.join(', ') ?? 'credentials'}`
              }
            >
              <span className="connection-dot" />
              {readiness.shopifyConfigured
                ? `Connected: ${readiness.storeDomain}`
                : 'Shopify not configured'}
            </span>
            )}
            {readiness && (
              <span className="version-tag" title="Application version">
                v{readiness.version}
              </span>
            )}
          <button
            type="button"
            className="button button-primary"
            disabled={!hasUnsavedChanges || saving}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : hasUnsavedChanges ? 'Save changes' : 'Saved'}
          </button>
          <button
            type="button"
            className="button button-quiet"
            disabled={busy || publishing || saving}
            onClick={handleResetPage}
            title="Clears the visible draft, filters, selections, edits, and posting issues panel. Does NOT touch SQLite. Use Purge database to clear persisted Shopify status."
          >
            Reset page
          </button>
          <a
            className="button button-secondary"
            href={exportDraftUrl(draft.draft.id)}
            download
          >
            Export all data
          </a>
          <button
            type="button"
            className="button button-danger"
            onClick={() => {
              setPurgeOpen(true)
              setPurgeConfirmation('')
            }}
          >
            Purge database
          </button>
        </div>
      </header>

      {/* ── Workspace heading ── */}
      <section className="workspace-heading">
        <div>
          <div className="eyebrow">IMPORT / {draft.draft.filename}</div>
          <h1 className="page-title">Cellar Drive product update</h1>
          <p>Review the source data. Shape the details. Post with intent.</p>
        </div>
        <div className="status-box">
          <div className="status-item">
            <span>Rows</span><strong>{draft.draft.totalProducts.toLocaleString()}</strong>
          </div>
          <div className="status-item">
            <span>Selected</span><strong>{draft.draft.selectedProducts.toLocaleString()}</strong>
          </div>
          <div className="status-item">
            <span>Source ready</span><strong>{draft.draft.readyProducts.toLocaleString()}</strong>
          </div>
          <button
            type="button"
            className={`status-item status-button ${issuesOpen ? 'is-active' : ''}`}
            onClick={() => void handleShowIssues()}
            aria-expanded={issuesOpen}
          >
            <span>Issues</span><strong className={draft.draft.failedProducts ? 'metric-alert' : ''}>{draft.draft.failedProducts.toLocaleString()}</strong>
          </button>
        </div>
      </section>

      {/* ── Toolbar ── */}
      <section className="toolbar">
        <label className="search-field">
          <span>Search</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title or source URL"
          />
        </label>
        <label className="filter-field">
          <span>Status</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          >
            <option value="all">All rows</option>
            <option value="pending">Pending</option>
            <option value="ready">Ready</option>
            <option value="failed">Needs attention</option>
            <option value="published">Published</option>
          </select>
        </label>
        <button
          type="button"
          className="button button-secondary"
          onClick={toggleAllVisible}
        >
          {visibleProducts.every((product) => product.selected)
            ? 'Clear visible'
            : 'Select visible'}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={selectedProducts.length === 0 || clearingChecked}
          onClick={clearAllChecked}
        >
          {clearingChecked ? 'Clearing…' : `Clear all checked (${selectedProducts.length})`}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={busy || publishing || selectedProducts.filter((p) => p.sourceUrl || p.imageUrl).length === 0}
          onClick={() => void handleBulkRetrieve()}
        >
          {retrievingBulk ? 'Retrieving…' : `Retrieve source data (${selectedProducts.filter((p) => p.sourceUrl || p.imageUrl).length})`}
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={validSelectedProducts.length === 0 || publishing}
          onClick={() => setReviewOpen(true)}
        >
          {publishing ? 'Posting…' : `Post selected (${validSelectedProducts.length})`}
        </button>
      </section>

      {/* ── Filter bar ── */}
      <section className="filter-bar" aria-label="Column filters">
        <div className="filter-bar-label">
          <span>Filter columns</span>
          <small>
            {Object.values(columnFilters).reduce(
              (total, values) => total + (values?.length ?? 0),
              0,
            )}{' '}
            active
          </small>
        </div>
        {filterFields.map(({ field, label }) => (
          <FilterMenu
            key={field}
            label={label}
            options={filterOptions[field]}
            selected={columnFilters[field] ?? []}
            onChange={(values) =>
              setColumnFilters((current) => ({ ...current, [field]: values }))
            }
          />
        ))}
        <label className="filter-field title-sort">
          <span>Sort</span>
          <select
            value={sortOption}
            onChange={(event) => setSortOption(event.target.value as SortOption)}
          >
            <option value="none">Original order</option>
            <option value="selected">Checked items first</option>
            <option value="title-asc">Title A→Z</option>
            <option value="title-desc">Title Z→A</option>
            <option value="source">Source status</option>
            <option value="shopify">Shopify status</option>
          </select>
        </label>
        <button
          type="button"
          className="text-button"
          disabled={
            Object.keys(columnFilters).length === 0 && sortOption === 'none'
          }
          onClick={() => {
            setColumnFilters({})
            setSortOption('none')
          }}
        >
          Clear filters
        </button>
      </section>

      {/* ── Table + Editor ── */}
      <section className="workspace-grid">
        <div className="table-panel">
          <div className="table-meta">
            <span>{filteredProducts.length.toLocaleString()} matching rows</span>
            <span>
              Page {page} of {pageCount}
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="check-column">
                    <input
                      type="checkbox"
                      checked={
                        visibleProducts.length > 0 &&
                        visibleProducts.every((product) => product.selected)
                      }
                      onChange={toggleAllVisible}
                      aria-label="Select all visible products"
                    />
                  </th>
                  <th>Product</th>
                  <th>Unit / case</th>
                  <th>Sale price</th>
                  <th>Stock</th>
                  <th>Source</th>
                  <th>Shopify</th>
                  <th>Source data</th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((product) => (
                  <tr
                    key={product.id}
                    className={activeProduct?.id === product.id ? 'is-active' : ''}
                    onClick={() => setActiveProductId(product.id)}
                  >
                    <td
                      className="check-column"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={product.selected}
                        onChange={(event) =>
                          patchProduct(product.id, {
                            selected: event.target.checked,
                          })
                        }
                        aria-label={`Select ${product.title}`}
                      />
                    </td>
                    <td>
                      <div className="product-cell">
                        <div className="thumb">
                          {product.imageLocalUrl ? (
                            <img src={product.imageLocalUrl} alt="" loading="lazy" />
                          ) : (
                            <span>{product.imageStatus === 'pending' ? '…' : 'IMG'}</span>
                          )}
                        </div>
                        <div>
                          <strong>{product.title || 'Untitled product'}</strong>
                          <small>
                            Row {product.rowNumber}{' '}
                            {product.validationErrors.length
                              ? ` / ${product.validationErrors.length} issue${product.validationErrors.length === 1 ? '' : 's'}`
                              : ''}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <strong>{money(product.unitPrice)}</strong>
                      <small>{money(product.casePrice)} case</small>
                    </td>
                    <td><strong>{money(product.suggestedSalePrice)}</strong></td>
                    <td>{product.stockOnHand ?? '—'}</td>
                    <td>{renderStatus(product.enrichmentStatus)}</td>
                    <td>{renderStatus(product.publishStatus)}</td>
                    <td className="source-action" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="row-action"
                        disabled={
                          busy ||
                          !product.selected ||
                          (!product.sourceUrl && !product.imageUrl)
                        }
                        onClick={() => void handleRetrieve(product)}
                      >
                        {retrieveLabel(product)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleProducts.length === 0 && (
              <div className="empty-state">No products match this view.</div>
            )}
          </div>
          <div className="pagination">
            <button
              type="button"
              className="button button-secondary"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>
            <span>
              {page} / {pageCount}
            </span>
            <button
              type="button"
              className="button button-secondary"
              disabled={page >= pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            >
              Next
            </button>
          </div>
        </div>

        {/* ── Editor ── */}
        <aside className="editor-panel">
          {activeProduct ? (
            <>
              <div className="editor-header">
                <div>
                  <div className="eyebrow">ROW {activeProduct.rowNumber}</div>
                  <h2>Product detail</h2>
                </div>
                {renderStatus(activeProduct.enrichmentStatus)}
              </div>

              <div className="field-group">
                <div className="field-group-heading">
                  <div className="eyebrow">SUPPLIER DATA</div>
                  <span>Read-only</span>
                </div>
                <div className="field-grid">
                  {renderReadOnlyTextInput('Product Title', activeProduct.title)}
                  {renderReadOnlyNumberInput('Unit price', activeProduct.unitPrice)}
                  {renderReadOnlyNumberInput('Case price', activeProduct.casePrice)}
                  {renderReadOnlyNumberInput(
                    'Supplier stock on hand',
                    activeProduct.stockOnHand ?? null,
                  )}
                </div>
              </div>

              <div className="field-group">
                <div className="field-group-heading">
                  <div className="eyebrow">APP DATA</div>
                  <span>Editable</span>
                </div>
                <div className="field-grid">
                  {renderNumberInput(
                    'Suggested sale price',
                    'suggestedSalePrice',
                    activeProduct.suggestedSalePrice,
                  )}
                  {renderNumberInput(
                    'Shopify inventory',
                    'inventoryQuantity',
                    activeProduct.inventoryQuantity,
                  )}
                </div>
              </div>

              <div className="source-line">
                <span>Source page</span>
                {activeProduct.sourceUrl ? (
                  <a href={activeProduct.sourceUrl} target="_blank" rel="noreferrer">
                    Open source
                  </a>
                ) : (
                  <em>Not provided</em>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={
                    busy ||
                    !activeProduct.selected ||
                    (!activeProduct.sourceUrl && !activeProduct.imageUrl)
                  }
                  onClick={() => void handleRetrieve(activeProduct)}
                >
                  {retrieveLabel(activeProduct)}
                </button>
              </div>

              <div
                className={`featured-row ${'featured' in (dirtyFieldsFor(activeProduct.id) ?? {}) || 'publishToOnlineStore' in (dirtyFieldsFor(activeProduct.id) ?? {}) ? 'dirty' : ''}`}
              >
                <div className="publish-checkboxes">
                  <label>
                    <input
                      type="checkbox"
                      checked={activeProduct.featured}
                      onChange={(event) =>
                        patchProduct(activeProduct.id, {
                          featured: event.target.checked,
                        })
                      }
                      aria-label="Flag as featured"
                    />
                    <span>Featured</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={activeProduct.publishToOnlineStore}
                      onChange={(event) =>
                        patchProduct(activeProduct.id, {
                          publishToOnlineStore: event.target.checked,
                        })
                      }
                      aria-label="Publish to Online Store sales channel"
                    />
                    <span>Online Store</span>
                  </label>
                </div>
                <small>
                  When published, the product is added to the Featured Collection
                  on Shopify.
                </small>
                <small>
                  When checked, the product is published to the Online Store sales
                  channel on Shopify.
                </small>
              </div>

              {/* ── About this product ── */}
              <div className="about-heading">
                <div>
                  <div className="eyebrow">CONTENT BLOCK</div>
                  <h3>About this product</h3>
                </div>
                <span>Editable</span>
              </div>

              {/* ── Image details ── */}
              <section className="image-details" aria-label="Retrieved image details">
                <div className="image-details-heading">
                  <span>Image details</span>
                  {renderStatus(activeProduct.imageStatus)}
                </div>
                <div className="image-details-body">
                  <div className="editor-image">
                    {activeProduct.imageLocalUrl ? (
                      <img
                        src={activeProduct.imageLocalUrl}
                        alt={`Retrieved image for ${activeProduct.title}`}
                      />
                    ) : (
                      <span>
                        {activeProduct.imageStatus === 'pending'
                          ? 'Not retrieved'
                          : 'No saved image'}
                      </span>
                    )}
                  </div>
                  <dl className="image-meta">
                    <div>
                      <dt>Column A source</dt>
                      <dd>
                        {activeProduct.imageUrl ? (
                          <a
                            href={activeProduct.imageUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open image source
                          </a>
                        ) : (
                          'Not provided'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Saved file</dt>
                      <dd>{activeProduct.imageLocalFilename || 'Not retrieved'}</dd>
                    </div>
                    <div>
                      <dt>Retrieval</dt>
                      <dd>
                        {activeProduct.imageStatus === 'valid'
                          ? 'Downloaded to productimage'
                          : 'Available after source retrieval'}
                      </dd>
                    </div>
                  </dl>
                </div>
              </section>

              {activeProduct.enrichmentError && (
                <p className="source-error">Source retrieval: {activeProduct.enrichmentError}</p>
              )}
              {activeProduct.publishError && (
                <div className="validation-box publish-issue">
                  <strong>Shopify needs attention</strong>
                  <span>{activeProduct.publishError}</span>
                </div>
              )}

              {renderTextInput(
                'Description',
                'descriptionHtml',
                activeProduct.descriptionHtml,
                true,
              )}

              <div className="detail-fields">
                {(['brand', 'country', 'region', 'productType', 'abv', 'containerType', 'style'] as const).map(
                  (field) => (
                    <label
                      className={`field ${field in (dirtyFieldsFor(activeProduct.id) ?? {}) ? 'dirty' : ''}`}
                      key={field}
                    >
                      <span>
                        {field === 'abv'
                          ? 'ABV %'
                          : field === 'productType'
                            ? 'Product Type'
                            : field === 'containerType'
                              ? 'Container Type'
                              : field[0].toLocaleUpperCase() + field.slice(1)}
                      </span>
                      <input
                        value={activeProduct[field]}
                        onChange={(event) =>
                          patchProduct(activeProduct.id, {
                            [field]: event.target.value,
                          } as Partial<ProductDraft>)
                        }
                      />
                    </label>
                  ),
                )}
              </div>

              {activeProduct.validationErrors.length > 0 && (
                <div className="validation-box">
                  <strong>Needs attention</strong>
                  {activeProduct.validationErrors.map((validationError) => (
                    <span key={validationError}>{validationError}</span>
                  ))}
                </div>
              )}

              {hasUnsavedChanges && (
                <div className="field-hint">
                  You have {Object.keys(dirtyFields).length} product
                  {Object.keys(dirtyFields).length === 1 ? '' : 's'} with unsaved changes.
                  Press Save to persist.
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">Choose a product to edit.</div>
          )}
        </aside>
      </section>

      {/* ── Issues log ── */}
      {issuesOpen && (
        <section className="issues-log" aria-labelledby="issues-title">
          <div className="issues-heading">
            <div>
              <div className="eyebrow">ISSUES LOG / LOG FILE</div>
              <h2 id="issues-title">
                {issuesLoading
                  ? 'Loading log issues...'
                  : logIssues.length
                    ? `${logIssues.length.toLocaleString()} recent log issue${logIssues.length === 1 ? '' : 's'}`
                    : issueProducts.length
                      ? `${issueProducts.length.toLocaleString()} product${issueProducts.length === 1 ? '' : 's'} need attention`
                      : 'No active issues'}
              </h2>
            </div>
            <div className="issues-actions">
              <span>logs/ecomint.log</span>
              <button
                type="button"
                className="text-button"
                disabled={issuesLoading}
                onClick={() => void handleShowIssues()}
              >
                Refresh log
              </button>
            </div>
          </div>

          {issuesLoading && <p className="issue-overflow">Reading failure entries for this draft.</p>}

          {!issuesLoading && logIssues.length > 0 && (
            <div className="issue-list">
              {logIssues.map((issue, index) => {
                const productId =
                  typeof issue.details.productId === 'string'
                    ? issue.details.productId
                    : null
                const product = productId
                  ? draft?.products.find((entry) => entry.id === productId)
                  : null
                return (
                  <article className="issue-entry" key={`${issue.timestamp}-${issue.event}-${index}`}>
                    {product ? (
                      <button
                        type="button"
                        className="issue-product"
                        onClick={() => {
                          setActiveProductId(product.id)
                          setIssuesOpen(false)
                        }}
                      >
                        <strong>{product.title || 'Untitled product'}</strong>
                        <small>
                          Row {product.rowNumber} /{' '}
                          {statusText[product.publishStatus] ?? product.publishStatus}
                        </small>
                      </button>
                    ) : (
                      <div className="issue-product">
                        <strong>{issue.event}</strong>
                        <small>{new Date(issue.timestamp).toLocaleString()}</small>
                      </div>
                    )}
                    <div className="issue-details">
                      <p>
                        <strong>Event:</strong> {issue.event}
                      </p>
                      <p>
                        <strong>Time:</strong> {new Date(issue.timestamp).toLocaleString()}
                      </p>
                      {Object.entries(issue.details).map(([key, value]) => (
                        <p key={key}>
                          <strong>{key}:</strong> {logDetailValue(value)}
                        </p>
                      ))}
                    </div>
                  </article>
                )
              })}
            </div>
          )}

          {issueProducts.length > 0 && (
            <div className="issues-subheading">
              <div className="eyebrow">CATALOG DETAILS</div>
              <span>Current status stored with each product</span>
            </div>
          )}

          {issueProducts.length > 0 && (
            <div className="issue-list">
              {issueProducts.slice(0, 100).map((product) => (
                <article className="issue-entry" key={product.id}>
                  <button
                    type="button"
                    className="issue-product"
                    onClick={() => setActiveProductId(product.id)}
                  >
                    <strong>{product.title || 'Untitled product'}</strong>
                    <small>
                      Row {product.rowNumber} /{' '}
                      {statusText[product.publishStatus] ?? product.publishStatus}
                    </small>
                  </button>
                  <div className="issue-details">
                    {product.publishError && (
                      <p>
                        <strong>Shopify:</strong> {product.publishError}
                      </p>
                    )}
                    {product.enrichmentError && (
                      <p>
                        <strong>Source retrieval:</strong> {product.enrichmentError}
                      </p>
                    )}
                    {product.validationErrors.map((validationError) => (
                      <p key={validationError}>
                        <strong>Validation:</strong> {validationError}
                      </p>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}

          {issueProducts.length > 100 && (
            <p className="issue-overflow">
              Showing the first 100 issues. Export all data for the complete working set.
            </p>
          )}
        </section>
      )}

      {/* ── Import errors ── */}
      {importErrors.length > 0 && (
        <details className="import-errors">
          <summary>{importErrors.length.toLocaleString()} import warnings</summary>
          <div>
            {importErrors.slice(0, 100).map((importError) => (
              <p key={importError}>{importError}</p>
            ))}
            {importErrors.length > 100 && (
              <p>Showing the first 100 warnings. Export all data for the complete working set.</p>
            )}
          </div>
        </details>
      )}

      {/* ── Publish review modal ── */}
      {reviewOpen && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-title"
          >
            <div className="eyebrow">FINAL CHECK</div>
            <h2 id="review-title">
              Post {validSelectedProducts.length} selected product
              {validSelectedProducts.length === 1 ? '' : 's'}?
            </h2>
            <p>
              Suggested sale price and Shopify inventory will be sent to the
              configured Shopify location.
            </p>
            <div className="review-list">
              {validSelectedProducts.slice(0, 8).map((product) => (
                <div key={product.id}>
                  <span>{product.title}</span>
                  <strong>
                    {money(product.suggestedSalePrice)} / {product.inventoryQuantity}{' '}
                    units
                  </strong>
                </div>
              ))}
              {validSelectedProducts.length > 8 && (
                <small>Plus {validSelectedProducts.length - 8} more selected products.</small>
              )}
            </div>
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={confirmPost}
                onChange={(event) => setConfirmPost(event.target.checked)}
              />
              I confirm these selected products are ready to post.
            </label>
            <small className="note">
              Images are added to new (created) products only. Existing matched products
              are updated without image changes. To clear persisted Shopify status from
              prior publishes, use Purge database.
            </small>
            <div className="modal-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setReviewOpen(false)
                  setConfirmPost(false)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={!confirmPost || publishing}
                onClick={() => void handlePublish()}
              >
                {publishing ? 'Posting…' : 'Confirm and post'}
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── Purge modal ── */}
      {purgeOpen && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="purge-title"
          >
            <div className="eyebrow">DESTRUCTIVE ACTION</div>
            <h2 id="purge-title">Purge the database?</h2>
            <p>
              This removes catalog products, publish history, cached source data, and
              downloaded product images. The operation cannot be undone. Type{' '}
              <strong>PURGE</strong> to continue.
            </p>
            <label className="field">
              <span>Confirmation</span>
              <input
                value={purgeConfirmation}
                onChange={(event) => setPurgeConfirmation(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setPurgeOpen(false)
                  setPurgeConfirmation('')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-danger"
                disabled={purgeConfirmation !== 'PURGE' || busy}
                onClick={() => void handlePurge()}
              >
                {busy ? 'Purging…' : 'Purge database'}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  )
}

export default App
