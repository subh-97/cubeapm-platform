import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Pause } from 'lucide-react'
import FacetGroup from '@/components/explorer/FacetGroup'
import SearchCount from '@/components/shared/SearchCount'
import { useRevealRows } from '@/hooks/useRevealRows'
import {
  ALERT_FILTERS, filterLabel, tagKeysOf, buildFilterValues,
  selectionFromUrl, selectionToPatch, hasSelection, toggleFilterValue, setTextFilter,
  clearSelection, filterRules, explainNoMatches,
  selectionToChips, chipsToSelection,
} from './rulesQuery'
import { ALERT_FIELD_CATALOG } from './alertFilters'
import { useRecentSearches } from '@/hooks/useRecentSearches'
import { listRules, asksForPaused, foldText, isFolded, rowStep, ruleDomId, ruleKey } from './rulesList'
import RuleRow from './RuleRow'
import RuleDetails from './RuleDetails'
import AlertsQueryBuilder from './AlertsQueryBuilder'
import FacetToggle from './FacetToggle'
import FacetText from './FacetText'
import { RowsSkeleton, NoRules, NoMatches } from './ListStates'

const NO_OP = () => {}

/**
 * The rules list in the explorer frame Logs, Traces and Errors already teach
 * (D3, revised 2026-11-26): a filter rail and a chip bar that are one state,
 * and the results in one list in severity order, the viewer's pinned rules at
 * its head (`pinned`, a Set of ids as text) and the paused ones folded at its
 * end. The rail and the bar both read and write one selection (`alertFilters`),
 * which lives in the URL (`url`, through `onUrlChange`) so a link reproduces it;
 * what is open and folded is this page's own, and what is pinned the viewer's.
 */
export default function RulesTable({
  rules, url, onUrlChange, loading, expanded, onToggleRow, pinned = NO_PINS, nowSec, seriesFor, handlers, suggestions, onNewRule, onSuggest,
}) {
  const selection = useMemo(() => selectionFromUrl({ facets: url.facets, q: url.q }), [url.facets, url.q])
  const tagKeys = useMemo(() => tagKeysOf(rules), [rules])
  const facetOptions = useMemo(() => buildFilterValues(rules, selection, tagKeys), [rules, selection, tagKeys])
  const filtered = useMemo(() => filterRules(rules, selection), [rules, selection])
  const unfoldPaused = asksForPaused(selection)

  // A rule a link names is shown open, wherever it is: if it is paused, the
  // fold is opened up front.
  const [foldOpen, setFoldOpen] = useState(() => !!url.ruleId && isFolded(listRules(filtered, { pinned }), url.ruleId))
  const list = useMemo(() => listRules(filtered, { foldOpen, unfoldPaused, pinned }), [filtered, foldOpen, unfoldPaused, pinned])

  // The row whose pin was just pressed, while focus stays with it (below).
  const [pinRow, setPinRow] = useState(null)

  // The rail controls and the chip bar edit one selection; each write serializes
  // it back to the URL (and drops the old `q`).
  const patch = useCallback(next => onUrlChange(selectionToPatch(next)), [onUrlChange])
  // A ref to the live selection so several toggles fired in one synchronous go
  // accumulate — the rail's "Clear" clears a facet value by value, and each
  // write is a whole-URL replace, so without this only the last value would
  // survive (the shared FacetGroup assumes functional-update accumulation).
  const selRef = useRef(selection)
  selRef.current = selection
  const toggleValue = useCallback((key, value) => {
    const next = toggleFilterValue(selRef.current, key, value)
    selRef.current = next
    patch(next)
  }, [patch])
  const setToggle = useCallback((key, value) => {
    const next = { ...selection }
    if (value == null) delete next[key]
    else next[key] = new Set([value])
    patch(next)
  }, [patch, selection])
  const setText = useCallback((key, value) => patch(setTextFilter(selection, key, value)), [patch, selection])
  const clearAll = useCallback(() => patch(clearSelection()), [patch])

  // The filter bar is the shared QueryBuilder: its chips are the selection, and
  // a commit writes the selection back to the URL. Its field catalogue adds the
  // live tag keys; its value suggestions and counts come from the rules.
  const chips = useMemo(() => selectionToChips(selection), [selection])
  const setChips = useCallback(next => patch(chipsToSelection(next)), [patch])
  // The bar suggests the essential fields only (ALERT_FIELD_CATALOG); every
  // other filter is still typeable (and on the rail), and its values still come
  // from the rules through fetchFieldValues.
  const allValues = useMemo(() => buildFilterValues(rules, {}, tagKeys), [rules, tagKeys])
  const fetchFieldValues = useCallback(field => Promise.resolve(allValues[field] ?? []), [allValues])
  const { recents, addRecent } = useRecentSearches()

  // `rule_id` scrolls its rule into view, as production does: once per id,
  // after its fold has opened and its row is in the page.
  const listRef = useRef(null)
  const scrolledTo = useRef(null)
  useEffect(() => {
    const id = url.ruleId
    if (!id || scrolledTo.current === id) return
    if (isFolded(list, id)) {
      setFoldOpen(true)
      return
    }
    const el = listRef.current?.querySelector(`[data-rule-id="${CSS.escape(String(id))}"]`)
    if (!el) return
    scrolledTo.current = id
    el.scrollIntoView({ block: 'center' })
  }, [url.ruleId, list])

  // ↑ / ↓ (and Home / End) move between the rows' toggles (D17).
  const onRowKey = useCallback((e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const toggles = [...(listRef.current?.querySelectorAll('[data-row-toggle]') ?? [])]
    const to = rowStep(toggles.indexOf(e.currentTarget), toggles.length, e.key)
    if (to == null) return
    e.preventDefault()
    toggles[to].focus()
  }, [])

  // Where focus last was in the list. A row that leaves while it holds focus
  // (paused into the fold, deleted, filtered away) hands focus to the row that
  // took its place, else the one before it, else the fold, rather than
  // dropping it to the page (7c).
  const lastRow = useRef(null)
  const onListFocus = useCallback((e) => {
    const row = e.target.closest?.('[data-rule-id]')
    if (!row || !listRef.current) return
    lastRow.current = { id: row.dataset.ruleId, index: [...listRef.current.querySelectorAll('.rtab-rule')].indexOf(row) }
    // Focus on another row lets go of the row whose pin was pressed.
    setPinRow(cur => (cur && ruleKey(cur.id) !== row.dataset.ruleId ? null : cur))
  }, [])
  useEffect(() => {
    const last = lastRow.current
    const el = listRef.current
    if (!last || !el) return
    const active = document.activeElement
    if (active && active !== document.body) return
    if (el.querySelector(`[data-rule-id="${CSS.escape(last.id)}"]`)) return
    const rows = [...el.querySelectorAll('.rtab-rule [data-row-toggle]')]
    const target = rows[Math.min(last.index, rows.length - 1)] ?? el.querySelector('.rtab-fold')
    lastRow.current = null
    target?.focus()
  })

  // A pin moves its row (to the head of the list, or back to its place), and
  // the pin's button goes with it, keeping focus. `pinRow` is drawn wherever
  // it sorts (useRevealRows' keep), and followed again when its pin changes by
  // the toast's Undo or ⌘Z. From the keyboard the page follows the row; from a
  // pointer it stays where the reader is (the browser's scroll anchoring would
  // carry it to the row's new place), and the toast says where the row went.
  const anchor = useRef(null)
  const rowHandlers = useMemo(() => ({
    ...handlers,
    onTogglePin: (view, e) => {
      const keyboard = !e?.detail
      const scroller = listRef.current?.closest('.rtab')
      anchor.current = keyboard || !scroller ? null : { scroller, top: scroller.scrollTop }
      setPinRow({ id: view.id, keyboard })
      handlers.onTogglePin?.(view)
    },
  }), [handlers])
  useLayoutEffect(() => {
    const a = anchor.current
    if (!a) return
    anchor.current = null
    if (a.scroller.scrollTop !== a.top) a.scroller.scrollTop = a.top
  })
  useEffect(() => {
    if (!pinRow) return
    const pin = listRef.current?.querySelector(`[data-rule-id="${CSS.escape(String(pinRow.id))}"] .rtab-pin`)
    if (!pin) return
    // Focus that went elsewhere (to the toast's Undo, say) stays there.
    const active = document.activeElement
    if (active !== pin && active && active !== document.body) return
    if (active !== pin) pin.focus({ preventScroll: true })
    if (pinRow.keyboard) pin.closest('.rtab-rule')?.scrollIntoView({ block: 'nearest' })
  }, [pinned, pinRow])

  const anySelection = hasSelection(selection)

  // Twenty rules draw, then twenty more as the list's end scrolls near
  // (useRevealRows); the rule a link names, and the one whose pin was just
  // pressed, are drawn wherever they sit. Only a new search or facet starts
  // again at twenty: the fold opened or a rule deleted keeps what is drawn.
  const indexOf = id => (id == null ? -1 : list.rules.findIndex(v => ruleKey(v.id) === ruleKey(id)))
  const keep = Math.max(url.ruleId ? indexOf(url.ruleId) : -1, indexOf(pinRow?.id))
  const { rows: drawnRules, sentinel } = useRevealRows(list.rules, keep, JSON.stringify(url.facets ?? {}))
  const drawnIds = new Set(drawnRules.map(v => v.id))

  let body
  if (loading) body = <RowsSkeleton />
  else if (rules.length === 0) body = <NoRules suggestions={suggestions} onNewRule={onNewRule} onSuggest={onSuggest} />
  else if (filtered.length === 0) body = <NoMatches explanation={explainNoMatches(rules, selection)} onClear={clearAll} />
  else {
    body = (
      <div ref={listRef} className="rtab-rules" onFocus={onListFocus}>
        {drawnRules.map((view, i) => {
          const open = expanded.has(ruleKey(view.id))
          const domId = ruleDomId('rtab-rule', view.id)
          const panelId = `${domId}-details`
          return (
            <Fragment key={view.id}>
              <RuleRow
                view={view}
                domId={domId}
                panelId={panelId}
                open={open}
                pinned={i < list.pinnedCount}
                onToggle={onToggleRow}
                onRowKey={onRowKey}
                nowSec={nowSec}
                seriesFor={seriesFor}
                handlers={rowHandlers}
              />
              {open && <RuleDetails view={view} panelId={panelId} nowSec={nowSec} seriesFor={seriesFor} handlers={handlers} />}
            </Fragment>
          )
        })}
        {/* A closed fold waits for the rules above it to be drawn; an open one
            keeps its button, which was just pressed. */}
        {list.pausedCount > 0 && !unfoldPaused && (list.foldOpen || list.rules.every(v => drawnIds.has(v.id))) && (
          <button type="button" className="rtab-fold" aria-expanded={list.foldOpen} onClick={() => setFoldOpen(o => !o)}>
            <Pause aria-hidden="true" />
            {list.foldOpen ? `Hide ${foldText(list.pausedCount)}` : foldText(list.pausedCount)}
            {!list.foldOpen && <ChevronRight aria-hidden="true" />}
          </button>
        )}
        {sentinel}
      </div>
    )
  }

  return (
    <div className="rtab-frame">
      <div className="logs-filters" role="region" aria-label="Filters">
        <div className="logs-filters-head">
          <span>Filters</span>
          {anySelection && <button type="button" className="logs-filters-clear" onClick={clearAll}>Clear all</button>}
        </div>
        <div className="logs-filters-scroll">
          {ALERT_FILTERS.map((f) => {
            if (f.control === 'enum') {
              return (
                <FacetGroup
                  key={f.key}
                  title={f.label}
                  options={facetOptions[f.key] ?? EMPTY_OPTS}
                  selected={selection[f.key] ?? EMPTY}
                  onToggle={(_, v) => toggleValue(f.key, v)}
                  renderLabel={v => filterLabel(f.key, v)}
                />
              )
            }
            if (f.control === 'toggle') {
              return (
                <FacetToggle key={f.key} title={f.label} values={facetOptions[f.key] ?? EMPTY_OPTS} selected={selection[f.key] ?? EMPTY} onSet={v => setToggle(f.key, v)} renderLabel={v => filterLabel(f.key, v)} />
              )
            }
            if (f.control === 'text') {
              return (
                <FacetText key={f.key} title={f.label} placeholder={f.placeholder} value={[...(selection[f.key] ?? EMPTY)][0] ?? ''} onChange={v => setText(f.key, v)} />
              )
            }
            if (f.control === 'tag') {
              return tagKeys.map(k => (
                <FacetGroup
                  key={`tag.${k}`}
                  title={k}
                  options={facetOptions[`tag.${k}`] ?? EMPTY_OPTS}
                  selected={selection[`tag.${k}`] ?? EMPTY}
                  onToggle={(_, v) => toggleValue(`tag.${k}`, v)}
                />
              ))
            }
            return null
          })}
        </div>
      </div>

      <div className="rtab-main">
        <div className="rtab-toolbar">
          <div className="rtab-bar logs-query-bar">
            <AlertsQueryBuilder
              chips={chips}
              setChips={setChips}
              rows={rules}
              recents={recents}
              addRecent={addRecent}
              onRun={NO_OP}
              fieldCatalog={ALERT_FIELD_CATALOG}
              fetchFieldValues={fetchFieldValues}
            />
          </div>
          <div className="rtab-quick">
            <SearchCount active={anySelection} shown={filtered.length} total={rules.length} noun="rules" />
          </div>
        </div>
        {body}
      </div>
    </div>
  )
}

const EMPTY = new Set()
const NO_PINS = new Set()
const EMPTY_OPTS = []
