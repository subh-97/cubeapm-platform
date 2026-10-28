import { ChevronRight, HardDrive, Server, Waypoints } from 'lucide-react'
import { AlertStateChip, SuppressionChip, SnoozeMenu, RuleActionsMenu, snoozeBlockedReason } from '@/components/alerts/shared'
import Sparkline from '@/components/charts/Sparkline'
import { rulePath, conditionText, sinceText, formatValue, displayName } from './adapters'
import { ruleSource, SOURCE_LABELS } from './rulesQuery'
import { clickTogglesRow, isPlainClick } from './rulesList'
import {
  notifiesSummary, integrationIcon, valueTone, multipleFor, deltaFor, seriesTrend, scopeChips, managedText,
} from './ruleDisplay'

const SCOPE_ICONS = { service: Server, endpoint: Waypoints, host: HardDrive }

/**
 * One rule, as D3's row anatomy lays it out: its state (and any snooze or mute
 * beside it), its name as a real link, what it watches, its value against its
 * threshold and the start of the range, how long it has been so, who it
 * tells, and its two labelled menus. Production gave the same row seven
 * icon-only controls (R11).
 *
 * The whole row toggles its details (R12: production's only toggle is a small
 * chevron). A click anywhere on it toggles, except on the things with jobs of
 * their own: the name link, the menus, and anything a menu opens. For the
 * keyboard the row's toggle is a real button with `aria-expanded`, so Enter
 * and Space toggle it natively, and ↑ / ↓ move between rows.
 */
export default function RuleRow({
  view, domId, panelId, open, onToggle, onRowKey, nowSec, agoText, seriesFor, handlers,
}) {
  const name = displayName(view)
  const source = ruleSource(view)
  const managed = managedText(view)
  const showSource = source === 'synthetic' || source === 'slo'
  const live = view.state === 'firing' || view.state === 'pending'
  const blocked = snoozeBlockedReason(view)
  const multiple = multipleFor(view)
  const trend = seriesTrend(view, seriesFor)
  // A rule at rest has no alert to read a value from; its latest reading
  // still says how near the line it is. Paused, erroring and silent rules
  // have none to show.
  const reading = Number.isFinite(view.value) ? view.value : view.state === 'ok' ? trend.last : null
  const delta = deltaFor(view, reading, trend.previous, agoText)
  const notifies = notifiesSummary(view)
  const NotifyIcon = integrationIcon(notifies.type)
  const tone = valueTone(view.state, view.severity)
  const hasValue = Number.isFinite(reading)

  const onClick = (e) => {
    if (clickTogglesRow(e.target, e.currentTarget)) onToggle(view.id)
  }
  const openRule = (e) => {
    if (!isPlainClick(e)) return
    e.preventDefault()
    handlers.onOpenRule(view.id)
  }

  return (
    <div
      className={`rtab-rule${open ? ' is-open' : ''}`}
      id={domId}
      data-rule-id={view.id}
      onClick={onClick}
    >
      <button
        type="button"
        className="rtab-rule-toggle"
        data-row-toggle=""
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Details for ${name}`}
        title={open ? 'Hide details' : 'Show details'}
        onKeyDown={onRowKey}
      >
        <ChevronRight aria-hidden="true" />
      </button>

      <div className="rtab-rule-state">
        <AlertStateChip state={view.state} severity={view.severity} detail={view.lastError ?? undefined} />
        {view.suppression && <SuppressionChip suppression={view.suppression} nowSec={nowSec} />}
      </div>

      <div className="rtab-rule-main">
        <div className="rtab-rule-title">
          <a className="rtab-rule-name" href={rulePath(view.id)} onClick={openRule} title={name}>{name}</a>
          {showSource && <span className="rtab-source" title={managed ?? undefined}>{SOURCE_LABELS[source]}</span>}
        </div>
        <div className="rtab-rule-sentence">
          <span>{conditionText(view)}</span>
          {managed && <span className="rtab-managed">{managed}</span>}
          {scopeChips(view).map(c => {
            const Icon = SCOPE_ICONS[c.key]
            return (
              <span key={c.key} className="rtab-scope" title={`${c.label}: ${c.value}`}>
                <Icon aria-hidden="true" />
                {c.value}
              </span>
            )
          })}
        </div>
      </div>

      <div className="rtab-rule-value">
        <div className="rtab-value-line">
          <span
            className={`rtab-val ${live ? tone : ''}${hasValue ? '' : ' is-none'}`}
            title={hasValue ? `${view.metric ?? 'Value'} ${live ? 'now' : 'at the latest reading'}` : 'No reading'}
          >
            {hasValue ? formatValue(view, reading) : '—'}
          </span>
          {multiple && <span className="rtab-multiple" title={multiple.title}>{multiple.text}</span>}
        </div>
        {(trend.points.length > 1 || delta) && (
          <div className="rtab-trend-line">
            {trend.points.length > 1 && (
              <span className="rtab-spark" title={`${view.metric ?? 'Value'} over the range`}>
                <Sparkline data={trend.points} color="var(--brand)" height={18} />
              </span>
            )}
            {delta && <span className="rtab-delta" data-dir={delta.dir} title={delta.title}>{delta.label}</span>}
          </div>
        )}
      </div>

      <div className="rtab-rule-since">
        <span className="rtab-since">{sinceText(view, nowSec)}</span>
        <span className={`rtab-notifies${notifies.none ? ' is-none' : ''}`} title={notifies.title}>
          <NotifyIcon aria-hidden="true" />
          <span className="rtab-notifies-names">{notifies.text}</span>
        </span>
      </div>

      {/* Nothing in here toggles the row, a dialog a menu opens included. */}
      <div className="rtab-rule-actions" data-no-row-toggle="">
        {live && (
          <SnoozeMenu
            onSnooze={spec => handlers.onSnooze(view, spec)}
            disabled={!!blocked}
            disabledReason={blocked ?? undefined}
            nowSec={nowSec}
            ruleName={name}
          />
        )}
        <RuleActionsMenu rule={view} onAction={id => handlers.onAction(view, id)} />
      </div>
    </div>
  )
}
