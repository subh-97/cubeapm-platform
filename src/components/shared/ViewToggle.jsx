// The Table | Graph switch at the head of a panel that can show its figures
// either way: the service page's RED panel, and the Browser page's Page Views,
// Ajax Calls and Web Vitals panels. Each button carries its name as well as its
// glyph, so the choice reads without hovering.
//
// `options` lets a panel offer other views, as [{ id, label, title?, icon? }]
// in the order they are drawn; `icon` is a node. Without it the switch is the
// RED panel's own, Table first, and any `view` that is not 'graph' shows Table
// as chosen, as it always has. `ariaLabel` names the group for a screen
// reader; without it the markup is exactly what the RED panel has always drawn.

const TABLE_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>
)
const GRAPH_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
)

const TABLE_GRAPH = [
  { id: 'table', label: 'Table', title: 'Table view', icon: TABLE_ICON },
  { id: 'graph', label: 'Graph', title: 'Graph view', icon: GRAPH_ICON },
]

export default function ViewToggle({ view, setView, options, ariaLabel }) {
  const list = options ?? TABLE_GRAPH
  const current = options ? view : (view === 'graph' ? 'graph' : 'table')
  return (
    <div className="view-toggle" role={ariaLabel ? 'group' : undefined} aria-label={ariaLabel}>
      {list.map(o => {
        const active = o.id === current
        return (
          <button
            key={o.id}
            type="button"
            className={`view-toggle-btn${active ? ' active' : ''}`}
            onClick={() => setView(o.id)}
            title={o.title ?? `${o.label} view`}
            aria-pressed={active}
          >
            {o.icon}
            <span>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
