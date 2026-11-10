import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, SearchX, X } from 'lucide-react'
import PageBar from '@/components/layout/PageBar'
import EmptyState from '@/components/shared/EmptyState'
import FilterSelect from '@/components/shared/FilterSelect'
import SearchGlyph from '@/components/shared/SearchGlyph'
import TemplateRail from '@/components/alerts/templates/TemplateRail'
import TemplateCard from '@/components/alerts/templates/TemplateCard'
import { CategoryMark } from '@/components/alerts/templates/TemplateMarks'
import { useAlerts } from '@/hooks/useAlerts'
import { draftFromPayload, ruleFromDraft } from '@/utils/alerts/editorDraft'
import { tiersOf } from '@/utils/alerts/condition'
import {
  RULE_TEMPLATES, DOMAINS, SUBDOMAINS, PROBLEM_TYPES, SOURCES_IN_USE, URGENCIES,
  filterTemplates, templateCounts, templatePayload, rulesUsing, visitingIn,
} from '@/utils/alerts/ruleTemplates'
import { parseTemplatesSearch, templatesSearch } from '@/utils/alerts/templatesUrl'
import { routeUrl } from '@/utils/route'
import './alerts-view.css'
import '@/components/alerts/templates/alert-templates.css'

const ALERTS_PATH = routeUrl({ view: 'alerts' })
const NEW_RULE_PATH = routeUrl({ view: 'alertEditor', ruleId: null })
const isPlain = e => !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
const typing = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

// The filters' options as FilterSelect takes them, words in, ids out.
const byLabel = list => Object.fromEntries(list.map(x => [x.label, x.id]))
const labelOf = (list, id) => list.find(x => x.id === id)?.label ?? ''

// Each template's query as the rule list holds it, for "In use": worked out
// once, the way the editor would build the rule.
const BASE_QUERY = new Map(RULE_TEMPLATES.map(t => [t.id, tiersOf(ruleFromDraft(draftFromPayload(templatePayload(t)))).query]))

/**
 * /alerts/templates — Browse Templates (docs/decisions/alerts-page.md). The
 * catalogue in two layers: a rail of Domains and their Sub-domains, a search
 * across names, parents and aliases, filters for problem type, data source
 * and urgency, and a card per template. "Use template" opens the editor on it
 * through App, as every "Create alert" does; the editor's crumb leads back
 * here. Where the view is lives in the query string (templatesUrl.js).
 *
 * Configuration, not history: no time picker (D16).
 */
export default function AlertTemplatesView({ goHome, timeRange, setTimeRange, onOpenLink }) {
  const navigate = useNavigate()
  const location = useLocation()
  const alerts = useAlerts()
  const view = useMemo(() => parseTemplatesSearch(location.search), [location.search])
  const searchRef = useRef(null)
  const scopeRef = useRef(null)

  const setView = useCallback((patch) => {
    const next = templatesSearch({ ...view, ...patch })
    if (next !== location.search) navigate({ search: next }, { replace: true })
  }, [view, location.search, navigate])

  const scope = { domain: view.domain, sub: view.sub }
  const filters = { q: view.q, problem: view.problem, source: view.source, urgency: view.urgency }
  const filtered = view.q || view.problem || view.source || view.urgency
  const counts = templateCounts(RULE_TEMPLATES, filters)
  const shown = filterTemplates(RULE_TEMPLATES, scope, filters)
  // What the scope holds itself, as the rail counts it; the rest are listed here from elsewhere.
  const homed = shown.filter(t => !visitingIn(t, scope)).length
  const anywhere = filterTemplates(RULE_TEMPLATES, {}, filters).length

  // `/` reaches the search from anywhere on the page (D17).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(document.activeElement)) return
      if (document.querySelector('[role="dialog"], [role="listbox"]')) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const goHomeLink = (e) => { if (!isPlain(e)) return; e.preventDefault(); goHome?.() }
  const goTo = href => (e) => { if (!isPlain(e)) return; e.preventDefault(); navigate(href) }
  const use = t => onOpenLink?.({ view: 'alertEditor', ...templatePayload(t) })

  const scoped = Boolean(view.domain || view.sub)
  const scopeLabel = view.sub ? SUBDOMAINS[view.sub].label : view.domain ? DOMAINS.find(d => d.id === view.domain).label : 'All templates'
  const scopeIcon = view.sub ? SUBDOMAINS[view.sub].icon : view.domain ? DOMAINS.find(d => d.id === view.domain).icon : null
  const scopeParent = view.sub ? DOMAINS.find(d => d.id === view.domain)?.label : null

  // A control that leaves with its own click hands focus on (D17): a clear to
  // the search, "Show all" to the results' heading.
  const clearSearch = () => { setView({ q: '' }); searchRef.current?.focus() }
  const clearFilters = () => { setView({ q: '', problem: null, source: null, urgency: null }); searchRef.current?.focus() }
  const rescope = (s) => { setView(s); scopeRef.current?.focus() }

  // The empty state names what emptied the list: the search, then the filters.
  const active = [
    view.problem && labelOf(PROBLEM_TYPES, view.problem),
    view.source && labelOf(SOURCES_IN_USE, view.source),
    view.urgency && `${labelOf(URGENCIES, view.urgency)} urgency`,
  ].filter(Boolean)
  const offerElsewhere = Boolean(anywhere && scoped)
  const emptyTitle = view.q.trim()
    ? `No templates${scoped ? ` in ${scopeLabel}` : ''} match “${view.q.trim()}”${active.length ? ` with ${active.join(', ')}` : ''}`
    : `No ${scoped ? `${scopeLabel} ` : ''}templates with ${active.join(', ')}`

  return (
    <>
      <PageBar
        timeRange={timeRange}
        setTimeRange={setTimeRange}
        showTime={false}
        actions={(
          <a className="hbtn" href={NEW_RULE_PATH} onClick={goTo(NEW_RULE_PATH)}>
            <Plus aria-hidden="true" />Create from scratch
          </a>
        )}
      >
        <a href="/" onClick={goHomeLink}>CubeAPM</a>
        <span className="sep">/</span>
        <a href={ALERTS_PATH} onClick={goTo(ALERTS_PATH)}>Alerts</a>
        <span className="sep">/</span>
        <span className="current">Browse Templates</span>
      </PageBar>

      {/* The frame follows the bar directly, so the bar sits flush on it, as
          the Runtime tab's does (index.css, .card-crumbs:has(+ .svc-main)). */}
      <div className="svc-main has-rail tpl-page">
        <h1 className="sr-only">Browse Templates</h1>
        <div className="runtime-layout">
          <TemplateRail scope={scope} counts={counts} onScope={s => setView(s)} />

          <div className="runtime-main tpl-main">
            <div className="tpl-toolbar">
              <div className="svc-search tpl-search">
                <SearchGlyph />
                <input
                  ref={searchRef}
                  type="text"
                  value={view.q}
                  onChange={e => setView({ q: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Escape' && view.q) { e.preventDefault(); clearSearch() } }}
                  placeholder="Search by name, integration or alias: lag, k8s, rds…"
                  aria-label="Search templates"
                  spellCheck={false}
                  autoComplete="off"
                />
                {view.q && (
                  <button type="button" className="svc-search-clear" aria-label="Clear search" title="Clear search" onClick={clearSearch}>
                    <X aria-hidden="true" />
                  </button>
                )}
                <kbd className="tpl-kbd" aria-hidden="true">/</kbd>
              </div>
              <FilterSelect
                label="Problem type" className="tpl-filter" clearLabel="All problem types" placeholder="All"
                value={labelOf(PROBLEM_TYPES, view.problem)} options={PROBLEM_TYPES.map(x => x.label)}
                onSelect={v => setView({ problem: byLabel(PROBLEM_TYPES)[v] ?? null })}
              />
              <FilterSelect
                label="Data source" className="tpl-filter" clearLabel="All data sources" placeholder="All"
                value={labelOf(SOURCES_IN_USE, view.source)} options={SOURCES_IN_USE.map(x => x.label)}
                onSelect={v => setView({ source: byLabel(SOURCES_IN_USE)[v] ?? null })}
              />
              <FilterSelect
                label="Urgency" className="tpl-filter" clearLabel="All urgencies" placeholder="All"
                value={labelOf(URGENCIES, view.urgency)} options={URGENCIES.map(x => x.label)}
                onSelect={v => setView({ urgency: byLabel(URGENCIES)[v] ?? null })}
              />
            </div>

            <div className="tpl-results-head">
              <h2 className="tpl-scope" ref={scopeRef} tabIndex={-1}>
                {scopeIcon && <CategoryMark icon={scopeIcon} size={16} />}
                {scopeLabel}
              </h2>
              <span className="tpl-scope-meta" role="status">
                {scopeParent && <>{scopeParent} · </>}
                {homed} {homed === 1 ? 'template' : 'templates'}
              </span>
              {/* The empty state offers its own clear; one is enough. */}
              {filtered && (shown.length > 0 || offerElsewhere) && (
                <button type="button" className="hbtn small tpl-clear" onClick={clearFilters}>Clear search and filters</button>
              )}
            </div>

            {shown.length ? (
              <ul className="tpl-grid">
                {shown.map(t => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    usedBy={rulesUsing(t, alerts.rules, BASE_QUERY.get(t.id))}
                    onUse={use}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={SearchX}
                className="tpl-empty"
                title={emptyTitle}
                description={offerElsewhere
                  ? `${anywhere} ${anywhere === 1 ? 'template matches' : 'templates match'} in other categories.`
                  : 'Templates for errors, latency, traffic and saturation across services, hosts, Kubernetes and databases live here. Try another word, or clear a filter.'}
                action={offerElsewhere
                  ? <button type="button" className="hbtn" onClick={() => rescope({ domain: null, sub: null })}>Show all {anywhere}</button>
                  : <button type="button" className="hbtn" onClick={clearFilters}>Clear search and filters</button>}
              />
            )}
          </div>
        </div>
      </div>
    </>
  )
}
