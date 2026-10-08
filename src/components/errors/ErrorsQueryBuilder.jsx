// The Errors page's search bar: the Logs/Traces query builder with the errors
// vocabulary bound in.
//
// One implementation, as with TableSearch over TableQuerySearch, so the
// grammar, the keyboard model and the chip UI cannot drift between pages. What
// differs is the nouns and the behaviours the builder lets a page opt into:
// Enter applies typed free text (typing an exception name and pressing Enter is
// this page's main gesture), value rows show their error counts, and typing a
// fragment lists the exception classes, services and endpoints that contain it.
// And matching is the original page's: `field:value` is a case-insensitive
// contains (ERROR_COLON_MATCH, which the page's evaluator uses too), and a bare
// term goes in as a substring rather than an exact phrase.

import QueryBuilder from '@/components/QueryBuilder'
import { ERROR_FIELD_CATALOG, ERROR_EXAMPLE_QUERIES, ERROR_COLON_MATCH, getErrorFieldValue } from '@/utils/errorFields'

// Module-level so the builder's value index is built once per row set, not on
// every render.
const VALUE_SUGGEST_FIELDS = ['exception', 'service', 'endpoint', 'span_name']

// A row is a whole error series, so it counts as its errors. Counted once per
// row instead, the value lists would rank an exception by how many endpoints it
// happened on, and show "3" beside a class failing thousands of requests.
const errorsInRow = row => row.count ?? 1

// Without rows the builder falls back to the log rows, which would offer log
// values for error fields. An empty list offers nothing, which is honest.
const NO_ROWS = []

export default function ErrorsQueryBuilder({
  chips, setChips, rows = NO_ROWS, recents, addRecent, onRun, onBlockedChange,
  onCopyQuery, parsePastedQuery, leading,
}) {
  return (
    <QueryBuilder
      chips={chips}
      setChips={setChips}
      rows={rows}
      recents={recents}
      addRecent={addRecent}
      onRun={onRun}
      onBlockedChange={onBlockedChange}
      onCopyQuery={onCopyQuery}
      parsePastedQuery={parsePastedQuery}
      leading={leading}
      fieldCatalog={ERROR_FIELD_CATALOG}
      getValue={getErrorFieldValue}
      rowWeight={errorsInRow}
      exampleQueries={ERROR_EXAMPLE_QUERIES}
      freeTextNoun="errors"
      freeTextMeta="Exception, message, service, endpoint, code"
      enterCommitsFreeText
      freeTextLead="contains"
      showValueCounts
      valueSuggestFields={VALUE_SUGGEST_FIELDS}
      colonMatch={ERROR_COLON_MATCH}
      placeholder="Filter errors: exception, service, endpoint, http_code… or free text"
    />
  )
}
