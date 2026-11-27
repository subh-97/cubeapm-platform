// The Rules tab's filter bar: the Logs/Traces/Errors `QueryBuilder` with the
// alerts vocabulary bound in (as ErrorsQueryBuilder does for Errors), so the
// chip input, its overlay — fields, recent searches, saved queries, value
// suggestions — and the keyboard model are the same product the explorer pages
// teach. It is the real component, not a copy.
//
// The alerts fields are strings, so matching is a case-insensitive contains
// (ALERT_COLON_MATCH), a bare term is a name substring, and Enter commits it.
// `fieldCatalog` is passed in (the static catalog plus the live `tag.<key>`
// keys), and `fetchFieldValues` gives each field's values with counts straight
// from the rules, so a multi-value field (receiver group, tags) suggests its
// values correctly. The chips are driven by the shared selection
// (alertFilters.js) so a chip here and a tick in the rail are one state.

import QueryBuilder from '@/components/QueryBuilder'
import { ALERT_FIELD_CATALOG, ALERT_EXAMPLE_QUERIES, ALERT_COLON_MATCH, getAlertFieldValue } from './alertFilters'

// Single-value fields whose values the "matching values" section searches as
// you type a fragment (type "payment", get the rule). Multi-value fields are
// left to the value phase, where fetchFieldValues lists them exactly.
const VALUE_SUGGEST_FIELDS = ['alert', 'group']
const NO_ROWS = []

export default function AlertsQueryBuilder({
  chips, setChips, rows = NO_ROWS, recents, addRecent, onRun, onBlockedChange, fieldCatalog, fetchFieldValues, leading,
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
      leading={leading}
      fieldCatalog={fieldCatalog ?? ALERT_FIELD_CATALOG}
      getValue={getAlertFieldValue}
      fetchFieldValues={fetchFieldValues}
      exampleQueries={ALERT_EXAMPLE_QUERIES}
      freeTextNoun="rules"
      freeTextMeta="Rule name"
      enterCommitsFreeText
      freeTextLead="contains"
      showValueCounts
      valueSuggestFields={VALUE_SUGGEST_FIELDS}
      colonMatch={ALERT_COLON_MATCH}
      placeholder="Filter rules: state, group, tag.…, receiver_group… or a name"
    />
  )
}
