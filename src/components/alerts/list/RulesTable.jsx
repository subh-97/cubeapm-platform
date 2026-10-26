import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Pause } from 'lucide-react'
import FacetGroup from '@/components/explorer/FacetGroup'
import TableQuerySearch from '@/components/TableQuerySearch'
import { statusForAlertState } from '@/utils/status'
import {
  RULE_FACETS, RULE_SEARCH_FIELDS, facetValueLabel, selectionFromUrl, hasSelection, toggleFacetValue,
  clearRuleFacets, buildRuleFacets, filterRules, parseRuleSearch, searchValuesFor, explainNoMatches,
} from './rulesQuery'
import {
  listGroups, asksForPaused, groupHeaderText, foldText, groupKeyOf, rowStep, ruleDomId, ruleKey,
} from './rulesList'
import RuleRow from './RuleRow'
import RuleDetails from './RuleDetails'
import { RowsSkeleton, NoRules, NoMatches } from './ListStates'

const FACET_BY_TITLE = new Map(RULE_FACETS.map(f => [f.title, f]))

/**
 * The rules list in the explorer frame Logs, Traces and Errors already teach
 * (D3): the facet rail, a field:value search, and the results in severity
 * order, under the groups people put them in. What it is filtered to lives in
 * the URL (`url`, written back through `onUrlChange`), so a link reproduces it;
 * what is open and folded is this page's own.
 */
export default function RulesTable({
  rules, url, onUrlChange, loading, expanded, onToggleRow, nowSec, agoText, seriesFor, handlers, suggestions, onNewRule, onSuggest,
}) {
  const selection = useMemo(() => selectionFromUrl(url.facets), [url.facets])
  const searchNode = useMemo(() => parseRuleSearch(url.q), [url.q])
  const facetOptions = useMemo(() => buildRuleFacets(rules, selection), [rules, selection])
  const filtered = useMemo(() => filterRules(rules, selection, searchNode), [rules, selection, searchNode])
  const unfoldPaused = asksForPaused(selection, url.q)

  // A rule a link names is shown open, wherever it is: its group's paused
  // fold is opened up front, and a group it sits in is never collapsed.
  const [openFolds, setOpenFolds] = useState(() => {
    if (!url.ruleId) return new Set()
    const key = groupKeyOf(listGroups(filtered), url.ruleId)
    return key ? new Set([key]) : new Set()
  })
  const [collapsed, setCollapsed] = useState(() => new Set())
  const groups = useMemo(
    () => listGroups(filtered, { openFolds, unfoldPaused }),
    [filtered, openFolds, unfoldPaused],
  )

  // The search box keeps its own text; clearing it from outside (the empty
  // state's Clear filters) remounts it empty.
  const [searchEpoch, setSearchEpoch] = useState(0)

  const toggleFacet = useCallback((title, value) => {
    const facet = FACET_BY_TITLE.get(title)
    if (facet) onUrlChange({ facets: toggleFacetValue(url.facets, facet.key, value) })
  }, [onUrlChange, url.facets])
  const clearFacets = () => onUrlChange({ facets: clearRuleFacets(url.facets) })
  const clearAll = () => {
    onUrlChange({ facets: clearRuleFacets(url.facets), q: '' })
    setSearchEpoch(n => n + 1)
  }
  const applySearch = useCallback((text) => {
    const q = (text ?? '').trim()
    if (q !== (url.q ?? '').trim()) onUrlChange({ q })
  }, [onUrlChange, url.q])
  const valuesFor = useCallback(field => searchValuesFor(rules, field), [rules])

  const toggleSet = setter => key => setter(cur => {
    const next = new Set(cur)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const toggleFold = toggleSet(setOpenFolds)
  const toggleGroup = toggleSet(setCollapsed)

  // `rule_id` scrolls its rule into view, as production does: once per id,
  // after its fold has opened and its row is in the page.
  const listRef = useRef(null)
  const scrolledTo = useRef(null)
  useEffect(() => {
    const id = url.ruleId
    if (!id || scrolledTo.current === id) return
    const key = groupKeyOf(groups, id)
    if (key && collapsed.has(key)) {
      setCollapsed(cur => { const next = new Set(cur); next.delete(key); return next })
      return
    }
    const group = groups.find(g => g.key === key)
    if (group && group.paused.some(r => ruleKey(r.id) === ruleKey(id))) {
      setOpenFolds(cur => new Set(cur).add(key))
      return
    }
    const el = listRef.current?.querySelector(`[data-rule-id="${CSS.escape(String(id))}"]`)
    if (!el) return
    scrolledTo.current = id
    el.scrollIntoView({ block: 'center' })
  }, [url.ruleId, groups, collapsed])

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
  // (paused into its group's fold, deleted, filtered away) hands focus to the
  // row that took its place, else its group's fold, else its group's header,
  // rather than dropping it to the page (7c).
  const lastRow = useRef(null)
  const onListFocus = useCallback((e) => {
    const row = e.target.closest?.('[data-rule-id]')
    const group = e.target.closest?.('.rtab-group')
    if (!row || !group || !listRef.current) return
    lastRow.current = {
      id: row.dataset.ruleId,
      group: [...listRef.current.querySelectorAll('.rtab-group')].indexOf(group),
      index: [...group.querySelectorAll('.rtab-rule')].indexOf(row),
    }
  }, [])
  useEffect(() => {
    const last = lastRow.current
    const list = listRef.current
    if (!last || !list) return
    const active = document.activeElement
    if (active && active !== document.body) return
    if (list.querySelector(`[data-rule-id="${CSS.escape(last.id)}"]`)) return
    const group = list.querySelectorAll('.rtab-group')[last.group] ?? list.querySelector('.rtab-group')
    if (!group) return
    const rows = [...group.querySelectorAll('.rtab-rule [data-row-toggle]')]
    const target = rows[Math.min(last.index, rows.length - 1)]
      ?? group.querySelector('.rtab-fold')
      ?? group.querySelector('.rtab-group-toggle')
    lastRow.current = null
    target?.focus()
  })

  const anySelection = hasSelection(selection)

  let body
  if (loading) body = <RowsSkeleton />
  else if (rules.length === 0) body = <NoRules suggestions={suggestions} onNewRule={onNewRule} onSuggest={onSuggest} />
  else if (filtered.length === 0) body = <NoMatches explanation={explainNoMatches(rules, selection, url.q)} onClear={clearAll} />
  else {
    body = (
      <div ref={listRef} className="rtab-groups" onFocus={onListFocus}>
        {groups.map(g => {
          const headId = ruleDomId('rtab-g', g.key, 'head')
          const isCollapsed = collapsed.has(g.key)
          const worst = g.rules[0] ?? g.paused[0]
          return (
            <section key={g.key} className="rtab-group" aria-labelledby={headId}>
              <h3 className="rtab-group-head">
                <button
                  type="button"
                  id={headId}
                  className="rtab-group-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleGroup(g.key)}
                >
                  <ChevronDown aria-hidden="true" />
                  <span className={`status-dot ${statusForAlertState(worst?.state, worst?.severity)}`} aria-hidden="true" />
                  <span>{g.label}</span>
                  <span className="rtab-group-count">{groupHeaderText(g)}</span>
                </button>
              </h3>
              {!isCollapsed && (
                <>
                  {g.rules.map(view => {
                    const open = expanded.has(ruleKey(view.id))
                    const domId = ruleDomId('rtab-rule', g.key, view.id)
                    const panelId = `${domId}-details`
                    return (
                      <Fragment key={view.id}>
                        <RuleRow
                          view={view}
                          domId={domId}
                          panelId={panelId}
                          open={open}
                          onToggle={onToggleRow}
                          onRowKey={onRowKey}
                          nowSec={nowSec}
                          agoText={agoText}
                          seriesFor={seriesFor}
                          handlers={handlers}
                        />
                        {open && <RuleDetails view={view} panelId={panelId} nowSec={nowSec} seriesFor={seriesFor} handlers={handlers} />}
                      </Fragment>
                    )
                  })}
                  {g.pausedCount > 0 && !unfoldPaused && (
                    <button type="button" className="rtab-fold" aria-expanded={g.foldOpen} onClick={() => toggleFold(g.key)}>
                      <Pause aria-hidden="true" />
                      {g.foldOpen ? `Hide ${foldText(g.pausedCount)}` : foldText(g.pausedCount)}
                      {!g.foldOpen && <ChevronRight aria-hidden="true" />}
                    </button>
                  )}
                </>
              )}
            </section>
          )
        })}
      </div>
    )
  }

  return (
    <div className="rtab-frame">
      <div className="logs-filters" role="region" aria-label="Filters">
        <div className="logs-filters-head">
          <span>Filters</span>
          {anySelection && <button type="button" className="logs-filters-clear" onClick={clearFacets}>Clear all</button>}
        </div>
        <div className="logs-filters-scroll">
          {RULE_FACETS.map(f => (
            <FacetGroup
              key={f.key}
              title={f.title}
              options={facetOptions[f.key]}
              selected={selection[f.key] ?? EMPTY}
              onToggle={toggleFacet}
              renderLabel={f.label ? v => facetValueLabel(f.key, v) : undefined}
            />
          ))}
        </div>
      </div>

      <div className="rtab-main">
        <div className="rtab-toolbar">
          <TableQuerySearch
            key={searchEpoch}
            defaultValue={url.q ?? ''}
            fields={RULE_SEARCH_FIELDS}
            onApply={applySearch}
            suggest
            valuesFor={valuesFor}
          />
        </div>
        {body}
      </div>
    </div>
  )
}

const EMPTY = new Set()
