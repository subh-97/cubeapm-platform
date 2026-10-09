import CardMenu from '@/components/CardMenu'
import SearchGlyph from '@/components/shared/SearchGlyph'
import ViewToggle from '@/components/shared/ViewToggle'
import './browser-metrics.css'

/**
 * The one panel under a Browser metric tab's summary cards: its routes, calls
 * or pages as three charts or as a table, whichever the Table | Graph switch in
 * its head says.
 *
 * It is the service page's RED panel (RedTab) as markup, so the two read as one
 * product: the switch on the left of the head, a column-aware ⋮ menu on the
 * right in table view only (the charts carry a menu each), and in table view a
 * search row under the head. The search is the tab's, because the tab filters
 * the rows it hands the table; graph view has a search in every legend instead.
 *
 *   title         what the ⋮ menu names the table ('Page Views')
 *   menuColumns   the table's figure columns, for the menu's per-column items
 *   view, onView  'graph' | 'table', owned by the page's URL (`view=`), so the
 *                 choice carries from one metric tab to the next
 *   noun          what a row is ('routes'), for the search's wording
 *   search, onSearch   the table search
 *   graph, table  the two bodies; only the one in view is mounted
 */
export default function MetricPanel({ title, menuColumns, view, onView, noun, search, onSearch, graph, table }) {
  const isGraph = view !== 'table'
  return (
    <div className="panel">
      <div className="panel-head is-divided red-table-head">
        <div className="panel-head-left red-head-left">
          <ViewToggle view={isGraph ? 'graph' : 'table'} setView={onView} ariaLabel={`Show ${noun} as`} />
        </div>
        {!isGraph && <CardMenu kind="table" title={title} columns={menuColumns} />}
      </div>
      {!isGraph && (
        <div className="red-table-search-row">
          <div className="search-with-icon">
            <SearchGlyph />
            <input
              type="search"
              className="red-table-search"
              placeholder={`Search ${noun}…`}
              aria-label={`Search ${noun}`}
              value={search}
              onChange={e => onSearch(e.target.value)}
            />
          </div>
        </div>
      )}
      {isGraph ? graph : table}
    </div>
  )
}
