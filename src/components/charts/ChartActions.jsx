import { useCallback, useContext, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import CardMenu, { CardActionContext } from '@/components/CardMenu'
import { ChartFrameContext } from './chartView'
import ChartModal from './ChartModal'

/**
 * The top-right corner of a chart card: Expand, then the ⋮ menu. It stands
 * where the card's bare <CardMenu kind="chart"> stood, as one element, so a
 * header laid out as "title … menu" keeps its two ends.
 *
 * Given the card's `view` (chartView.js) it owns the card's modal: Expand opens
 * the chart on its own, larger, and the ⋮'s Compare opens it against an earlier
 * window. Every other item of the ⋮ goes to the page's handler
 * (CardActionContext), as it always has. A card that can only draw the window
 * it has passes `comparable: false`, and its ⋮ offers no Compare.
 *
 * Without a `view` — a loading skeleton standing in for the card — the Expand
 * button is drawn but disabled, so the header does not shift when the card
 * replaces it, and the ⋮ is exactly the menu it was, Compare included.
 *
 * Inside a modal it draws nothing: a chart drawn there is already expanded.
 */
export default function ChartActions({ title, total, view }) {
  const [mode, setMode] = useState(null)
  const inModal = useContext(ChartFrameContext) != null
  const pageAction = useContext(CardActionContext)
  const comparable = view ? view.comparable !== false : true

  const onAction = useCallback((label, t) => {
    if (label === 'Compare' && view && comparable) { setMode('compare'); return }
    pageAction?.(label, t)
  }, [view, comparable, pageAction])
  const close = useCallback(() => setMode(null), [])

  if (inModal) return null
  const name = title || 'chart'
  return (
    <span className="card-actions">
      <button
        type="button"
        className="card-expand-btn"
        title={`Expand ${name}`}
        aria-label={`Expand ${name}`}
        aria-haspopup="dialog"
        disabled={!view}
        onClick={e => { e.stopPropagation(); setMode('expand') }}
      >
        <Maximize2 aria-hidden="true" />
      </button>
      <CardMenu kind="chart" title={title} total={total} compare={comparable} onAction={onAction} />
      {mode && view && (
        <ChartModal mode={mode} onMode={setMode} onClose={close} title={title} total={total} view={view} />
      )}
    </span>
  )
}
