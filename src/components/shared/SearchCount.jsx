/**
 * How many rows a table's search kept, in small type under its field: "12 of
 * 64 hosts". Drawn only while something is searched; otherwise the table
 * speaks for itself. Neutral text, never a status hue.
 *
 *   active        whether a search is in force
 *   shown, total  the rows the search kept, and the rows it searched
 *   noun          what a row is, plural ('hosts')
 */
export default function SearchCount({ active, shown, total, noun }) {
  if (!active) return null
  return <div className="search-count" role="status">{shown.toLocaleString()} of {total.toLocaleString()} {noun}</div>
}
