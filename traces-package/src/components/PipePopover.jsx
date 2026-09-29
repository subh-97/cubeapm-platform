import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'

// Anchored popover shell used by every pill in the aggregate toolbar. The
// parent owns open/close state and passes the source pill via `anchorRef`.
// Responsibilities:
//   • fixed positioning below the anchor with viewport clamping
//   • click-outside dismissal (excluding the anchor itself — clicking the
//     anchor a second time should feel like a toggle, not a fight)
//   • Escape dismissal
// The popover positions itself once when it opens and again on window
// resize/scroll so the toolbar's layout jitter doesn't strand it.
export default function PipePopover({
  anchorRef,
  open,
  onClose,
  title,
  subtitle,
  align = 'left',
  offset = 6,
  width = 280,
  className,
  children,
}) {
  const popRef = useRef(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (!open || !anchorRef?.current) return
    const compute = () => {
      const rect = anchorRef.current.getBoundingClientRect()
      let x = align === 'right' ? rect.right - width : rect.left
      x = Math.max(8, Math.min(x, window.innerWidth - width - 8))
      const y = rect.bottom + offset
      setPos({ x, y })
    }
    compute()
    window.addEventListener('resize', compute)
    window.addEventListener('scroll', compute, true)
    return () => {
      window.removeEventListener('resize', compute)
      window.removeEventListener('scroll', compute, true)
    }
  }, [open, anchorRef, align, offset, width])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose?.() } }
    const onDown = (e) => {
      if (popRef.current?.contains(e.target)) return
      if (anchorRef?.current?.contains(e.target)) return
      onClose?.()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  return (
    <div
      ref={popRef}
      className={clsx('pipe-pop', className)}
      style={{ left: pos.x, top: pos.y, width }}
      role="dialog"
      aria-label={title}
    >
      {(title || subtitle) && (
        <div className="pipe-pop-head">
          <div>
            {title && <div className="pipe-pop-title">{title}</div>}
            {subtitle && <div className="pipe-pop-sub">{subtitle}</div>}
          </div>
          <button type="button" className="pipe-pop-close" onClick={onClose} aria-label="Close">
            <X size={13} strokeWidth={2.2} />
          </button>
        </div>
      )}
      <div className="pipe-pop-body">{children}</div>
    </div>
  )
}
