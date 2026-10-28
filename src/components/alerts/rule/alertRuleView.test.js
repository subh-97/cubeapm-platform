// The rule page (docs/alerts/DESIGN.md D5), rendered from a URL the way a cold
// load or a notification link renders it. What it guards: a missing rule
// reaching a dead end; the head losing the rule's name or sentence, or a
// control losing its label (CLAUDE.md rule 4); an SLO rule offering actions
// that contradict its SLO (D18); the banner saying something other than
// describe.js says; a notification's alert_id selecting nothing (R10); and the
// tabs losing the tablist pattern. What a click does needs a DOM and is checked
// in the running page; the tabs' contents are rendered directly below.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { MemoryRouter } from 'react-router-dom'
import { resolveWindow } from '@/data/timeWindow'
import { createAlertsStore, alertsFor } from '@/utils/alerts/store'
import { ruleSentence, displayName } from '@/utils/alerts/describe'
import AlertRuleView from '@/pages/AlertRuleView'
import RuleInstances from './RuleInstances.jsx'
import RuleNotifications from './RuleNotifications.jsx'
import RuleDefinition from './RuleDefinition.jsx'
import { instanceRows, bannerSentence, rootCauseFor } from './rulePage.js'
import RuleChart from './RuleChart.jsx'
import { stripSegments } from './rulePage.js'

const noop = () => {}
const range = { kind: 'preset', value: '1h' }
const win = resolveWindow(range)
const nowSec = win.nowSec
const alerts = alertsFor(createAlertsStore({ storage: null }).getState(), win)
const view = id => alerts.byId(id)

// Two warnings are a server render's, not the page's (BrowserView.test.js
// says the same): a chart's frame has no size to draw at, and layout effects
// do not run on the server. Anything else still reaches the console.
const EXPECTED = /width\(\d+\) and height\(\d+\) of chart|useLayoutEffect does nothing on the server/
function quietly(fn) {
  const { warn, error } = console
  const quiet = log => (...args) => { if (!EXPECTED.test(String(args[0]))) log(...args) }
  console.warn = quiet(warn)
  console.error = quiet(error)
  try {
    return fn()
  } finally {
    Object.assign(console, { warn, error })
  }
}

function page(id, search = '') {
  return quietly(() => renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/alerts/${id}${search}`]}>
      <AlertRuleView ruleId={String(id)} goHome={noop} timeRange={range} setTimeRange={noop} setToast={noop} onOpenLink={noop} />
    </MemoryRouter>,
  ))
}
const render = el => quietly(() => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>))

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
const text = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null
// Every button in a stretch of markup, with its visible text.
const buttons = html => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, body]) => ({ attrs: ` ${attrs}`, text: text(body).trim() }))
const head = html => html.slice(html.indexOf('class="alr-head"'), html.indexOf('role="tablist"'))

test('a rule that does not exist is "Alert not found", with a way back to Alerts', () => {
  const html = page('99999')
  assert.match(html, /role="alert"/)
  assert.match(html, /<h2>Alert not found<\/h2>/)
  assert.match(html, /No alert rule has the id <span class="mono">99999<\/span>/)
  assert.ok(buttons(html).some(b => b.text === 'Back to Alerts'), 'Back to Alerts')
  assert.doesNotMatch(html, /role="tablist"/, 'no tabs over nothing')
})

test('the head names the rule, says it as describe.js\'s sentence, and labels every action', () => {
  const v = view(501)
  const html = page(501)
  assert.match(html, new RegExp(`<h1 class="alr-head-name" title="${esc(v.name)}">${esc(v.name)}</h1>`))
  assert.ok(html.includes(`<p class="alr-head-sentence">${esc(ruleSentence(v))}<span`), 'the sentence')
  assert.match(html, /State: Critical/)
  const labels = buttons(head(html)).map(b => b.text)
  for (const label of ['Snooze', 'Pause', 'Edit', 'Actions']) assert.ok(labels.includes(label), `${label} in ${labels}`)
  // Every control in the head has words of its own (CLAUDE.md rule 4).
  for (const b of buttons(head(html))) assert.ok(b.text || attr(b.attrs, 'aria-label'), b.attrs)
  assert.match(head(html), /aria-haspopup="menu"/)
})

test('the crumbs are CubeAPM / Alerts / the group / the rule, each a real link', () => {
  const html = page(501)
  assert.match(html, /<a href="\/">CubeAPM<\/a>/)
  assert.match(html, /<a href="\/alerts">Alerts<\/a>/)
  assert.match(html, /<a href="\/alerts\?group=Payments" title="Rules in Payments">Payments<\/a>/)
  assert.match(html, /<span class="current">payment-service error rate<\/span>/)
  // A templated name reads as its template, not as Go's syntax.
  assert.ok(page(515).includes(`<span class="current">${esc(displayName(view(515)))}</span>`))
})

test('an SLO rule offers snooze and history only: no Pause or Edit, and Edit in SLO says why', () => {
  const v = view(9011)
  assert.equal(v.managedBy.kind, 'slo')
  const html = page(9011)
  const bs = buttons(head(html))
  const labels = bs.map(b => b.text)
  assert.ok(labels.includes('Snooze'))
  assert.equal(attr(bs.find(b => b.text === 'Snooze').attrs, 'disabled'), null, 'an SLO rule can be snoozed (D18)')
  for (const gone of ['Pause', 'Resume', 'Edit']) assert.ok(!labels.includes(gone), `no ${gone}`)
  const inSlo = bs.find(b => b.text === 'Edit in SLO')
  assert.ok(inSlo)
  assert.equal(attr(inSlo.attrs, 'aria-disabled'), 'true')
  assert.equal(attr(inSlo.attrs, 'title'), 'The SLO page comes later')
  assert.match(head(html), /read-only here: snooze it, or read its history/)
})

test('a synthetic monitor\'s rule says which monitor it came from, and stays editable', () => {
  const html = page(426)
  assert.match(html, /From monitor Docs\./)
  assert.ok(buttons(head(html)).some(b => b.text === 'Edit' && attr(b.attrs, 'aria-disabled') == null))
})

test('a firing rule\'s banner is its sentence, with the ways out as labelled buttons', () => {
  const v = view(501)
  const html = page(501)
  const banner = html.slice(html.indexOf('class="incident-banner alr-banner'), html.indexOf('role="tablist"'))
  assert.ok(banner.startsWith('class="incident-banner alr-banner"'), 'red: it fires critical')
  const sentence = /<p class="alr-banner-sentence">([\s\S]*?)<\/p>/.exec(banner)[1]
  assert.equal(text(sentence), bannerSentence(v, nowSec, rootCauseFor('payment-service')).text)
  assert.match(text(sentence), /Likely cause: Redis connection pool exhaustion \(redis\.0\)\./)
  assert.deepEqual(buttons(banner).map(b => b.text), ['Open payment-service', 'Failing traces', 'Error logs', 'Errors', 'Open in Explore'])
})

test('a warning banner is amber; a rule that is not firing has none, and keeps its ways out', () => {
  assert.match(page(437), /class="incident-banner alr-banner warn"/)
  const quiet = page(510)
  assert.doesNotMatch(quiet, /incident-banner/)
  assert.ok(buttons(quiet).some(b => b.text === 'Open in Explore'), 'Explore is always there')
})

test('Explore is shown but unavailable, with its reason, for a query its parser cannot read', () => {
  const explore = buttons(page(437)).find(b => b.text === 'Open in Explore')
  assert.equal(attr(explore.attrs, 'aria-disabled'), 'true')
  assert.equal(attr(explore.attrs, 'title'), 'Explore can&#x27;t read this query yet')
  assert.equal(attr(buttons(page(501)).find(b => b.text === 'Open in Explore').attrs, 'aria-disabled'), null)
})

test('a notification\'s alert_id selects its instance: the chart isolates that series', () => {
  const v = view(515)
  const rows = instanceRows(v, alerts.seriesFor(515))
  // Not the worst host, which the page would lead with anyway: the last one
  // with an alert open.
  const alerting = rows.filter(r => r.ids.length)
  assert.ok(alerting.length >= 2, 'several hosts alerting')
  const target = alerting[alerting.length - 1]
  const alertId = target.ids[0]
  const html = page(515, `?alert_id=${alertId}`)
  const legend = [...html.matchAll(/<button type="button" class="drill2-item[^"]*"([^>]*)>[\s\S]*?<span class="drill2-label">(.*?)<\/span>/g)]
    .map(([, attrs, label]) => ({ pressed: /aria-pressed="true"/.test(attrs), label: text(label) }))
  assert.deepEqual(legend.filter(r => r.pressed).map(r => r.label), [target.name])
  assert.match(html, new RegExp(`Showing <span class="mono">${esc(target.name)}</span>`))
  // Without it, nothing is isolated.
  assert.equal([...page(515).matchAll(/class="drill2-item[^"]*"[^>]*aria-pressed="true"/g)].length, 0)
})

test('an alert_id that is no longer open says so and shows the whole rule', () => {
  const html = page(501, '?alert_id=123')
  assert.match(html, /The alert this link was about \(<span class="mono">123<\/span>\) is no longer open\./)
})

test('the tabs are one tablist naming its panel: Overview, Instances, Notifications and Definition', () => {
  const html = page(501)
  assert.match(html, /role="tablist" aria-label="Rule views"/)
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>[\s\S]*?<\/button>/g)].map(m => m[0])
  assert.deepEqual(tabs.map(t => attr(t, 'id')), ['overview', 'instances', 'notifications', 'definition'].map(t => `alr-rule-tab-${t}`))
  assert.ok(tabs.every(t => attr(t, 'aria-controls') === 'alr-rule-tab-panel'))
  assert.equal(attr(tabs[0], 'aria-selected'), 'true')
  const log = alerts.log.filter(r => String(r.rule_id) === '501')
  assert.match(text(tabs[1]), /^Instances1$/)
  assert.equal(text(tabs[2]), `Notifications${log.length}`)
  const panel = html.match(/<div[^>]*id="alr-rule-tab-panel"[^>]*>/)[0]
  assert.equal(attr(panel, 'role'), 'tabpanel')
  assert.equal(attr(panel, 'aria-labelledby'), 'alr-rule-tab-overview')
})

test('Overview carries the KPIs against something, recent events and when it was last evaluated', () => {
  const html = page(501)
  for (const lbl of ['Now', 'Firing for', 'Incidents', 'Notifications']) assert.match(html, new RegExp(`<span class="lbl">${lbl}</span>`))
  assert.match(html, /the 3% critical threshold/)
  assert.match(html, /in the previous hour/)
  assert.match(html, /Last evaluated \d\d:\d\d/)
  assert.match(html, /class="alr-event-list"/)
  assert.match(html, /role="img" aria-label="payment-service error rate&#x27;s state over Last 1 hour: OK /)
})

test('Instances: the selected row is marked and its series button pressed', () => {
  const v = view(515)
  const rows = instanceRows(v, alerts.seriesFor(515))
  const log = alerts.log.filter(r => String(r.rule_id) === '515')
  const html = render(<RuleInstances view={v} rows={rows} log={log} nowSec={nowSec} selected={rows[1].name} onSelect={noop} />)
  const trs = [...html.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)].slice(1)
  assert.equal(trs.length, rows.length)
  const picked = trs.filter(([, attrs]) => /aria-selected="true"/.test(attrs))
  assert.equal(picked.length, 1)
  assert.match(picked[0][1], /class="is-selected"/)
  assert.ok(text(picked[0][2]).includes(rows[1].labels['host.name']))
  assert.match(picked[0][2], /aria-pressed="true"/)
})

test('Instances: each row offers the ways out its own labels reach, a host series its host', () => {
  const cells = (id) => {
    const v = view(id)
    const rows = instanceRows(v, alerts.seriesFor(id))
    const html = render(<RuleInstances view={v} rows={rows} log={[]} nowSec={nowSec} selected={null} onSelect={noop} onTraces={noop} onLogs={noop} onHost={noop} />)
    const trs = [...html.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)].slice(1)
    return trs.map(([, , body]) => ({ body, ways: buttons(body.slice(body.indexOf('class="alr-row-actions"'))) }))
  }
  // 515 is grouped by host and names no service: Host on every row, nothing else.
  const hosts = cells(515)
  assert.ok(hosts.length >= 2)
  for (const { body, ways } of hosts) {
    assert.deepEqual(ways.map(b => b.text), ['Host'])
    const name = /<span class="alr-label-k">host\.name<\/span>([^<]+)</.exec(body)[1]
    assert.equal(attr(ways[0].attrs, 'title'), `${name} on Infrastructure`)
  }
  // A service rule's series has no host, and keeps Traces and Logs.
  for (const { ways } of cells(501)) assert.deepEqual(ways.map(b => b.text), ['Traces', 'Logs'])
})

test('a notification for one host puts that host in the banner; the whole rule does not pick one', () => {
  const v = view(515)
  const target = instanceRows(v, alerts.seriesFor(515)).filter(r => r.ids.length).at(-1)
  const banner = html => html.slice(html.indexOf('class="incident-banner'), html.indexOf('role="tablist"'))
  const picked = buttons(banner(page(515, `?alert_id=${target.ids[0]}`)))
  assert.deepEqual(picked.map(b => b.text), [`Open ${target.labels['host.name']}`, 'Open in Explore'])
  assert.deepEqual(buttons(banner(page(515))).map(b => b.text), ['Open in Explore'])
})

test('Notifications: the shared log, each send saying its event, contact point and integration, and status in our words', () => {
  const log = id => alerts.log.filter(r => String(r.rule_id) === String(id))
  const failed = render(<RuleNotifications view={view(514)} log={log(514)} nowSec={nowSec} lookups={alerts.lookups} />)
  assert.match(failed, /class="nlog compact"/, 'the Notifications tab\'s log, without the Rule column')
  assert.match(failed, /title="Status: ERROR">Failed</)
  assert.match(failed, /<span>Infra paging<\/span><span class="nlog-int">Webhook /)
  assert.match(failed, /aria-expanded="false"/)
  assert.match(render(<RuleNotifications view={view(505)} log={log(505)} nowSec={nowSec} lookups={alerts.lookups} />), /title="Status: MUTE">Muted</)
  assert.match(render(<RuleNotifications view={view(507)} log={log(507)} nowSec={nowSec} lookups={alerts.lookups} />), /title="Status: SNOOZE">Snoozed</)
})

test('Definition: the query is read-only under tabs that still click, with every setting and destination', () => {
  const v = view(501)
  const html = render(<RuleDefinition view={v} nowSec={nowSec} muteGroups={alerts.muteGroups} lookups={alerts.lookups} onEdit={noop} />)
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)]
  assert.deepEqual(tabs.map(t => t[1]), ['Quick', 'Advanced', 'Code'])
  for (const [tab] of tabs) assert.equal(attr(tab, 'disabled'), null, 'clickable (Explore reference R3)')
  assert.equal(attr(tabs[0][0], 'aria-selected'), 'true', 'opens on the tab it was built in')
  assert.match(html, /<dt>Calculate<\/dt><dd>Error %<\/dd>/)
  for (const [k, val] of [['Check every', '1m'], ['Fire after', '5m'], ['Re-notify every', '1h']]) {
    assert.match(html, new RegExp(`>${k}</dt><dd>${val}</dd>`))
  }
  assert.match(html, /<span class="alr-cp-name">Payments on-call<\/span>/)
  assert.match(html, /<span>Slack<\/span>/)
  assert.match(html, /<span>PagerDuty<\/span>/)
  assert.ok(buttons(html).some(b => b.text === 'Edit rule'))

  // A Code-only rule opens on Code, with the query highlighted exactly.
  const demo = view(437)
  const code = render(<RuleDefinition view={demo} nowSec={nowSec} muteGroups={alerts.muteGroups} lookups={alerts.lookups} onEdit={noop} />)
  const codeTab = [...code.matchAll(/<button[^>]*role="tab"[^>]*>Code<\/button>/g)][0][0]
  assert.equal(attr(codeTab, 'aria-selected'), 'true')
  const body = /<pre class="ex-genq-body"[^>]*>([\s\S]*?)<\/pre>/.exec(code)[1]
  assert.equal(text(body), demo.baseQuery)
  assert.match(code, /<summary>As stored<\/summary>/)

  const slo = render(<RuleDefinition view={view(9011)} nowSec={nowSec} muteGroups={alerts.muteGroups} lookups={alerts.lookups} />)
  const inSlo = buttons(slo).find(b => b.text === 'Edit in SLO')
  assert.equal(attr(inSlo.attrs, 'aria-disabled'), 'true')
})

test('an annotation reads as a notification would show it, not as Go template syntax', () => {
  // 501's summary is stored as `payment-service is failing {{ printf "%.2f" .Value }}% of requests`.
  const html = quietly(() => renderToStaticMarkup(
    <RuleDefinition view={view(501)} nowSec={nowSec} onEdit={noop} onUnsnooze={noop} onBlocked={noop} />,
  ))
  assert.match(html, /payment-service is failing ‹value›% of requests/)
  assert.doesNotMatch(html.replace(/title="[^"]*"/g, ''), /\{\{/, 'no template syntax in what reads on the page')
  // The text as stored is still there to hover.
  assert.match(html, /title="payment-service is failing \{\{ printf &quot;%\.2f&quot; \.Value \}\}% of requests"/)
})

test('the chart draws a draft as a preview: no Compare, "would have fired", and a nameless draft is "this rule"', () => {
  // The editor (P4) draws a rule that is not saved yet: no id, maybe no name,
  // and the backtest's stretches in place of a history.
  const saved = view(501)
  const draft = { ...saved, id: undefined, name: '' }
  const series = alerts.seriesFor(501)
  const lane = alerts.timeline.find(t => t.ruleId === 501)?.intervals ?? []
  const html = quietly(() => renderToStaticMarkup(
    <RuleChart
      preview view={draft} series={series} lane={lane}
      segments={stripSegments(lane, win, nowSec)} win={win} nowSec={nowSec}
    />,
  ))
  assert.match(html, /Preview over /)
  assert.doesNotMatch(html, /Compare/)
  assert.match(html, /aria-label="Where this rule would have fired over [^"]+"/)
  assert.doesNotMatch(html, /undefined/)
})

test('a saved rule\'s chart keeps Compare, and a templated name reads as its display name in the strip', () => {
  const v = view(515)
  const html = quietly(() => renderToStaticMarkup(
    <RuleChart
      view={v} series={alerts.seriesFor(515)} compare="previous" onCompare={noop} lane={[]}
      segments={stripSegments([], win, nowSec)} win={win} nowSec={nowSec}
    />,
  ))
  assert.match(html, /Condition over /)
  assert.match(html, /Compare/)
  assert.match(html, /aria-label="CPU high on ‹host\.name›&#x27;s state over [^"]+"/)
  assert.doesNotMatch(html, /\{\{/)
})

test('the chart draws its state strip in colour away from the rule page: its own styles and tones', () => {
  // The editor's preview rail draws RuleChart with no .alr-rule-page around it.
  const v = view(501)
  const lane = alerts.timeline.find(t => t.ruleId === 501)?.intervals ?? []
  const html = quietly(() => renderToStaticMarkup(
    <RuleChart preview view={v} series={alerts.seriesFor(501)} lane={lane} segments={stripSegments(lane, win, nowSec)} win={win} nowSec={nowSec} />,
  ))
  assert.match(html, /^<section class="panel alr-chart-panel alr-tones"/)
  assert.match(html, /class="alr-strip-seg tone-critical/, 'a segment the tones colour')
  const source = file => readFileSync(join(process.cwd(), 'src/components/alerts/rule', file), 'utf8')
  assert.match(source('RuleChart.jsx'), /^import '\.\/alert-rule\.css'$/m)
  for (const tone of ['critical', 'warning', 'info', 'healthy', 'neutral']) {
    assert.match(source('alert-rule.css'), new RegExp(`^:is\\(\\.alr-rule-page, \\.alr-tones\\) \\.tone-${tone} \\{ --tone:`, 'm'), tone)
  }
})
