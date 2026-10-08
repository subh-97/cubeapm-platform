// The table pieces the service, Home and Infrastructure pages share, so a
// table reads the same wherever it is: headers that sort (with useSortedRows
// in hooks/), and a percentage drawn as its figure over a bar. The table itself is a plain <table>; its
// look (header type, right-aligned figures, row lines and column rules) comes
// from the global th/td rules in index.css.

// A header cell that participates in column sorting. The arrow follows the
// active direction, and inactive columns show a faint arrow so the control is
// discoverable before the first click.
export function SortableTh({ sortKey, sort, onToggle, children, align = 'right', style }) {
  const active = sort?.key === sortKey
  const dir = active ? sort.dir : null
  return (
    <th
      className="sortable-th"
      style={{ textAlign: align, cursor: 'pointer', userSelect: 'none', ...style }}
      onClick={() => onToggle(sortKey)}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className={`sortable-th-inner${align === 'left' ? ' align-left' : ''}`}>
        <span>{children}</span>
        <svg className={`sortable-th-arrow${active ? ' active' : ''}${dir === 'asc' ? ' asc' : ''}`}
          viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v8M9 13l3 3 3-3" />
        </svg>
      </span>
    </th>
  )
}

// A percentage cell: the figure on top and a thin bar beneath it (.cell-bar's
// column-reverse puts the bar second). `fill` is the bar's width in percent,
// passed separately because a small rate is drawn scaled up to stay visible
// (error % is drawn ×12). The bar is always the brand colour: a table cell
// does not say how severe its value is.
export function CellBar({ fill, children }) {
  return (
    <span className="cell-bar">
      <span className="track"><span className="fill" style={{ width: `${Math.max(0, Math.min(100, fill))}%`, background: 'var(--brand)' }} /></span>
      <span>{children}</span>
    </span>
  )
}
