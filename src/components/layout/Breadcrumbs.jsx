import { Fragment, useState, useRef, useCallback, useLayoutEffect, useEffect, useId } from 'react'
import { splitCrumbs, crumbsToHide } from './breadcrumbFold'
import './breadcrumbs.css'

// Pages are also rendered to static markup by the tests, where there is
// nothing to measure and a layout effect only earns a warning.
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect

const nodes = content => content.map((node, i) => <Fragment key={i}>{node}</Fragment>)

function Crumb({ crumb, tail = false }) {
  return (
    <span className={`crumb-seg${tail ? ' is-tail' : ''}`}>
      {crumb.sep}
      <span className="crumb-body">{nodes(crumb.content)}</span>
    </span>
  )
}

/**
 * PageBar's trail. A page authors it as children — links, `.sep` separators,
 * the current page's name — and when the trail is wider than the space the bar
 * leaves it, the crumbs in its middle fold into a "…" that opens them as a
 * menu. The first crumb and the last always stay; if those two alone are still
 * too wide, the last one is cut short with an ellipsis of its own.
 *
 * The widths come from a copy of the whole trail that is laid out but never
 * seen, so every crumb can be measured whether it is showing or folded, and
 * folding one never changes the numbers that decided to fold it.
 */
export default function Breadcrumbs({ children }) {
  const crumbs = splitCrumbs(children)
  const n = crumbs.length
  const trailRef = useRef(null)
  const measureRef = useRef(null)
  const moreRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = useId()
  const [fold, setFold] = useState({ count: 0, label: '' })
  const foldRef = useRef(fold) // the fold as last set, read by refit
  const [menuAt, setMenuAt] = useState(null)

  const refit = useCallback(() => {
    const trail = trailRef.current
    const box = measureRef.current
    if (!trail || !box) return
    const [more, ...segs] = box.children
    const count = crumbsToHide(
      segs.map(el => el.getBoundingClientRect().width),
      more.getBoundingClientRect().width,
      parseFloat(getComputedStyle(trail).columnGap) || 0,
      trail.getBoundingClientRect().width,
    )
    // The folded crumbs' names, for the "…" button's label and tooltip.
    const label = segs.slice(1, count + 1).map(el => el.lastChild.textContent.trim()).join(' / ')
    // Only a change is set. Setting an equal fold is not free from an effect
    // that runs after every render: React may render once more to find out it
    // is equal, that render runs this again, and on InfraView's node page the
    // two never settled.
    if (foldRef.current.count === count && foldRef.current.label === label) return
    foldRef.current = { count, label }
    setFold(foldRef.current)
  }, [])

  // Any render can change the trail — a host picked, a pod opened — so it is
  // refitted after every one, before the browser paints it.
  useBeforePaint(() => { refit() })

  // And again when the room changes (the window, the controls beside it) or
  // the trail's own width does (a web font arriving).
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(refit)
    ro.observe(trailRef.current)
    ro.observe(measureRef.current)
    return () => ro.disconnect()
  }, [refit])

  // The trail can lose crumbs between a render and its refit.
  const count = Math.min(fold.count, Math.max(0, n - 2))
  const open = Boolean(menuAt) && count > 0

  useEffect(() => {
    if (!open) return undefined
    const onClick = e => {
      if (!menuRef.current?.contains(e.target) && !moreRef.current?.contains(e.target)) setMenuAt(null)
    }
    const onKey = e => {
      if (e.key !== 'Escape') return
      setMenuAt(null)
      moreRef.current?.focus()
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = () => {
    if (open) { setMenuAt(null); return }
    const r = moreRef.current.getBoundingClientRect()
    setMenuAt({ top: r.bottom + 4, left: r.left })
  }

  const sep = crumbs.find(c => c.sep)?.sep ?? null

  return (
    <div className="card-crumbs-left" ref={trailRef}>
      <div className="crumb-measure-box" aria-hidden="true">
        <div className="crumb-measure" ref={measureRef}>
          <span className="crumb-seg">{sep}<button type="button" className="crumb-more" tabIndex={-1}>…</button></span>
          {crumbs.map((c, i) => <Crumb key={i} crumb={c} />)}
        </div>
      </div>

      {n > 0 && <Crumb crumb={crumbs[0]} tail={n === 1} />}
      {count > 0 && (
        <span className="crumb-seg">
          {sep}
          <button
            ref={moreRef}
            type="button"
            className={`crumb-more${open ? ' open' : ''}`}
            title={fold.label}
            aria-label={`Show hidden breadcrumbs: ${fold.label}`}
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={toggle}
          >
            …
          </button>
          {open && (
            <div
              ref={menuRef}
              id={menuId}
              className="dd-panel crumb-overflow"
              role="group"
              aria-label="Hidden breadcrumbs"
              style={{ position: 'fixed', top: menuAt.top, left: menuAt.left, zIndex: 500 }}
              // Following a crumb, or picking from a picker inside one, is
              // done with the menu. The capture phase sees the click before a
              // picker's own handler can stop it, but the menu closes only once
              // the click is over: React renders between the capture and bubble
              // phases, and closing at once would unmount the crumb before its
              // own onClick ran.
              onClickCapture={e => {
                if (e.target.closest('a, .dd-item')) setTimeout(() => setMenuAt(null))
              }}
            >
              {crumbs.slice(1, count + 1).map((c, i) => (
                <div key={i} className="crumb-overflow-item">{nodes(c.content)}</div>
              ))}
            </div>
          )}
        </span>
      )}
      {crumbs.slice(count + 1).map((c, i) => (
        <Crumb key={count + 1 + i} crumb={c} tail={count + 1 + i === n - 1} />
      ))}
    </div>
  )
}
