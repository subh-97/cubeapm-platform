import { useMemo, useState } from 'react'
import { Activity, ArrowRight, Database, FileSearch, Plus, SearchX, X } from 'lucide-react'
import ConfigDrawer from '@/components/alerts/config/ConfigDrawer'
import FilterChips from '@/components/shared/FilterChips'
import EmptyState from '@/components/shared/EmptyState'
import SearchGlyph from '@/components/shared/SearchGlyph'
import InfraIcon from '@/components/layout/InfraIcons'
import { ALERTS_NOW } from '@/data/alerts'
import { datasourceId } from '@/utils/alerts/catalog'
import { tiersOf } from '@/utils/alerts/condition'
import { draftFromPayload, ruleFromDraft } from '@/utils/alerts/editorDraft'
import { ruleView } from '@/utils/alerts/model'
import { RULE_TEMPLATES, filterTemplates, templateTabs } from '@/utils/alerts/ruleTemplates'
import { conditionText, displayName } from './adapters'
import './template-drawer.css'

/**
 * The template drawer the Rules tab's template banner opens: production's
 * "Alert templates" drawer in our language. A search, the categories as
 * capsules, each with its mark and what the search leaves in it, and a card per
 * template that says what it watches and the condition as the rule list will
 * show it. A card is the button: choosing one opens the editor on it
 * (`onPick(template)`), where the preview shows what it would have done, and
 * nothing is saved until the editor's Save.
 *
 * Where production differs (docs/decisions/alerts-page.md): no placeholder
 * categories, the thresholds in the rule list's own sentence, and a mark on a
 * template a rule already uses.
 */
export default function TemplateDrawer({ rules = [], onPick, onScratch, onClose, templates = RULE_TEMPLATES }) {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('all')

  // Each template as the editor would open it: its rule, the sentence the
  // rule list will show for it, and the query a rule already using it has.
  const compiled = useMemo(() => templates.map(compile), [templates])

  const tabs = templateTabs(compiled, q)
  const shown = filterTemplates(compiled, { category, q })
  const elsewhere = category !== 'all' ? tabs[0].count : 0

  const onSearchKey = (e) => {
    // Escape clears a search before it closes the drawer.
    if (e.key === 'Escape' && q) { e.preventDefault(); e.stopPropagation(); setQ('') }
  }

  return (
    <ConfigDrawer
      title="Browse Templates"
      className="tpl-drawer"
      onClose={onClose}
      footer={(
        <>
          <span className="tpl-foot-note">Nothing here fits?</span>
          <button type="button" className="hbtn" onClick={onScratch}>
            <Plus aria-hidden="true" />Create a rule from scratch
          </button>
        </>
      )}
    >
      <div className="tpl-tools">
        <div className="svc-search tpl-search">
          <SearchGlyph />
          <input
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search templates: latency, redis, k8s…"
            aria-label="Search templates"
            spellCheck={false}
            autoComplete="off"
          />
          {q && (
            <button type="button" className="svc-search-clear" aria-label="Clear search" title="Clear search" onClick={() => setQ('')}>
              <X aria-hidden="true" />
            </button>
          )}
        </div>
        <FilterChips
          options={tabs.map(c => ({ ...c, icon: c.icon ? <SourceIcon icon={c.icon} /> : null }))}
          active={category}
          onChange={setCategory}
          ariaLabel="Template categories"
        />
      </div>

      <div className="tpl-scroll">
        {shown.length ? (
          <ul className="tpl-grid">
            {shown.map(t => (
              <TemplateCard
                key={t.id}
                template={t}
                usedBy={rules.filter(v => v.baseQuery === t.baseQuery && v.datasource === t.datasource)}
                onPick={() => onPick(t)}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={SearchX}
            className="tpl-empty"
            title={q ? `No ${category === 'all' ? '' : `${tabs.find(x => x.id === category)?.label} `}templates match “${q.trim()}”` : 'No templates here yet'}
            description={elsewhere ? `${elsewhere} ${elsewhere === 1 ? 'template matches' : 'templates match'} in other categories.` : 'Try another word, or create the rule from scratch.'}
            action={elsewhere
              ? <button type="button" className="hbtn" onClick={() => setCategory('all')}>Show all {elsewhere}</button>
              : q && <button type="button" className="hbtn" onClick={() => setQ('')}>Clear search</button>}
          />
        )}
      </div>
    </ConfigDrawer>
  )
}

function compile(t) {
  const rule = ruleFromDraft(draftFromPayload(t.payload()))
  const view = ruleView(
    { ...rule, id: `template-${t.id}`, state: 'inactive', health: 'ok', alerts: null, seriesCount: 1, lastEvaluation: null, lastError: '' },
    { history: null, nowSec: ALERTS_NOW },
  )
  return { ...t, rule, condition: conditionText(view), baseQuery: tiersOf(rule).query, datasource: datasourceId(rule.datasource) }
}

function TemplateCard({ template: t, usedBy, onPick }) {
  return (
    <li className="tpl-card">
      <div className="tpl-card-top">
        <span className="tpl-source"><SourceIcon icon={t.source.icon} />{t.source.label}</span>
        {usedBy.length > 0 && (
          <span className="tpl-inuse" title={`Already used by ${usedBy.map(displayName).join(', ')}`}>In use</span>
        )}
      </div>
      <h3 className="tpl-title">{t.title}</h3>
      <p className="tpl-desc">{t.description}</p>
      <p className="tpl-cond">
        {t.condition}
        <span className="tpl-per"> · one alert per {t.per.one}</span>
      </p>
      <button type="button" className="hbtn primary tpl-use" aria-label={`Use template: ${t.title}`} onClick={onPick}>
        Use template<ArrowRight aria-hidden="true" />
      </button>
    </li>
  )
}

// The source's mark: the vendor's own for infrastructure, as the
// Infrastructure page draws it, the sidebar's glyph for APM and Logs, and a
// database for the dependencies a service calls.
function SourceIcon({ icon }) {
  if (icon === 'apm') return <Activity className="tpl-source-glyph" aria-hidden="true" />
  if (icon === 'logs') return <FileSearch className="tpl-source-glyph" aria-hidden="true" />
  if (icon === 'database') return <Database className="tpl-source-glyph" aria-hidden="true" />
  return <InfraIcon id={icon} size={13} />
}
