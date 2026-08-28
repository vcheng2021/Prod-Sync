import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastItem {
  id: string
  type: ToastType
  message: string
}

interface ToastContext {
  showToast: (type: ToastType, message: string, durationMs?: number) => void
}

const ToastContext = createContext<ToastContext | null>(null)

export const useToast = () => {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used within a ToastProvider')
  return context
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const removeToast = (id: string) =>
    setToasts((current) => current.filter((toast) => toast.id !== id))

  const showToast = (type: ToastType, message: string, durationMs = 4000) => {
    const id = crypto.randomUUID()
    setToasts((current) => [...current, { id, type, message }])
    if (timersRef.current[id]) clearTimeout(timersRef.current[id])
    timersRef.current[id] = setTimeout(() => {
      removeToast(id)
      delete timersRef.current[id]
    }, durationMs)
  }

  // clean up timers on unmount
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const id of Object.values(timers)) clearTimeout(id)
    }
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-container">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onRemove={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function Toast({
  toast,
  onRemove,
}: {
  toast: ToastItem
  onRemove: (id: string) => void
}) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    // trigger enter animation on next frame
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  const handleDismiss = () => {
    setVisible(false)
    setTimeout(() => onRemove(toast.id), 240)
  }
  return (
    <div
      className={`toast toast-${toast.type} ${visible ? 'show' : ''}`}
    >
      <span className="toast-icon">
        {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : 'ℹ'}
      </span>
      <span>{toast.message}</span>
      <button
        type="button"
        className="toast-close"
        onClick={handleDismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  )
}
