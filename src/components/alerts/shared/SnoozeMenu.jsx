import { useState } from 'react'
import { BellOff } from 'lucide-react'
import { BASE_TIME } from '@/data/timeWindow'
import MenuButton from './MenuButton'
import CustomSnoozeDialog from './CustomSnoozeDialog'
import { SNOOZE_PRESETS } from './alertShared'

const ITEMS = [
  ...SNOOZE_PRESETS.map(p => ({ id: p.id, label: p.id, ariaLabel: `Snooze for ${p.spoken}` })),
  { sep: true },
  { id: 'custom', label: 'Custom…', ariaLabel: 'Snooze for a custom time' },
]

/**
 * Snooze, as a labelled menu with production's presets verbatim (5m, 15m, 30m,
 * 1h, Custom). Production put it behind a speaker icon with no name (R11).
 *
 * `ruleName` names the rule in the accessible label ("Snooze payment-service
 * error rate"), because a list of identical "Snooze" buttons says nothing to
 * someone who cannot see which row each sits in. `title` is the hover text;
 * the Rules tab's bulk bar says it snoozes the selection.
 *
 * `onSnooze` receives exactly what the store's `snooze(ruleId, …)` takes: a
 * number of minutes for a preset, `{start, end, comment}` in unix seconds for a
 * custom one. `nowSec` is the data's now, which is not the wall clock: the
 * demo's now is fixed at load (data/timeWindow BASE_TIME).
 */
export default function SnoozeMenu({
  onSnooze, disabled = false, disabledReason, label = 'Snooze', align = 'right', nowSec, className, ruleName,
  title = 'Hold this rule\'s notifications for a while',
}) {
  const [custom, setCustom] = useState(false)
  const now = nowSec ?? Math.floor(BASE_TIME.getTime() / 1000)

  const onSelect = (id) => {
    if (id === 'custom') { setCustom(true); return }
    const preset = SNOOZE_PRESETS.find(p => p.id === id)
    if (preset) onSnooze?.(preset.minutes)
  }

  return (
    <>
      <MenuButton
        label={label}
        icon={BellOff}
        items={ITEMS}
        onSelect={onSelect}
        disabled={disabled}
        title={disabled ? disabledReason : title}
        ariaLabel={ruleName ? `Snooze ${ruleName}` : undefined}
        align={align}
        className={className}
      />
      {custom && (
        <CustomSnoozeDialog
          nowSec={now}
          onCancel={() => setCustom(false)}
          onConfirm={(spec) => { setCustom(false); onSnooze?.(spec) }}
        />
      )}
    </>
  )
}
