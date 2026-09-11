import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, Dispatch, SetStateAction } from 'react'
import {
  exportDraftUrl,
  getIssueLog,
  getCurrentDraft,
  getCurrentDraftBySupplier,
  getCurrentUser,
  getReadiness,
  getProductsLoad,
  importWorkbook,
  loginUser,
  logoutUser,
  publishProducts,
  purgeDatabase,
  registerUser,
  downloadProductImage,
  downloadProductImages,
  retrieveProduct,
  saveProducts,
  updateProduct,
  type DraftResponse,
  type LogIssue,
  type ProductsLoadEntry,
  type ProductDraft,
  type ReadinessStatus,
} from './api'
import { ToastProvider, useToast } from './components/Toast'
import './App.css'
import './workspace.css'

const PAGE_SIZE = 40
type StatusFilter = 'all' | 'pending' | 'ready' | 'failed' | 'published'
type SortOption = 'none' | 'selected' | 'title-asc' | 'title-desc' | 'source' | 'shopify'
type FilterField = 'title' | 'unitPrice' | 'suggestedSalePrice' | 'casePrice' | 'stockOnHand' | 'inventoryQuantity' | 'supplierType' | 'imageStatus' | 'enrichmentStatus' | 'publishStatus' | 'description'
type FilterKind = 'select' | 'range' | 'text'
type RangeOperator = '>' | '<' | '>=' | '<=' | '=' | '!='

interface FilterFieldConfig {
  field: FilterField
  label: string
  kind: FilterKind
}

type ColumnFilterValue =
  | { kind: 'select'; values: string[] }
  | { kind: 'range'; operator: RangeOperator; value: string }
  | { kind: 'text'; pattern: string }

const filterFieldConfig: FilterFieldConfig[] = [
  { field: 'title', label: 'Product', kind: 'select' },
  { field: 'unitPrice', label: 'Unit price', kind: 'range' },
  { field: 'suggestedSalePrice', label: 'Sale price', kind: 'range' },
  { field: 'casePrice', label: 'Case price', kind: 'range' },
  { field: 'stockOnHand', label: 'Stock', kind: 'range' },
  { field: 'inventoryQuantity', label: 'Inventory', kind: 'range' },
  { field: 'supplierType', label: 'Type', kind: 'select' },
  { field: 'imageStatus', label: 'Image', kind: 'select' },
  { field: 'enrichmentStatus', label: 'Source', kind: 'select' },
  { field: 'publishStatus', label: 'Status', kind: 'select' },
  { field: 'description', label: 'Description', kind: 'text' },
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
  if (field === 'supplierType') return product.supplierType || '—'
  if (field === 'imageStatus') return statusText[product.imageStatus] ?? product.imageStatus
  if (field === 'enrichmentStatus') return statusText[product.enrichmentStatus] ?? product.enrichmentStatus
  if (field === 'publishStatus') return statusText[product.publishStatus] ?? product.publishStatus
  return product.descriptionHtml || ''
}

const numericFilterValue = (product: ProductDraft, field: FilterField): number | null => {
  if (field === 'unitPrice') return product.unitPrice
  if (field === 'suggestedSalePrice') return product.suggestedSalePrice
  if (field === 'casePrice') return product.casePrice
  if (field === 'stockOnHand') return product.stockOnHand
  if (field === 'inventoryQuantity') return product.inventoryQuantity
  return null
}

const compareRange = (value: number | null, operator: RangeOperator, target: number | null): boolean => {
  if (value === null || target === null || Number.isNaN(target)) return false
  if (operator === '>') return value > target
  if (operator === '<') return value < target
  if (operator === '>=') return value >= target
  if (operator === '<=') return value <= target
  if (operator === '=') return value === target
  return value !== target
}

const matchesTextPattern = (text: string, pattern: string): boolean => {
  if (!pattern.trim()) return true
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '.')
    .replace(/\*/g, '.*')
  return new RegExp(`^${regex}$`, 'i').test(text)
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

interface RangeFilterProps {
  label: string
  value: { operator: RangeOperator; value: string }
  onChange: (value: { operator: RangeOperator; value: string }) => void
}

function RangeFilter({ label, value, onChange }: RangeFilterProps) {
  return (
    <details className="column-filter">
      <summary>
        {label}
        {value.value && <span className="filter-count">1</span>}
      </summary>
      <div className="range-popover">
        <select
          value={value.operator}
          onChange={(event) => onChange({ operator: event.target.value as RangeOperator, value: value.value })}
          aria-label={`Comparison operator for ${label}`}
        >
          <option value=">">{'>'}</option>
          <option value="<">{'<'}</option>
          <option value=">=">{'>='}</option>
          <option value="<=">{'<='}</option>
          <option value="=">{'='}</option>
          <option value="!=">{'≠'}</option>
        </select>
        <input
          type="number"
          value={value.value}
          onChange={(event) => onChange({ operator: value.operator, value: event.target.value })}
          placeholder="Value…"
          aria-label={`Numeric value for ${label}`}
        />
        {value.value && (
          <button
            type="button"
            className="text-button"
            onClick={() => onChange({ operator: value.operator, value: '' })}
          >
            Clear {label}
          </button>
        )}
      </div>
    </details>
  )
}

interface TextFilterProps {
  label: string
  pattern: string
  onChange: (pattern: string) => void
}

function TextFilter({ label, pattern, onChange }: TextFilterProps) {
  return (
    <details className="column-filter">
      <summary>
        {label}
        {pattern && <span className="filter-count">1</span>}
      </summary>
      <div className="text-popover">
        <input
          value={pattern}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Use * and ? wildcards…"
          aria-label={`Text pattern for ${label}`}
        />
        {pattern && (
          <button
            type="button"
            className="text-button"
            onClick={() => onChange('')}
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

interface RichTextEditorProps {
  label: string
  field: string
  productId: string
  value: string
  isDirty: boolean
  setDirtyFields: Dispatch<SetStateAction<Record<string, Partial<ProductDraft>>>>
  placeholder?: string
}

const headingOptions = [
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'h1', label: 'H1' },
  { value: 'h2', label: 'H2' },
  { value: 'h3', label: 'H3' },
] as const

function RichTextEditor({ label, field, productId, value, isDirty, setDirtyFields, placeholder = 'Type here…' }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null)
  const committedHtmlRef = useRef<string>('')
  const isFocusedRef = useRef(false)

  // Sync external state into the editor without disrupting focus.
  // While the user is typing, onInput updates committedHtmlRef (a ref, not
  // state) so React never re-renders the contentEditable mid-stroke.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (isFocusedRef.current) return
    if (value !== committedHtmlRef.current) {
      editor.innerHTML = value
      committedHtmlRef.current = value
    }
  }, [productId, value])

  const execFormat = (command: string, commandValue?: string) => {
    document.execCommand(command, false, commandValue)
    const editor = editorRef.current
    if (editor) {
      committedHtmlRef.current = editor.innerHTML
      // Toolbar buttons use onMouseDown={e => e.preventDefault()} to keep
      // focus in the editor, so a synchronous dirty-field update is safe.
      setDirtyFields((current) => ({
        ...current,
        [productId]: {
          ...(current[productId] ?? {}),
          [field]: editor.innerHTML,
        },
      }))
    }
  }

  const insertImage = () => {
    const url = window.prompt('Enter image URL:')
    if (url) execFormat('insertImage', url)
  }

  const changeHeading = (e: ChangeEvent<HTMLSelectElement>) => {
    const tag = e.target.value
    execFormat('formatBlock', tag === 'paragraph' ? '<p>' : `<${tag}>`)
    e.target.value = 'paragraph'
  }

  const insertInlineCode = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const text = selection.toString()
    if (!text) return
    execFormat('insertHTML', `<code>${text}</code>`)
  }

  const insertBlock = (tag: string) => {
    execFormat('formatBlock', `<${tag}>`)
  }

  // VIC-20: Use a <div> instead of <label> here. A <label> wraps both the
  // toolbar buttons (labelable descendants) and the contentEditable editor.
  // Clicking the editor triggers the label's activation behavior, which
  // dispatches a synthetic click on the first labelable descendant (the Bold
  // button), immediately stealing focus from the contentEditable div. A <div>
  // has no such behavior, so clicks on the editor stay in the editor.
  return (
    <div className={`field ${isDirty ? 'dirty' : ''}`}>
      <span>{label}</span>
      <div className={`rich-text-editor ${isDirty ? 'dirty' : ''}`}>
        <div className="rich-text-toolbar">
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('undo')} title="Undo">↶</button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('redo')} title="Redo">↷</button>
          <span className="rtb-sep" />
          <select
            className="rtb-select"
            defaultValue="paragraph"
            onMouseDown={(e) => e.preventDefault()}
            onChange={changeHeading}
            title="Block style"
          >
            {headingOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <span className="rtb-sep" />
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('bold')} title="Bold"><b>B</b></button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('italic')} title="Italic"><i>I</i></button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('underline')} title="Underline"><u>U</u></button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('strikeThrough')} title="Strikethrough"><s>S</s></button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={insertInlineCode} title="Inline code"><code>{`{}`}</code></button>
          <span className="rtb-sep" />
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('insertUnorderedList')} title="Bullet list">•≡</button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('insertOrderedList')} title="Numbered list">1.</button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => insertBlock('blockquote')} title="Blockquote">“”</button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => insertBlock('pre')} title="Code block">≣</button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('insertHorizontalRule')} title="Horizontal rule">―</button>
          <span className="rtb-sep" />
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('justifyLeft')} title="Align left">←</button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('justifyCenter')} title="Align center">≡</button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('justifyRight')} title="Align right">→</button>
          <span className="rtb-sep" />
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('createLink', 'https://')} title="Link">🔗</button>
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={insertImage} title="Insert image">🖼</button>
          <span className="rtb-sep" />
          <button type="button" className="rtb-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => execFormat('removeFormat')} title="Clear formatting">✕</button>
        </div>
        <div
          ref={editorRef}
          className="rich-text-area"
          contentEditable="true"
          suppressContentEditableWarning
          data-placeholder={placeholder}
          tabIndex={0}
          onFocus={() => { isFocusedRef.current = true }}
          onBlur={() => {
            isFocusedRef.current = false
            const editor = editorRef.current
            if (editor && committedHtmlRef.current !== editor.innerHTML) {
              committedHtmlRef.current = editor.innerHTML
              setDirtyFields((current) => ({
                ...current,
                [productId]: {
                  ...(current[productId] ?? {}),
                  [field]: editor.innerHTML,
                },
              }))
            }
          }}
          onInput={() => {
            const editor = editorRef.current
            if (editor) {
              committedHtmlRef.current = editor.innerHTML
              setDirtyFields((current) => ({
                ...current,
                [productId]: {
                  ...(current[productId] ?? {}),
                  [field]: editor.innerHTML,
                },
              }))
            }
          }}
        />
      </div>
    </div>
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
  const [columnFilters, setColumnFilters] = useState<Partial<Record<FilterField, ColumnFilterValue>>>({})
  const [page, setPage] = useState(1)
  const [activeProductId, setActiveProductId] = useState<string | null>(null)
  const [browsingProductId, setBrowsingProductId] = useState<string | null>(null)
  const browserWindowRef = useRef<Window | null>(null)
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
  // VIC-20 Issue 7: Image download state used by the explicit Download image
  // button for retries (images are also auto-downloaded during Retrieve source data).
  const [downloadingImageId, setDownloadingImageId] = useState<string | null>(null)
  // VIC-24: Auto-download images for visible products without user interaction.
  const [autoDownloadingIds, setAutoDownloadingIds] = useState<Set<string>>(new Set())
  const imageCheckedIdsRef = useRef(new Set<string>())
  const [issuesOpen, setIssuesOpen] = useState(false)
  const [issuesLoading, setIssuesLoading] = useState(false)
  const [logIssues, setLogIssues] = useState<LogIssue[]>([])
  const [productsLoadOpen, setProductsLoadOpen] = useState(false)
  const [productsLoadLoading, setProductsLoadLoading] = useState(false)
  const [productsLoadEntries, setProductsLoadEntries] = useState<ProductsLoadEntry[]>([])
  const [readiness, setReadiness] = useState<ReadinessStatus | null>(null)
  const [clearingChecked, setClearingChecked] = useState(false)
  const [globalCollectionIds, setGlobalCollectionIds] = useState<string[]>([])
  const [globalCategoryIds, setGlobalCategoryIds] = useState<string[]>([])
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authLoading, setAuthLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [supplier, setSupplier] = useState<'cellar' | 'vican' | ''>('')
  const [pendingSupplier, setPendingSupplier] = useState<'cellar' | 'vican' | '' | null>(null)

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
    const checkSession = async () => {
      try {
        const result = await getCurrentUser()
        if (mounted && result.authenticated && result.user) {
          setIsLoggedIn(true)
        } else if (mounted && !result.authenticated) {
          // Auto-login on first run with default admin credentials
          try {
            const loginResult = await loginUser('admin', 'admin')
            if (loginResult.ok) {
              setIsLoggedIn(true)
              showToast('info', 'Automatically logged in with default admin account.')
            }
          } catch {
            setIsLoggedIn(false)
          }
        }
      } catch {
        setIsLoggedIn(false)
      }
    }
    void checkSession()
    // VIC-23: Do NOT auto-load a draft on startup. Only get readiness (version + config).
    // Draft loading is deferred until the user selects a supplier and clicks Apply.
    void getReadiness()
      .then((status) => {
        if (mounted) setReadiness(status)
      })
      .catch(() => {
        if (mounted) setReadiness(null)
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
  // VIC-20 Issue 5: Case price filter is not applicable for vican (no case pricing)
  const activeFilterConfig = useMemo(
    () => filterFieldConfig.filter((config) => supplier !== 'vican' || config.field !== 'casePrice'),
    [supplier],
  )
  const filterOptions = useMemo(() => {
    const products = draft?.products ?? []
    return Object.fromEntries(
      activeFilterConfig
        .filter(({ kind }) => kind === 'select')
        .map(({ field }) => [
          field,
          Array.from(
            new Set(products.map((product) => filterValue(product, field))),
          ).sort((left, right) => left.localeCompare(right)),
        ]),
    ) as Partial<Record<FilterField, string[]>>
  }, [draft?.products, activeFilterConfig])

  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const filtered = (draft?.products ?? []).filter((product) => {
      // VIC-18: Only show products matching the active supplier
      if (product.supplier && product.supplier !== supplier) return false
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
      const matchesColumns = activeFilterConfig.every(({ field, kind }) => {
        const filter = columnFilters[field]
        if (!filter) return true
        if (kind === 'select') {
          const values = (filter as { kind: 'select'; values: string[] }).values
          return values.length === 0 || values.includes(filterValue(product, field))
        }
        if (kind === 'range') {
          const { operator, value } = filter as { kind: 'range'; operator: RangeOperator; value: string }
          if (!value) return true
          return compareRange(numericFilterValue(product, field), operator, Number(value))
        }
        const pattern = (filter as { kind: 'text'; pattern: string }).pattern
        return matchesTextPattern(filterValue(product, field), pattern)
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

  // VIC-18: When the supplier filter changes, reset the active product to the
  // first matching item so both the list and detail panel reflect the selected supplier.
  // Only reset when the active product is no longer in the filtered list, so that
  // routine draft updates (e.g. after Retrieve) don't cause the detail pane to
  // jump back to the first product.
  useEffect(() => {
    if (!draft) return
    const firstId = filteredProducts[0]?.id
    const activeStillVisible = filteredProducts.some((p) => p.id === activeProductId)
    if (firstId && (!activeProductId || !activeStillVisible)) {
      setActiveProductId(firstId)
      setPage(1)
    }
  }, [supplier, draft, filteredProducts])

  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE))
  const visibleProducts = filteredProducts.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  )
  const browsingProduct = visibleProducts.find((p) => p.id === browsingProductId) ?? null

  // VIC-24: Auto-download images for visible products that lack a local image.
  // Runs when the visible page changes (pagination, filter, etc.) or when
  // a new draft is loaded. Products already in imageCheckedIdsRef are skipped
  // to avoid redundant downloads when navigating back to a previously-viewed page.
  useEffect(() => {
    if (!draft?.draft) return
    const needsDownload = visibleProducts.filter(
      (p) =>
        p.imageUrl &&
        p.imageStatus !== 'valid' &&
        !p.imageLocalUrl &&
        !imageCheckedIdsRef.current.has(p.id),
    )
    if (needsDownload.length === 0) return

    // Mark these IDs as checked immediately to prevent duplicate triggers
    needsDownload.forEach((p) => imageCheckedIdsRef.current.add(p.id))
    setAutoDownloadingIds(new Set(needsDownload.map((p) => p.id)))

    const draftId = draft.draft.id
    void downloadProductImages(draftId, needsDownload.map((p) => p.id))
      .then((updatedProducts) => {
        // Merge updated products into the draft
        const updatedMap = new Map(updatedProducts.map((p) => [p.id, p]))
        setDraft((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            products: prev.products.map((p) => updatedMap.get(p.id) ?? p),
          }
        })
      })
      .catch((error: unknown) => {
        showToast('error', error instanceof Error ? error.message : 'Some product images could not be downloaded automatically.')
      })
      .finally(() => {
        setAutoDownloadingIds(new Set())
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleProducts.map((p) => p.id).join(','), draft?.draft?.id])

  // Clear the image-checked tracking set when the draft changes
  useEffect(() => {
    imageCheckedIdsRef.current.clear()
  }, [draft?.draft?.id])

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
      const result = await importWorkbook(file, supplier)
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
      setRetrievingProductId(null)
      setDownloadingImageId(null)
      setGlobalCategoryIds([])
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
    setDownloadingImageId(null)
    setIssuesOpen(false)
    setLogIssues([])
    setPurgeOpen(false)
    setPurgeConfirmation('')
    setGlobalCollectionIds([])
    setGlobalCategoryIds([])
  }

  // VIC-22: When switching suppliers, try to restore a saved draft for the
  // new supplier from SQLite. Only clear to the upload page if no matching
  // draft exists.
  const handleSupplierSwitch = async (newSupplier: 'cellar' | 'vican') => {
    setSupplier(newSupplier)
    setPendingSupplier(null)
    setGlobalCategoryIds([])
    setGlobalCollectionIds([])
    try {
      const currentDraft = await getCurrentDraftBySupplier(newSupplier)
      if (currentDraft) {
        setDraft(currentDraft)
        setActiveProductId(currentDraft.products[0]?.id ?? null)
        setDirtyFields({})
        setImportErrors([])
        showToast('info', `${currentDraft.products.length.toLocaleString()} products restored from SQLite.`)
      } else {
        clearTransientState()
        showToast('info', `Switched to ${newSupplier === 'vican' ? 'Vican Visions' : 'Cellar Drive'}`)
      }
    } catch {
      clearTransientState()
      showToast('info', `Switched to ${newSupplier === 'vican' ? 'Vican Visions' : 'Cellar Drive'}`)
    }
  }

  const handleResetPage = () => {
    if (hasUnsavedChanges && !confirm('You have unsaved changes. Start a new workbook import and discard them?')) return
    clearTransientState()
    showToast('info', 'Page reset. Choose a workbook to start fresh.')
  }

  const handleLogout = async () => {
    try {
      await logoutUser()
    } catch {
      // Ignore logout errors
    }
    setIsLoggedIn(false)
    setUsername('')
    setPassword('')
    setAuthError('')
    clearTransientState()
    showToast('info', 'Logged out successfully.')
  }

  const handleAuthSubmit = async () => {
    setAuthLoading(true)
    setAuthError('')
    try {
      if (authMode === 'login') {
        const result = await loginUser(username, password)
        if (result.ok) {
          setIsLoggedIn(true)
          showToast('success', `Welcome back, ${result.user.username}.`)
        }
      } else {
        await registerUser(username, password)
        showToast('success', 'Account created. Please log in.')
        setAuthMode('login')
      }
    } catch (requestError) {
      setAuthError(requestError instanceof Error ? requestError.message : 'Authentication failed.')
    } finally {
      setAuthLoading(false)
    }
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
    setGlobalCollectionIds([])
    setGlobalCategoryIds([])
    setClearingChecked(false)
  }

  const handleRetrieve = async (product: ProductDraft) => {
    if (!draft || !product.sourceUrl) return
    setActiveProductId(product.id)
    setRetrievingProductId(product.id)
    setBusy(true)
    try {
      const retrievedProduct = await retrieveProduct(draft.draft.id, product.id)
      replaceProduct(retrievedProduct)
      // Retrieve source content also downloads the main product image
      // so the detail pane is immediately populated with both content and image.
      // The explicit Download image button remains for retrying image-only fetches.
      if (retrievedProduct.imageUrl && retrievedProduct.imageStatus !== 'valid') {
        try {
          const imageResult = await downloadProductImage(draft.draft.id, product.id)
          replaceProduct(imageResult)
        } catch {
          // Image download failure is non-fatal — source content was still retrieved
        }
      }
      if (retrievedProduct.enrichmentStatus === 'ready')
        showToast('success', `Source details retrieved for ${product.title || 'the selected product'}.`)
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

  // VIC-20 Issue 7: Explicit image download action for retries.
  // Images are also auto-downloaded during Retrieve source data.
  const handleDownloadImage = async (product: ProductDraft) => {
    if (!draft || !product.imageUrl) return
    setDownloadingImageId(product.id)
    try {
      const result = await downloadProductImage(draft.draft.id, product.id)
      replaceProduct(result)
      if (result.imageStatus === 'valid')
        showToast('success', `Image downloaded for ${product.title || 'the selected product'}.`)
      else if (result.imageStatus === 'blocked')
        showToast('error', `Image blocked: ${result.imageStatus === 'blocked' ? 'URL not allowed' : ''}`)
      else
        showToast('error', 'Image could not be downloaded. Check the source URL.')
    } catch (requestError) {
      showToast('error', requestError instanceof Error ? requestError.message : 'Image could not be downloaded.')
    } finally {
      setDownloadingImageId(null)
    }
  }

  const handleBulkRetrieve = async () => {
    if (!draft || busy) return
    const toRetrieve = selectedProducts.filter((product) => product.sourceUrl)
    if (toRetrieve.length === 0) return
    setRetrievingBulk(true)
    try {
      let sourceCount = 0
      for (const product of toRetrieve) {
        setActiveProductId(product.id)
        try {
          const retrievedProduct = await retrieveProduct(draft.draft.id, product.id)
          replaceProduct(retrievedProduct)
          if (retrievedProduct.enrichmentStatus === 'ready') sourceCount++
          // Download the main product image alongside source content
          if (retrievedProduct.imageUrl && retrievedProduct.imageStatus !== 'valid') {
            try {
              const imageResult = await downloadProductImage(draft.draft.id, product.id)
              replaceProduct(imageResult)
            } catch {
              // Non-fatal — continue with remaining products
            }
          }
        } catch (requestError) {
          showToast(
            'error',
            `${product.title || 'Product'}: ${requestError instanceof Error ? requestError.message : 'Source data could not be retrieved.'}`,
          )
        }
      }
      if (sourceCount > 0) {
        showToast('success', `Retrieved ${sourceCount} source detail${sourceCount !== 1 ? 's' : ''} across ${toRetrieve.length} selected products.`)
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
    if (product.enrichmentStatus === 'failed' || product.enrichmentStatus === 'blocked')
      return 'Retry source data'
    if (product.enrichmentStatus === 'ready')
      return 'Retrieve again'
    return 'Retrieve source data'
  }
  // VIC-20 Issue 7: Separate label for the explicit image download button.
  const imageDownloadLabel = (product: ProductDraft) => {
    if (!product.imageUrl) return 'No image URL'
    if (downloadingImageId === product.id) return 'Downloading…'
    if (product.imageStatus === 'failed' || product.imageStatus === 'blocked') return 'Retry image'
    if (product.imageStatus === 'valid') return 'Download again'
    return 'Download image'
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

  const handleShowProductsLoad = async () => {
    if (!draft) return
    setProductsLoadOpen(true)
    setProductsLoadLoading(true)
    try {
      const entries = await getProductsLoad(draft.draft.id)
      setProductsLoadEntries(entries)
    } catch (requestError) {
      showToast('error', requestError instanceof Error ? requestError.message : 'The products load log could not be loaded.')
      setProductsLoadEntries([])
    } finally {
      setProductsLoadLoading(false)
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
        globalCollectionIds,
        globalCategoryIds,
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
    field: 'stockOnHand' | 'casePrice' | 'unitPrice' | 'suggestedSalePrice' | 'inventoryQuantity' | 'costPrice',
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

  return (
    <>
      {!isLoggedIn && (
        <div className="modal-backdrop" role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 1000 }}>
          <section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" style={{ maxWidth: 400, margin: '10vh auto' }}>
            <div className="eyebrow">{authMode === 'login' ? 'LOG IN' : 'CREATE ACCOUNT'}</div>
            <h2 id="auth-title">{authMode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
            {authError && <div className="validation-box"><strong>Error</strong><span>{authError}</span></div>}
            <label className="field">
              <span>Username</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Enter username"
                autoComplete="username"
              />
            </label>
            <label className="field">
              <span>Password</span>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 4 }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter password"
                  autoComplete="current-password"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="button button-quiet"
                  style={{ padding: '2px 6px', fontSize: 11, minHeight: 'auto' }}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? '👁️' : '👁️‍🗨️'}
                </button>
              </div>
            </label>
            <div className="modal-actions">
              {authMode === 'login' ? (
                <>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={authLoading || !username.trim() || !password.trim()}
                    onClick={handleAuthSubmit}
                  >
                    {authLoading ? 'Signing in…' : 'Sign in'}
                  </button>
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => { setAuthMode('register'); setAuthError('') }}
                  >
                    Need an account? Register
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={authLoading || !username.trim() || !password.trim()}
                    onClick={handleAuthSubmit}
                  >
                    {authLoading ? 'Creating…' : 'Create account'}
                  </button>
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => { setAuthMode('login'); setAuthError('') }}
                  >
                    Already have an account? Sign in
                  </button>
                </>
              )}
            </div>
          </section>
        </div>
      )}
      {!draft ? (
        <main className="app-shell landing-shell">
        <header className="brandbar">
          <div className="brandmark">
            <span className="brand-dot" />
            {supplier === 'vican' ? 'VICAN VISIONS' : 'CELLAR / DRIVE'}
            <span className="brand-context">PRODUCT DESK</span>
          </div>
          <div className="header-actions">
            <label className="supplier-select">
              <span>Supplier</span>
              <div className="supplier-row">
                <select
                  value={pendingSupplier ?? supplier}
                  onChange={(e) => {
                    const val = e.target.value as 'cellar' | 'vican' | ''
                    setPendingSupplier(val)
                  }}
                >
                  <option value="">— select supplier —</option>
                  <option value="cellar">Cellar Drive</option>
                  <option value="vican">Vican Visions</option>
                </select>
              <span className="supplier-actions">
                <button type="button" className="button button-primary" style={{ fontSize: 11 }}
                  disabled={!pendingSupplier || pendingSupplier === ''}
                  onClick={() => {
                    void handleSupplierSwitch((pendingSupplier ?? null) as 'cellar' | 'vican');
                  }}>
                  Apply
                </button>
                <button type="button" className="button button-quiet" style={{ fontSize: 11 }}
                  disabled={!pendingSupplier || pendingSupplier === ''}
                  onClick={() => setPendingSupplier(null)}>
                  Cancel
                </button>
              </span>
              </div>
            </label>
            <ThemeToggle />
            <BackgroundSettings />
            {isLoggedIn && (
              <button type="button" className="button button-quiet" onClick={handleLogout}>
                Logout
              </button>
            )}
            {!isLoggedIn && (
              <button type="button" className="button button-primary" onClick={() => setAuthMode('login')}>
                Login
              </button>
            )}
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
          <h1 className="page-title">
            {supplier === ''
              ? 'Select a supplier to begin'
              : supplier === 'vican'
                ? 'Vican Visions (AliExpress) product update'
                : 'Cellar Drive product update'}
          </h1>
          <p className="hero-copy">
            {supplier === ''
              ? 'Choose a supplier from the dropdown above, then upload a workbook to get started.'
              : 'Load a workbook, enrich each row from its source page, make the edits that matter, then post only the products you approve.'}
          </p>
          <label className={`upload-zone ${busy ? 'is-busy' : ''} ${supplier === '' ? 'is-disabled' : ''}`}>
            <input
              type="file"
              accept=".xlsx"
              disabled={busy || supplier === ''}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleImport(file)
              }}
            />
            <span className="upload-kicker">
              {supplier === ''
                ? 'SELECT A SUPPLIER FIRST'
                : startupLoading
                  ? 'LOADING SAVED CATALOG'
                  : busy
                    ? 'PROCESSING WORKBOOK'
                    : 'DROP OR CHOOSE XLSX'}
            </span>
            <strong>
              {supplier === ''
                ? 'No supplier selected'
                : startupLoading
                  ? 'Restoring your product workspace...'
                  : busy
                    ? 'Merging workbook into SQLite...'
                    : 'Upload supplier workbook'}
            </strong>
            <span>
              Check a row, then choose when its source page details and its
              image are retrieved — these are now separate actions.
            </span>
          </label>
          <div className="mapping-strip">
            {supplier === 'vican' ? (
              <>
                <span><b>A</b> product URL</span>
                <span><b>B-F</b> images</span>
                <span><b>I/J</b> title</span>
                <span><b>K/L/M</b> price (frag)</span>
              </>
            ) : (
              <>
                <span><b>A</b> image</span>
                <span><b>E</b> title</span>
                <span><b>F</b> source page</span>
                <span><b>G</b> stock</span>
                <span><b>I</b> case</span>
                <span><b>J</b> unit price</span>
                <span><b>K</b> type</span>
              </>
            )}
          </div>
        </section>
      </main>
      ) : (
        <main className="app-shell workspace-shell">
      {/* ── Header ── */}
      <header className="brandbar">
        <div className="brandmark">
          <span className="brand-dot" />
          {supplier === 'vican' ? 'VICAN VISIONS' : 'CELLAR / DRIVE'}
          <span className="brand-context">PRODUCT DESK</span>
        </div>
        <div className="header-actions">
          <label className="supplier-select">
            <span>Supplier</span>
            <div className="supplier-row">
            <select
              value={pendingSupplier ?? supplier}
              onChange={(e) => {
                const val = e.target.value as 'cellar' | 'vican' | ''
                setPendingSupplier(val)
              }}
            >
              <option value="">— select supplier —</option>
              <option value="cellar">Cellar Drive</option>
              <option value="vican">Vican Visions</option>
            </select>
              <span className="supplier-actions">
                <button type="button" className="button button-primary" style={{ fontSize: 11 }}
                  disabled={!pendingSupplier || pendingSupplier === ''}
                  onClick={() => {
                    void handleSupplierSwitch((pendingSupplier ?? null) as 'cellar' | 'vican');
                  }}>
                  Apply
                </button>
                <button type="button" className="button button-quiet" style={{ fontSize: 11 }}
                  disabled={!pendingSupplier || pendingSupplier === ''}
                  onClick={() => setPendingSupplier(null)}>
                  Cancel
                </button>
              </span>
              </div>
          </label>
          <ThemeToggle />
          <BackgroundSettings />
          {readiness && supplier === 'vican' ? (
            <span
              className={`woo-connection-pill ${readiness.wooConfigured ? 'connected' : 'disconnected'}`}
              title={
                readiness.wooConfigured
                  ? `WooCommerce connected: ${readiness.wooStoreUrl}`
                  : `WooCommerce not configured: missing ${readiness.wooMissing?.join(', ') ?? 'credentials'}`
              }
            >
              <span className="connection-dot" />
              {readiness.wooConfigured
                ? `Woo: ${readiness.wooStoreUrl}`
                : 'WooCommerce not configured'}
            </span>
          ) : (
            readiness && (
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
            )
          )}
          {readiness && (
            <span className="version-tag" title="Application version">
              v{readiness.version}
            </span>
          )}
          <button
            type="button"
            className="button button-quiet"
            disabled={busy || publishing || saving}
            onClick={handleResetPage}
            title="Clears the visible draft, filters, selections, edits, and posting issues panel. Does NOT touch SQLite. Use Purge database to clear persisted Shopify status."
          >
            Reset page
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || publishing || saving}
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = '.xlsx'
              input.onchange = (event: Event) => {
                const file = (event.target as HTMLInputElement).files?.[0]
                if (file) void handleImport(file)
              }
              input.click()
            }}
          >
            Load workbook
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
          <button
            type="button"
            className="button button-quiet"
            onClick={handleLogout}
          >
            Logout
          </button>
        </div>
      </header>

      {/* ── Top controls bar — all filters/stats above the table ── */}
      <section className="top-controls-bar">
        <div className="top-controls-left">
          <div className="status-box-inline">
            <div className="eyebrow-small">IMPORT / {draft.draft.filename}</div>
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
              <button
                type="button"
                className={`status-item status-button ${productsLoadOpen ? 'is-active' : ''}`}
                onClick={() => void handleShowProductsLoad()}
                aria-expanded={productsLoadOpen}
              >
                <span>Products Load</span><strong className={productsLoadEntries.length ? 'metric-alert' : ''}>{productsLoadEntries.length.toLocaleString()}</strong>
              </button>
            </div>
          </div>
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
              disabled={busy || publishing || selectedProducts.filter((p) => p.sourceUrl).length === 0}
              onClick={() => void handleBulkRetrieve()}
            >
              {retrievingBulk ? 'Retrieving…' : `Retrieve source data (${selectedProducts.filter((p) => p.sourceUrl).length})`}
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
          <section className="filter-bar" aria-label="Column filters">
            <div className="filter-bar-label">
              <span>Filter columns</span>
              <small>
                {Object.values(columnFilters).reduce((total, filter) => {
                  if (filter.kind === 'select') return total + filter.values.length
                  if (filter.kind === 'range') return total + (filter.value ? 1 : 0)
                  return total + (filter.pattern ? 1 : 0)
                }, 0)}{' '}
                active
              </small>
            </div>
            {activeFilterConfig.map(({ field, label, kind }) => {
              const filter = columnFilters[field]
              if (kind === 'range') {
                return (
                  <RangeFilter
                    key={field}
                    label={label}
                    value={filter?.kind === 'range' ? { operator: filter.operator, value: filter.value } : { operator: '=', value: '' }}
                    onChange={(value) =>
                      setColumnFilters((current) => ({ ...current, [field]: { kind: 'range', operator: value.operator, value: value.value } }))
                    }
                  />
                )
              }
              if (kind === 'text') {
                return (
                  <TextFilter
                    key={field}
                    label={label}
                    pattern={filter?.kind === 'text' ? filter.pattern : ''}
                    onChange={(pattern) =>
                      setColumnFilters((current) => ({ ...current, [field]: { kind: 'text', pattern } }))
                    }
                  />
                )
              }
              return (
                <FilterMenu
                  key={field}
                  label={label}
                  options={filterOptions[field] ?? []}
                  selected={filter?.kind === 'select' ? filter.values : []}
                  onChange={(values) =>
                    setColumnFilters((current) => ({ ...current, [field]: { kind: 'select', values } }))
                  }
                />
              )
            })}
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
          <div className="top-pagination top-pagination-above-table">
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
                <option value="shopify">Status</option>
              </select>
            </label>
          </div>
        </div>
      </section>

      {/* ── Table + Editor ── */}
      <section className="workspace-grid">
        <div className="list-panel">
          <div className="list-header">
            <div className="list-header-row">
              <div className="check-cell">
                <input
                  type="checkbox"
                  checked={
                    visibleProducts.length > 0 &&
                    visibleProducts.every((product) => product.selected)
                  }
                  onChange={toggleAllVisible}
                  aria-label="Select all visible products"
                />
              </div>
              <div className="list-header-cell">Product</div>
              <div className="list-header-cell">Unit {supplier !== 'vican' && '/ case'}</div>
              <div className="list-header-cell">Sale price</div>
              <div className="list-header-cell">Stock</div>
              <div className="list-header-cell">Source</div>
              <div className="list-header-cell">Status</div>
              <div className="list-header-cell">Source data</div>
            </div>
          </div>
          <div className="list-wrap">
            {visibleProducts.map((product) => {
              const isActive = activeProduct?.id === product.id
              return (
                <div
                  key={product.id}
                  className={`product-list-row ${isActive ? 'is-active' : ''}`}
                  onClick={() => setActiveProductId(product.id)}
                >
                  <div
                    className="check-cell"
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
                  </div>
                  <div className="list-cell product-cell">
                    <div className="thumb">
                      {product.imageLocalUrl ? (
                        <img src={product.imageLocalUrl} alt="" loading="lazy" />
                      ) : autoDownloadingIds.has(product.id) ? (
                        <span className="image-loading">…</span>
                      ) : (
                        <span>{product.imageStatus === 'pending' ? '…' : 'IMG'}</span>
                      )}
                    </div>
                    <div>
                      <strong>
                        {product.sourceUrl ? (
                          product.supplier === 'vican' ? (
                            <a
                              href={product.sourceUrl}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (browserWindowRef.current && !browserWindowRef.current.closed) {
                                  browserWindowRef.current.location.href = product.sourceUrl
                                  browserWindowRef.current.focus()
                                } else {
                                  const win = window.open(product.sourceUrl, 'ecomint-brower', 'width=1200,height=800,scrollbars=yes,resizable=yes,alwaysOnTop=yes')
                                  if (win) win.focus()
                                  browserWindowRef.current = win
                                }
                              }}
                              title="Open source page"
                            >
                              {product.title || 'Untitled product'}
                            </a>
                          ) : (
                            <a
                              href={product.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              title="Open source page"
                            >
                              {product.title || 'Untitled product'}
                            </a>
                          )
                        ) : (
                          product.title || 'Untitled product'
                        )}
                      </strong>
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
                                browserWindowRef.current.focus()
                              } else {
                                const win = window.open(product.sourceUrl, 'ecomint-brower', 'width=1200,height=800,scrollbars=yes,resizable=yes,alwaysOnTop=yes')
                                if (win) win.focus()
                                browserWindowRef.current = win
                              }
                            }}
                          >
                            Open
                          </button>
                        </>
                      )}
                      <small>
                        Row {product.rowNumber}{' '}
                        {product.validationErrors.length
                          ? ` / ${product.validationErrors.length} issue${product.validationErrors.length === 1 ? '' : 's'}`
                          : ''}
                      </small>
                    </div>
                  </div>
                  <div className="list-cell">
                    <strong>{money(product.unitPrice)}</strong>
                    {supplier !== 'vican' && <small>{money(product.casePrice)} case</small>}
                  </div>
                  <div className="list-cell"><strong>{money(product.suggestedSalePrice)}</strong></div>
                  <div className="list-cell">{product.stockOnHand ?? '—'}</div>
                  <div className="list-cell">{renderStatus(product.enrichmentStatus)}</div>
                  <div className="list-cell">{renderStatus(product.publishStatus)}</div>
                  <div className="list-cell source-action" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      className="row-action"
                      disabled={busy || !product.sourceUrl}
                      onClick={() => void handleRetrieve(product)}
                    >
                      {retrieveLabel(product)}
                    </button>
                  </div>
                </div>
              )
            })}
            {browsingProduct && browsingProduct.supplier === 'vican' && browsingProduct.sourceUrl && (
              <div className="inline-browser-row">
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
                            browserWindowRef.current.focus()
                          } else {
                            const win = window.open(browsingProduct.sourceUrl, 'ecomint-brower', 'width=1200,height=800,scrollbars=yes,resizable=yes,alwaysOnTop=yes')
                            if (win) win.focus()
                            browserWindowRef.current = win
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
                    <iframe
                      src={browsingProduct.sourceUrl}
                      title={`Browse ${browsingProduct.title}`}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                      loading="lazy"
                    />
                  </div>
                </div>
              </div>
            )}
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

        {/* ── Detail pane ── */}
        <aside className="detail-pane-container">
          <div className="detail-pane">
          {/* ── Product Details section ── */}
          <div className="detail-section-heading">
            <div className="eyebrow">PRODUCT DETAILS</div>
            {activeProduct ? (
              <div className="heading-row-indicator">
                <div className="eyebrow">ROW {activeProduct.rowNumber}</div>
                {renderStatus(activeProduct.enrichmentStatus)}
              </div>
            ) : (
              <span>Details</span>
            )}
          </div>
          {activeProduct ? (
            <>
              {/* ── Image details ── */}
              <section className="image-details" aria-label="Retrieved image details">
                <div className="image-details-heading">
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
                          : 'Click Download image to save locally'}
                      </dd>
                    </div>
                    {/* VIC-20 Issue 7: Explicit download button — images are now
                        also auto-downloaded during Retrieve source data, but
                        this button remains available for retrying failed or
                        skipped image downloads independently. */}
                    {activeProduct.imageUrl && activeProduct.imageStatus !== 'valid' && (
                      <div className="image-download-action">
                        <button
                          type="button"
                          className="button button-secondary"
                          style={{ fontSize: 11, padding: '4px 8px', height: 'auto' }}
                          disabled={busy || downloadingImageId === activeProduct.id || activeProduct.imageStatus === 'blocked'}
                          onClick={() => void handleDownloadImage(activeProduct)}
                        >
                          {downloadingImageId === activeProduct.id ? 'Downloading…' : imageDownloadLabel(activeProduct)}
                        </button>
                      </div>
                    )}
                  </dl>
                </div>
              </section>

              {/* VIC-17: Vican image gallery (up to 5 images from template columns B-F) */}
              {activeProduct.supplier === 'vican' && (
                <section className="image-gallery-section" aria-label="Vican product image gallery">
                  <div className="field-group-heading">
                    <div className="eyebrow">IMAGE GALLERY</div>
                    <span>Up to 5 images. Column B is the default main product picture.</span>
                  </div>
                  {/* VIC-20 Issue 7: Gallery images come from the workbook (columns B-F)
                      and are available immediately after import — they are URLs,
                      not server-side downloads. Source-page images are merged in
                      after Retrieve is pressed. Images are only DOWNLOADED to the
                      server via the explicit Download image button above. */}
                  {activeProduct.aliexpressImages.length > 0 ? (
                    <div className="image-gallery">
                      {activeProduct.aliexpressImages.map((imageUrl, index) => (
                        <button
                          key={index}
                          type="button"
                          className={`gallery-thumbnail ${index === activeProduct.selectedImageIndex ? 'is-main' : ''}`}
                          onClick={() => {
                            patchProduct(activeProduct.id, {
                              selectedImageIndex: index,
                              imageUrl: imageUrl,
                            } as Partial<ProductDraft>)
                          }}
                          aria-label={`Select image ${index + 1} as main product picture`}
                          title={`Click to set image ${index + 1} as main product picture`}
                        >
                          <img src={imageUrl} alt={`Product image ${index + 1}`} loading="lazy" />
                          {index === activeProduct.selectedImageIndex && <span className="main-badge">Main</span>}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <small className="field-hint">
                      No images found in the gallery. Source page images will appear after you click Retrieve source data.
                    </small>
                  )}
                </section>
              )}

              <div className="field-group">
                <div className="field-group-heading">
                  <div className="eyebrow">SUPPLIER DATA</div>
                  <span>Read-only</span>
                </div>
                {/* VIC-20 #4: For vican, Product Title spans full width of the pane */}
                <div className={`field-grid ${activeProduct.supplier === 'vican' ? 'vican-title-full' : ''}`}>
                  {activeProduct.supplier === 'vican' ? (
                    <div className="vican-title-full-width">{renderReadOnlyTextInput('Product Title', activeProduct.title)}</div>
                  ) : (
                    renderReadOnlyTextInput('Product Title', activeProduct.title)
                  )}
                  {renderReadOnlyNumberInput('Unit price', activeProduct.unitPrice)}
                  {activeProduct.supplier !== 'vican' && renderReadOnlyNumberInput('Case price', activeProduct.casePrice)}
                  {renderReadOnlyNumberInput(
                    'Supplier stock on hand',
                    activeProduct.stockOnHand ?? null,
                  )}
                  {/* VIC-17: Cost price (dollars + cents from template columns H + I) — editable for Vican Visions */}
                  {activeProduct.supplier === 'vican' &&
                    renderNumberInput('Cost price (H+I)', 'costPrice', activeProduct.costPrice)}
                </div>
              </div>

              <div className="field-group">
                <div className="field-group-heading">
                  <div className="eyebrow">SUGGESTED DATA</div>
                  <span>Editable</span>
                </div>
                <div className="field-grid">
                  {renderNumberInput(
                    'Suggested sale price',
                    'suggestedSalePrice',
                    activeProduct.suggestedSalePrice,
                  )}
                  {renderNumberInput(
                    'Inventory',
                    'inventoryQuantity',
                    activeProduct.inventoryQuantity,
                  )}
                </div>
              </div>

              <div className="source-line">
                <span>Source page</span>
                {activeProduct.sourceUrl ? (
                  <a
                    href={activeProduct.sourceUrl}
                    onClick={(event) => {
                      event.preventDefault()
                      const win = window.open(activeProduct.sourceUrl, 'ecomint-source', 'width=1200,height=800,scrollbars=yes,resizable=yes,alwaysOnTop=yes')
                      if (win) win.focus()
                    }}
                    title="Open source page"
                  >
                    Open source
                  </a>
                ) : (
                  <em>Not provided</em>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || !activeProduct.sourceUrl}
                  onClick={() => void handleRetrieve(activeProduct)}
                >
                  {retrieveLabel(activeProduct)}
                </button>
              </div>

              {activeProduct.enrichmentError && (
                <p className="source-error">Source retrieval: {activeProduct.enrichmentError}</p>
              )}
              {activeProduct.publishError && (
                <div className="validation-box publish-issue">
                  <strong>Shopify needs attention</strong>
                  <span>{activeProduct.publishError}</span>
                </div>
              )}

              <RichTextEditor
                label="Description"
                field="descriptionHtml"
                productId={activeProduct.id}
                value={activeProduct.descriptionHtml}
                isDirty={activeProduct && 'descriptionHtml' in (dirtyFieldsFor(activeProduct.id) ?? {})}
                setDirtyFields={setDirtyFields}
                placeholder="Fetched description or your own copy"
              />

              <div className="detail-fields">
                {(['brand', 'country', 'region', 'productType', 'abv', 'containerType', 'style'] as const)
                  .filter((field) => !(activeProduct.supplier === 'vican' && field === 'abv'))
                  .map(
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

              {/* VIC-17: AliExpress-specific editor sections */}
              {activeProduct.supplier === 'vican' && (
                <>
                  {/* Other Attributes (from AliExpress "Specifications" section) */}
                  <RichTextEditor
                    label="Other Attributes"
                    field="productAttributes"
                    productId={activeProduct.id}
                    value={activeProduct.productAttributes}
                    isDirty={activeProduct && 'productAttributes' in (dirtyFieldsFor(activeProduct.id) ?? {})}
                    setDirtyFields={setDirtyFields}
                    placeholder="Fetched attributes or your own copy"
                  />

                  {/* Reset AliExpress fields to originally loaded values */}
                  <div className="field-group">
                    <div className="field-group-heading">
                      <div className="eyebrow">RESET</div>
                      <span>Reverts AliExpress fields to originally retrieved values</span>
                    </div>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => {
                        patchProduct(activeProduct.id, {
                          productAttributes: activeProduct.originalProductAttributes,
                          selectedImageIndex: 0,
                          imageUrl: activeProduct.imageUrls[0] ?? activeProduct.imageUrl,
                        } as Partial<ProductDraft>)
                        showToast('info', 'AliExpress fields reverted to original values.')
                      }}
                    >
                      Reset AliExpress fields
                    </button>
                  </div>
                </>
              )}

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

              {/* ── Categories section (bottom) ── */}
              <div className="detail-section-heading">
                <div className="eyebrow">CATEGORIES</div>
                <span>Applies to checked products on publish</span>
              </div>
              {/* ── Global settings: Collections (Cellar only; Vican uses WooCommerce categories) ── */}
              {supplier !== 'vican' && (
              <div className="field-group">
                <div className="field-group-heading">
                  <div className="eyebrow">GLOBAL SETTINGS</div>
                  <span>Applies to checked products on publish</span>
                </div>
                <div className="collection-selector">
                  <label>
                    <span>Collections</span>
                    <select
                      multiple
                      size={Math.min(Math.max(readiness?.collections?.length ?? 0, 4), 8)}
                      value={globalCollectionIds}
                      onChange={(event) => {
                        const selected = Array.from(event.target.selectedOptions).map((opt) => opt.value)
                        setGlobalCollectionIds(selected)
                      }}
                      disabled={publishing}
                    >
                      {(readiness?.collections ?? []).map((collection) => (
                        <option key={collection.id} value={collection.id}>
                          {collection.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {globalCollectionIds.length > 0 && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={publishing}
                      onClick={() => setGlobalCollectionIds([])}
                    >
                      Clear selection
                    </button>
                  )}
                </div>
                {globalCollectionIds.length > 0 && (
                  <small className="collection-hint">
                    {globalCollectionIds.length} collection{globalCollectionIds.length === 1 ? '' : 's'} selected for the next {selectedProducts.length} checked product{selectedProducts.length === 1 ? '' : 's'}.
                  </small>
                )}
              </div>
              )}

              {/* VIC-19: WooCommerce categories selector (vican only) */}
              {supplier === 'vican' && (
                <div className="field-group">
                  <div className="field-group-heading">
                    <div className="eyebrow">GLOBAL SETTINGS</div>
                    <span>Applies to checked products on publish (WooCommerce categories)</span>
                  </div>
                  <div className="collection-selector">
                    <label>
                      <span>Categories</span>
                      <select
                        multiple
                        size={Math.min(Math.max(readiness?.wooCategories?.length ?? 0, 4), 8)}
                        value={globalCategoryIds}
                        onChange={(event) => {
                          const selected = Array.from(event.target.selectedOptions).map((opt) => opt.value)
                          setGlobalCategoryIds(selected)
                        }}
                        disabled={publishing}
                      >
                        {(readiness?.wooCategories ?? []).map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {globalCategoryIds.length > 0 && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={publishing}
                        onClick={() => setGlobalCategoryIds([])}
                      >
                        Clear selection
                      </button>
                    )}
                  </div>
                  {globalCategoryIds.length > 0 && (
                    <small className="collection-hint">
                      {globalCategoryIds.length} category{globalCategoryIds.length === 1 ? '' : 's'} selected for the next {selectedProducts.length} checked product{selectedProducts.length === 1 ? '' : 's'}.
                    </small>
                  )}
                </div>
              )}

              {/* ── Publish flags (bottom of panel) ── */}
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

              {/* ── Save button (bottom of detail panel) ── */}
              {activeProduct && (
                <div className="detail-pane-footer">
                  {hasUnsavedChanges && (
                    <div className="field-hint">
                      You have {Object.keys(dirtyFields).length} product
                      {Object.keys(dirtyFields).length === 1 ? '' : 's'} with unsaved changes.
                    </div>
                  )}
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={!hasUnsavedChanges || saving}
                    onClick={() => void handleSave()}
                  >
                    {saving ? 'Saving…' : hasUnsavedChanges ? 'Save changes' : 'Saved'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">Choose a product to edit.</div>
          )}
        </div>
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

      {/* ── Products load panel (VIC-16: partial/failed retrieval log) ── */}
      {productsLoadOpen && (
        <section className="issues-log" aria-labelledby="products-load-title">
          <div className="issues-heading">
            <div>
              <div className="eyebrow">PRODUCTS LOAD / LOG FILE</div>
              <h2 id="products-load-title">
                {productsLoadLoading
                  ? 'Loading products load log...'
                  : productsLoadEntries.length
                    ? `${productsLoadEntries.length.toLocaleString()} product${productsLoadEntries.length === 1 ? '' : 's'} with partial/failed retrieval`
                    : 'No partial or failed retrievals found'}
              </h2>
            </div>
            <div className="issues-actions">
              <span>logs/productsload.log</span>
              <button
                type="button"
                className="text-button"
                disabled={productsLoadLoading}
                onClick={() => void handleShowProductsLoad()}
              >
                Refresh log
              </button>
            </div>
          </div>

          {productsLoadLoading && (
            <p className="issue-overflow">Reading products load entries for this draft.</p>
          )}

          {!productsLoadLoading && productsLoadEntries.length > 0 && (
            <div className="issue-list">
              {productsLoadEntries.map((entry) => {
                const product = draft?.products.find((p) => p.id === entry.productId) ?? null
                return (
                  <article className="issue-entry" key={`${entry.timestamp}-${entry.productId}`}>
                    {product ? (
                      <button
                        type="button"
                        className="issue-product"
                        onClick={() => {
                          setActiveProductId(product.id)
                          setProductsLoadOpen(false)
                        }}
                      >
                        <strong>{product.title || 'Untitled product'}</strong>
                        <small>
                          Row {product.rowNumber} / Fields: {entry.fieldsLoaded.length} loaded, {entry.fieldsFailed.length} failed
                        </small>
                      </button>
                    ) : (
                      <div className="issue-product">
                        <strong>{entry.title || 'Unknown product'}</strong>
                        <small>{new Date(entry.timestamp).toLocaleString()}</small>
                      </div>
                    )}
                    <div className="issue-details">
                      <p>
                        <strong>Loaded:</strong> {entry.fieldsLoaded.length ? entry.fieldsLoaded.join(', ') : 'none'}
                      </p>
                      <p>
                        <strong>Failed:</strong> {entry.fieldsFailed.length ? entry.fieldsFailed.join(', ') : 'none'}
                      </p>
                      {entry.error && (
                        <p>
                          <strong>Error:</strong> {entry.error}
                        </p>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}

          {!productsLoadLoading && productsLoadEntries.length === 0 && (
            <p className="issue-overflow">No products with partial or failed retrieval found.</p>
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
              {supplier === 'vican'
                ? 'Suggested sale price, all images, description, attributes, and categories will be sent to your WooCommerce store.'
                : 'Suggested sale price and Shopify inventory will be sent to the configured Shopify location.'}
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
      )}
    </>
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
