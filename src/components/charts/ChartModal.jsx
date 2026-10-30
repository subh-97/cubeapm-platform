import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import CardMenu, { CardActionContext } from '@/components/CardMenu'
import FilterSelect from '@/components/shared/FilterSelect'
import { shiftWindow } from '@/data/timeWindow'
import { trapTab, TABBABLE } from '@/utils/focusTrap'
import {
  ChartFrameContext, CHART_COMPARE_OPTIONS, DEFAULT_CHART_COMPARE, chartCompareOption,
  COMPARE_PLOT_HEIGHT, EXPAND_PLOT_HEIGHT,
} from './chartView'
import './chart-modal.css'

const COMPARE_LABELS = CHART_COMPARE_OPTIONS.map(o => o.label)
const COMPARE_BY_LABEL = Object.fromEntries(CHART_COMPARE_OPTIONS.map(o => [o.label, o.value]))

// Rendered into <body> rather than into the card: cards clip their overflow,
// and inside one the modal's charts would match the card's descendant rules
// (`.runtime-chart-card .chart-host` and the like). A server render, which has
// no document, draws it in place.
const portal = node => (typeof document === 'undefined' ? node : createPortal(node, document.body))

/**
 * A chart card's Expand and Compare: the card's chart on its own, larger, or
 * drawn twice — over the page's window, and over the same span an hour, a day
 * or a week earlier — one above the other, as production's Compare is
 * (docs/decisions/chart-compare-expand.md).
 *
 * `view` is the card's (chartView.js): `win`, `render(w)` its chart over any
 * window, and optionally `value(w)`, the figure its header prints beside the
 * title, and `comparable`, false for a card that can only draw the window it
 * has. The modal draws nothing of its own data; each panel is the card's
 * `render` under the modal's frame (ChartFrameContext), which gives every
 * chart inside the modal's height, crosshair group and "now".
 *
 * The page's chart under the pointer still zooms the page when dragged, and
 * the modal follows: it renders from the card's live view, so a new window
 * redraws both panels. The earlier chart cannot be dragged.
 *
 * A dialog for the keyboard as for the eye: focus moves to Close on open and
 * back to whatever opened it on close, Tab stays inside (trapTab), Escape and a
 * click on the backdrop close it.
 *
 * `mode` is 'expand' or 'compare'; the expanded chart's ⋮ offers Compare,
 * which turns this modal into the comparison (`onMode`).
 */
export default function ChartModal({ mode, onMode, onClose, title, total, view }) {
  const boxRef = useRef(null)
  const closeRef = useRef(null)
  const titleId = useId()
  const syncId = `chart-modal${useId()}`
  const pageAction = useContext(CardActionContext)
  const [compare, setCompare] = useState(DEFAULT_CHART_COMPARE)

  const { win } = view
  const option = chartCompareOption(compare)
  const isCompare = mode === 'compare'
  const earlier = useMemo(() => (isCompare ? shiftWindow(win, option.sec) : null), [isCompare, win, option.sec])

  // The page's window ends at now, so its end is the instant every tooltip in
  // the modal counts back from — the earlier chart's included.
  const nowMs = win.end * 1000
  const height = isCompare ? COMPARE_PLOT_HEIGHT : EXPAND_PLOT_HEIGHT
  const frame = useMemo(
    () => ({ syncId, syncMethod: 'index', height, brush: true, nowMs }),
    [syncId, height, nowMs],
  )
  const earlierFrame = useMemo(() => ({ ...frame, brush: false }), [frame])

  // Focus in on open, back to the opener on close. The opener is whatever had
  // focus as the modal mounted: the Expand button, or the ⋮, which the menu
  // hands focus back to before it acts.
  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    return () => { if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus() }
  }, [])

  // Turned from Expand into Compare by the expanded chart's own ⋮, the modal
  // drops that ⋮ — and with it the focus the menu handed back to it. Focus
  // goes to the choice of window instead, the control the comparison is
  // about, rather than falling out of the dialog to <body>.
  useEffect(() => {
    if (!isCompare) return
    const box = boxRef.current
    if (box && !box.contains(document.activeElement)) {
      box.querySelector('.chart-modal-compare-select')?.focus()
    }
  }, [isCompare])

  // The keyboard for when focus is NOT in the box. Usually it is, and the
  // box's own handler takes the key; but a Compare choice picked with the
  // pointer removes the list it was picked from, and focus falls to <body>,
  // where only the document still hears the key. There Escape still closes the
  // modal, and Tab comes back into it — to the first control, or with Shift to
  // the last — rather than walking out to the page behind the overlay. A key
  // something inside already answered (an open ⋮ menu, the choice list, a drag
  // being cancelled) is theirs: one press, one thing done.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = e => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') { onCloseRef.current(); return }
      const at = document.activeElement
      if (e.key !== 'Tab' || (at && at !== document.body)) return
      const items = [...(boxRef.current?.querySelectorAll(TABBABLE) ?? [])]
        .filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0)
      const to = e.shiftKey ? items[items.length - 1] : items[0]
      if (!to) return
      e.preventDefault()
      to.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // A drag that starts on a chart and is let go over the backdrop fires its
  // click on the backdrop. Only a press that began there closes the modal.
  const downOnBackdrop = useRef(false)

  // The ⋮ in the modal acts as the card's own: Compare turns an expanded chart
  // into the comparison, the rest go to the page.
  const onMenu = (label, t) => {
    if (label === 'Compare') { onMode('compare'); return }
    pageAction?.(label, t)
  }

  const valueOf = w => {
    const v = view.value?.(w)
    return v == null || v === '' ? null : v
  }
  const mainValue = valueOf(win)

  const panel = (w, f, head) => (
    <section className="chart-modal-panel" aria-label={head.label}>
      <div className="chart-modal-panel-head">
        <span className="chart-modal-panel-title">
          {head.title}
          {head.value != null && <span className="cval">{head.value}</span>}
          <span className="chart-modal-range">{head.range}</span>
        </span>
        {head.menu}
      </div>
      <div className="chart-modal-panel-body">
        <ChartFrameContext.Provider value={f}>{view.render(w)}</ChartFrameContext.Provider>
      </div>
    </section>
  )

  return portal(
    <div
      className="tw-modal-overlay chart-modal-overlay"
      onMouseDown={e => { downOnBackdrop.current = e.target === e.currentTarget }}
      onClick={e => {
        e.stopPropagation()
        if (e.target === e.currentTarget && downOnBackdrop.current) onClose()
        downOnBackdrop.current = false
      }}
    >
      <div
        ref={boxRef}
        className={`tw-modal chart-modal${isCompare ? ' is-compare' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            if (e.nativeEvent.defaultPrevented) return
            e.preventDefault()
            onClose()
          }
          else trapTab(e)
        }}
      >
        <div className="chart-modal-head">
          {isCompare ? (
            <div className="chart-modal-compare">
              <span id={titleId} className="sr-only">Compare {title}</span>
              <FilterSelect
                className="chart-modal-compare-select"
                label="Compare with"
                value={option.label}
                options={COMPARE_LABELS}
                onSelect={l => {
                  if (COMPARE_BY_LABEL[l]) setCompare(COMPARE_BY_LABEL[l])
                  // Picked with the pointer, the list goes and takes focus
                  // with it; it comes back to the select, inside the dialog.
                  requestAnimationFrame(() => {
                    const box = boxRef.current
                    if (box && !box.contains(document.activeElement)) box.querySelector('.chart-modal-compare-select')?.focus()
                  })
                }}
              />
            </div>
          ) : (
            <span id={titleId} className="chart-modal-title">
              {title}
              {mainValue != null && <span className="cval">{mainValue}</span>}
              <span className="chart-modal-range">{win.label}</span>
            </span>
          )}
          <span className="chart-modal-acts">
            {!isCompare && (
              <CardMenu kind="chart" title={title} total={total} compare={view.comparable !== false} onAction={onMenu} />
            )}
            <button ref={closeRef} type="button" className="tw-modal-close" onClick={onClose} aria-label="Close" title="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="chart-modal-body">
          {isCompare ? (
            <>
              {panel(win, frame, {
                label: title,
                title,
                value: mainValue,
                range: win.label,
                menu: <CardMenu kind="chart" title={title} total={total} compare={false} onAction={onMenu} />,
              })}
              {/* The earlier copy carries no ⋮: its Create Alert and Explore
                  would act on the page's window, not on the one drawn here. */}
              {panel(earlier, earlierFrame, {
                label: `${title}, ${option.label}`,
                title: option.label,
                value: valueOf(earlier),
                range: earlier.label,
                menu: null,
              })}
            </>
          ) : (
            <div className="chart-modal-panel is-solo">
              <div className="chart-modal-panel-body">
                <ChartFrameContext.Provider value={frame}>{view.render(win)}</ChartFrameContext.Provider>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
  )
}
