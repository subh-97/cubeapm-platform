import { useSortedRows } from '@/hooks/useSortedRows'
import './sortable-table.css'

// The table pieces the service, Home, Infrastructure and Browser pages share,
// so a table reads the same wherever it is: headers that sort (with
// useSortedRows in hooks/), a percentage drawn as its figure over a bar, and
// SortableTable, which builds a whole table from a list of columns. The table
// itself is a plain <table>; its look (header type, right-aligned figures, row
// lines and column rules) comes from the global th/td rules in index.css.

// A header cell that participates in column sorting. The arrow follows the
// active direction, and inactive columns show a faint arrow so the control is
// discoverable before the first click.
//
// The whole cell sorts on a click, as it always has. The label is also a real
// <button>, drawn as the label it was (sortable-table.css), so the sort is a
// Tab stop that Enter and Space press: its click bubbles to the cell's, the
// one place the toggle lives. `info` (a column's ⓘ) sits after the label and
// outside that button — a button inside a button is not one control for a
// screen reader, and the ⓘ must never sort.
export function SortableTh({ sortKey, sort, onToggle, children, align = 'right', style, info }) {
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
        <span><button type="button" className="sortable-th-btn">{children}</button>{info}</span>
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

// A column's ⓘ sits in its header, and a header sorts on click. The wrapper
// keeps a click on the ⓘ (or anywhere around it) from reaching the header, so
// opening an explanation never reorders the table. The bubble InfoTip draws is
// a child of this span too, so it would inherit the header's type - uppercase,
// unwrapped, right-aligned - and an explanation set like that is hard to read;
// the span puts body text back for everything inside it.
const TH_INFO_STYLE = {
  display: 'inline-flex', alignItems: 'center', marginLeft: 4, verticalAlign: 'middle',
  textTransform: 'none', whiteSpace: 'normal', textAlign: 'left', letterSpacing: 'normal',
}
const stopClick = e => e.stopPropagation()

// A header cell's own style: a left-aligned column says so, and a column with a
// set `width` holds it. Nothing at all for a plain right-aligned column, so its
// <th> carries no style attribute, as it never has.
function thStyle(c) {
  if (c.align !== 'left' && c.width == null) return undefined
  return {
    ...(c.align === 'left' ? { textAlign: 'left' } : null),
    ...(c.width != null ? { width: c.width } : null),
  }
}

// The table every list of figures is built from: the Infrastructure page's
// tables, and the Browser page's Page Views, Ajax Calls and Web Vitals tables.
// It is a plain <table> whose headers sort, names and identifiers in mono on
// the left, figures right-aligned in the body face, a percentage as its figure
// over a brand bar (CellBar), and nothing that colours or marks a row by how
// bad its values are. A column is
//   { key, label, render?, align?: 'left', mono?, sortKey?, sortable?, clip?,
//     title?, width?, info? }
// `sortKey` names the field to order by when what is shown is formatted (bytes,
// a rate with its unit); `sortable: false` marks a column with nothing to order
// by. `clip` caps a long name at that many px and ends it in an ellipsis, with
// `title` giving the whole of it on hover, as the service page's Endpoint
// column does. `width` sets the column's width (the service page gives its
// Endpoint column 360px, because the route is what a reader scans by). `info`
// is a node - an InfoTip - drawn after the label, explaining what the column
// measures. A table of one record, or of none, passes sortable={false}.
//
// `defaultSort` and `defaultDir` are the order before anyone clicks a header;
// with no `defaultSort` the rows keep the order they came in, which is how a
// caller hands over an order no single column expresses (worst rating first,
// then the largest figure). `className` is added to the scroller, for a page's
// own table rules. The scroller is .table-scroll, which lets a table wider than
// its panel scroll sideways instead of losing its last columns.
export function SortableTable({ columns, rows, rowKey, defaultSort = null, defaultDir = 'desc', onRowClick, empty, sortable = true, className }) {
  const { rows: sorted, sort, toggle } = useSortedRows(rows, defaultSort, defaultDir)
  const infoOf = c => (c.info != null
    ? <span className="sortable-th-info" style={TH_INFO_STYLE} onClick={stopClick}>{c.info}</span>
    : null)
  return (
    <div className={`table-scroll${className ? ` ${className}` : ''}`}>
      <table>
        <thead>
          <tr>
            {columns.map(c => (sortable && c.sortable !== false
              ? <SortableTh key={c.key} sortKey={c.sortKey ?? c.key} sort={sort} onToggle={toggle} align={c.align ?? 'right'} style={c.width != null ? { width: c.width } : undefined} info={infoOf(c)}>{c.label}</SortableTh>
              : <th key={c.key} style={thStyle(c)}>{c.label}{infoOf(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map(c => (
                <td key={c.key} className={c.mono ? 'mono' : undefined} style={c.align === 'left' ? { textAlign: 'left' } : undefined}>
                  {c.clip
                    ? <span className="cell-clip" style={{ maxWidth: c.clip }} title={c.title?.(r)}>{c.render ? c.render(r) : r[c.key]}</span>
                    : (c.render ? c.render(r) : r[c.key])}
                </td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr className="svc-empty-row"><td colSpan={columns.length}>{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
