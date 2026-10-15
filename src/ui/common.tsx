import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconX } from './icons'

export function Modal({ title, onClose, children, footer }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <IconX />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

/** Popover anchored under an element; flips/clamps to stay on screen. */
export function Popover({ anchor, onClose, children, align = 'center' }: { anchor: HTMLElement | null; onClose(): void; children: ReactNode; align?: 'center' | 'start' | 'end' }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const a = anchor.getBoundingClientRect()
    const el = ref.current.getBoundingClientRect()
    let left = align === 'start' ? a.left : align === 'end' ? a.right - el.width : a.left + a.width / 2 - el.width / 2
    left = Math.max(8, Math.min(left, window.innerWidth - el.width - 8))
    let top = a.bottom + 8
    if (top + el.height > window.innerHeight - 8) top = Math.max(8, a.top - el.height - 8)
    setPos({ left, top })
  }, [anchor, align])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="popover-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="popover" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange(v: T): void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function MenuItem({ icon, children, onClick, danger }: { icon?: ReactNode; children: ReactNode; onClick(): void; danger?: boolean }) {
  return (
    <button className={`menu-item${danger ? ' danger' : ''}`} onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  )
}

export function useConfirm() {
  return (message: string) => window.confirm(message)
}
