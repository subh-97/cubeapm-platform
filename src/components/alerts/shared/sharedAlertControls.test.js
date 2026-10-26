// The shared alert controls as they render: the state chip, the suppression
// chip, the Snooze and Actions menus' triggers, the delete and custom-snooze
// dialogs, and the toast's Undo.
//
// The risks: a firing alert chip saying "firing" instead of its severity, or
// taking a colour from anywhere but statusForAlertState (CLAUDE.md rule 1, Q2);
// pending, paused and no-data rules becoming indistinguishable; a menu trigger
// that is only an icon (rule 4, production's R11); and the delete dialog falling
// back to production's bare "Yes".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import AlertStateChip from './AlertStateChip.jsx'
import SuppressionChip from './SuppressionChip.jsx'
import SnoozeMenu from './SnoozeMenu.jsx'
import RuleActionsMenu from './RuleActionsMenu.jsx'
import DeleteRuleDialog from './DeleteRuleDialog.jsx'
import CustomSnoozeDialog from './CustomSnoozeDialog.jsx'
import UndoMessage from './UndoMessage.jsx'

// The menus position their panel in a layout effect, which a server render
// skips and React warns about. That one warning is expected; anything else
// still reaches the console (the CardChart and LegendLineChart tests' filter).
const EXPECTED = /useLayoutEffect does nothing on the server/
function html(el) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return renderToStaticMarkup(el)
  } finally {
    console.warn = warn
    console.error = error
  }
}
const noop = () => {}

test('a firing alert chip names its severity, not "firing"', () => {
  const crit = html(<AlertStateChip state="firing" severity="critical" />)
  assert.match(crit, />Critical</)
  assert.match(crit, /class="alr-chip loud critical"/)
  assert.match(crit, /title="State: Critical"/)
  assert.doesNotMatch(crit, /firing/i)
  // No severity label reads Warning (signed off as Q2).
  const warn = html(<AlertStateChip state="firing" severity={null} />)
  assert.match(warn, />Warning</)
  assert.match(warn, /loud warning/)
})

test('each non-firing state has its own word, and the quiet ones recede', () => {
  const cases = [
    ['pending', 'Pending', 'loud info'],
    ['ok', 'OK', 'quiet healthy'],
    ['error', 'Rule error', 'loud neutral'],
    ['nodata', 'No data', 'quiet neutral'],
    ['paused', 'Paused', 'quiet neutral'],
  ]
  for (const [state, word, cls] of cases) {
    const out = html(<AlertStateChip state={state} />)
    assert.match(out, new RegExp(`>${word}</span>`), `${state} reads ${word}`)
    assert.match(out, new RegExp(`class="alr-chip ${cls}"`), `${state} is ${cls}`)
  }
})

test('the neutral states carry a glyph each, so paused, no data and a rule error tell apart without colour', () => {
  const svgCount = state => (html(<AlertStateChip state={state} />).match(/<svg/g) || []).length
  assert.equal(svgCount('error'), 1)
  assert.equal(svgCount('paused'), 1)
  assert.equal(svgCount('nodata'), 1)
  assert.equal(svgCount('ok'), 0)
})

test('a rule error carries its message in the hover text', () => {
  const out = html(<AlertStateChip state="error" detail="unknown metric kafka_consumergroup_lag" />)
  assert.match(out, /title="State: Rule error: unknown metric kafka_consumergroup_lag"/)
})

test('an unknown state draws nothing rather than guessing', () => {
  assert.equal(html(<AlertStateChip state="weird" />), '')
})

test('a snooze chip reads as an overlay with its time left', () => {
  const now = 1_800_000_000
  const out = html(<SuppressionChip suppression={{ kind: 'snooze', startsAt: now - 60, endsAt: now + 1800 }} nowSec={now} />)
  assert.match(out, /class="alr-chip suppressed"/)
  assert.match(out, /Snoozed · 30m left/)
  assert.equal(html(<SuppressionChip suppression={null} nowSec={now} />), '')
})

test('the Snooze and Actions triggers carry their words and announce a menu', () => {
  const snooze = html(<SnoozeMenu onSnooze={noop} nowSec={1_800_000_000} />)
  assert.match(snooze, /aria-haspopup="menu"/)
  assert.match(snooze, /aria-expanded="false"/)
  assert.match(snooze, /<\/svg>Snooze<svg/)
  const actions = html(<RuleActionsMenu rule={{ id: 'r', name: 'payment-service error rate', status: 'ACTIVE' }} onAction={noop} />)
  assert.match(actions, /<\/svg>Actions<svg/)
  assert.match(actions, /title="Actions for payment-service error rate"/)
})

test('each trigger names its rule for a screen reader, so a list of them is not all "Snooze"', () => {
  const snooze = html(<SnoozeMenu onSnooze={noop} nowSec={1_800_000_000} ruleName="payment-service error rate" />)
  assert.match(snooze, /aria-label="Snooze payment-service error rate"/)
  const actions = html(<RuleActionsMenu rule={{ id: 'r', name: 'payment-service error rate', status: 'ACTIVE' }} onAction={noop} />)
  assert.match(actions, /aria-label="Actions for payment-service error rate"/)
  // A templated name reads as its display name, not as Go template syntax.
  const templated = html(<RuleActionsMenu rule={{ id: 't', name: 'CPU high on {{ index .Labels "host.name" }}', status: 'ACTIVE' }} onAction={noop} />)
  assert.match(templated, /aria-label="Actions for CPU high on ‹host\.name›"/)
  assert.doesNotMatch(templated, /\{\{/)
})

test('a disabled Snooze says why in its title', () => {
  const out = html(<SnoozeMenu onSnooze={noop} disabled disabledReason="A paused rule sends nothing to snooze" />)
  assert.match(out, /disabled=""/)
  assert.match(out, /title="A paused rule sends nothing to snooze"/)
})

test('deleting says what it does and names the act on its button', () => {
  const out = html(<DeleteRuleDialog ruleName="payment-service error rate" onConfirm={noop} onCancel={noop} />)
  assert.match(out, /role="dialog"/)
  assert.match(out, /aria-modal="true"/)
  assert.match(out, />Delete rule</)
  assert.match(out, /<strong>payment-service error rate<\/strong> stops evaluating and notifying\. Its notification history is kept\./)
  assert.match(out, />Cancel</)
  assert.doesNotMatch(out, />Yes</)
})

test('the custom snooze starts now for two hours, with a reason field', () => {
  const out = html(<CustomSnoozeDialog nowSec={1_800_000_000} onConfirm={noop} onCancel={noop} />)
  assert.match(out, /Snooze notifications/)
  assert.match(out, /<legend class="alr-field-label">Starts<\/legend>/)
  assert.match(out, /value="2"/)
  assert.match(out, /Reason \(optional\)/)
  assert.match(out, /Until [A-Z][a-z]{2} \d\d \d\d:\d\d/)
  assert.doesNotMatch(out, /class="hbtn primary" disabled/)
})

test('the toast Undo is a real button beside its message', () => {
  const out = html(<UndoMessage text="Paused payment-service error rate." onUndo={noop} />)
  assert.match(out, /<span>Paused payment-service error rate\.<\/span><button type="button" class="alr-undo-btn" aria-keyshortcuts="Meta\+Z Control\+Z" title="Undo \((⌘Z|Ctrl\+Z)\)">Undo<\/button>/)
  assert.match(out, /<kbd class="alr-undo-kbd" aria-hidden="true">(⌘Z|Ctrl\+Z)<\/kbd>/, 'the shortcut is on the toast, for the keyboard')
})
