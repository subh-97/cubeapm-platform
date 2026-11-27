import { ChevronRight, HardDrive, Pause, Pin, Play, Server, Waypoints } from 'lucide-react'
import { AlertStateChip, SuppressionChip, SnoozeMenu, RuleActionsMenu, snoozeBlockedReason, ruleActionItems } from '@/components/alerts/shared'
import { rulePath, sinceText, displayName } from './adapters'
import { ruleSource, SOURCE_LABELS } from './rulesQuery'
import { clickTogglesRow, isPlainClick } from './rulesList'
import { notifiesSummary, integrationIcon, scopeChips, managedText } from './ruleDisplay'

const SCOPE_ICONS = { service: Server, endpoint: Waypoints, host: HardDrive }

/**
 * One rule, as D3's row anatomy lays it out: its state (and any snooze or mute
 * beside it), the pin that keeps it at the top of the list, its name as a real
 * link, its scope (the service, endpoint or host it watches) and any "managed
 * by" note, how long it has been in its state, who it tells, and its controls.
 * The condition sentence ("Error % > 3% critical…"), the current value, its
 * threshold multiple and a trend sparkline shared the row until 2026-11-26;
 * they now live on the expanded panel (the sentence at its head, the value on
 * each instance row), so the collapsed row names the rule rather than reading
 * it. Production gave the same row seven icon-only controls (R11).
 *
 * The whole row toggles its details (R12: production's only toggle is a small
 * chevron). A click anywhere on it toggles, except on the things with jobs of
 * their own: the pin, the name link, the menus, and anything a menu opens. For the
 * keyboard the row's toggle is a real button with `aria-expanded`, so Enter
 * and Space toggle it natively, and ↑ / ↓ move between rows.
 *
 * Snooze and Pause/Resume are icon-only, their names carried in title and
 * `aria-label` (rule 4); Actions keeps its word. Pause is its own control
 * beside Snooze, not buried in the Actions menu, so the row's commonest change
 * is one click (production gave it a switch; the menu made it two steps).
 */
const PAUSE_IDS = ['pause', 'resume']

export default function RuleRow({
  view, domId, panelId, open, pinned = false, onToggle, onRowKey, nowSec, handlers,
}) {
  const name = displayName(view)
  const source = ruleSource(view)
  const managed = managedText(view)
  const showSource = source === 'synthetic' || source === 'slo'
  const live = view.state === 'firing' || view.state === 'pending'
  const blocked = snoozeBlockedReason(view)
  const notifies = notifiesSummary(view)
  const NotifyIcon = integrationIcon(notifies.type)
  // Pause or Resume, pulled out of the Actions menu into its own control. The
  // menu's own descriptor carries whether the rule allows it (an SLO rule has
  // no such item, and a read-only one is disabled with its reason).
  const pauseItem = ruleActionItems(view).find(it => PAUSE_IDS.includes(it.id))

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
        <div className="rtab-state-line">
          <AlertStateChip state={view.state} severity={view.severity} detail={view.lastError ?? undefined} />
          {/* A set pin stays in view: it is state. An unset one shows on the
              row's hover or focus, as the Logs drawer's field pins do. */}
          <button
            type="button"
            className={`rtab-pin${pinned ? ' is-pinned' : ''}`}
            aria-pressed={pinned}
            aria-label={`Pin ${name} to the top`}
            title={pinned ? 'Unpin from the top' : 'Pin to the top'}
            onClick={e => handlers.onTogglePin?.(view, e)}
          >
            <Pin aria-hidden="true" />
          </button>
        </div>
        {view.suppression && <SuppressionChip suppression={view.suppression} nowSec={nowSec} />}
      </div>

      <div className="rtab-rule-main">
        <div className="rtab-rule-title">
          <a className="rtab-rule-name" href={rulePath(view.id)} onClick={openRule} title={name}>{name}</a>
          {showSource && <span className="rtab-source" title={managed ?? undefined}>{SOURCE_LABELS[source]}</span>}
        </div>
        <div className="rtab-rule-sentence">
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
            hideLabel
            className="icon-only"
          />
        )}
        {pauseItem && (
          <button
            type="button"
            className="hbtn small icon-only"
            aria-label={`${pauseItem.id === 'resume' ? 'Resume' : 'Pause'} ${name}`}
            aria-disabled={pauseItem.disabled || undefined}
            title={pauseItem.title ?? (pauseItem.id === 'resume' ? 'Evaluate this rule again' : 'Stop evaluating this rule until it is resumed')}
            onClick={pauseItem.disabled ? undefined : () => handlers.onAction(view, pauseItem.id)}
          >
            {pauseItem.id === 'resume' ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          </button>
        )}
        <RuleActionsMenu rule={view} onAction={id => handlers.onAction(view, id)} omit={PAUSE_IDS} />
      </div>
    </div>
  )
}
