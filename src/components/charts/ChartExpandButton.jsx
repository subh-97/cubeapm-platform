import { useCallback, useContext, useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { ChartFrameContext } from './chartView'
import ChartModal from './ChartModal'

/**
 * Expand on its own, for a chart with no card menu: the Logs, Traces and
 * Errors histograms (a labelled button in the toolbar, beside Hide graph) and
 * an error group's chart (a boxed icon among its row's actions). It opens the chart
 * modal (ChartModal) with the one chart, larger, and no ⋮ — these charts have
 * no Compare, Create Alert or Explore to carry into it.
 *
 * `view` is a chart card's view (chartView.js); only `win`, `render(win)` and
 * optionally `value(win)` are read, since there is nothing to compare.
 *
 *   title       the chart's name: the modal's title, and the button's
 *               "Expand <title>" when it shows no label of its own
 *   label       visible text beside the glyph ('Expand graph'); left out, the
 *               button is the glyph alone, named by its title (rule 4)
 *   className   the button's look: the toolbar's 'hbtn small', or a row's
 *               boxed icon, 'row-icon-btn' 
 *
 * The click stops where it lands: the button can sit inside something that
 * opens on click (an error group's row).
 *
 * Inside a modal it draws nothing: a chart drawn there is already expanded.
 */
export default function ChartExpandButton({ title, view, label, className = 'row-icon-btn' }) {
  const [open, setOpen] = useState(false)
  const inModal = useContext(ChartFrameContext) != null
  const close = useCallback(() => setOpen(false), [])
  if (inModal) return null
  const name = `Expand ${title || 'chart'}`
  return (
    <>
      <button
        type="button"
        className={className}
        title={name}
        aria-label={label ? undefined : name}
        aria-haspopup="dialog"
        disabled={!view}
        onClick={e => { e.stopPropagation(); setOpen(true) }}
      >
        <Maximize2 aria-hidden="true" />
        {label}
      </button>
      {open && view && (
        <ChartModal mode="expand" onMode={close} onClose={close} title={title} view={{ ...view, comparable: false }} menu={false} />
      )}
    </>
  )
}
