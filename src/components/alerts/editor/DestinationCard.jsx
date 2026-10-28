import { useEffect, useId, useRef, useState } from 'react'
import { Eye, EyeOff, Plus, RotateCw, Send, X } from 'lucide-react'
import ExSelect from '@/components/explore/ExSelect'
import { RECEIVER_TYPES } from '@/utils/alerts/catalog'
import { destinationProblem } from '@/utils/alerts/editorDraft'
import { WEBHOOK_VARIABLES, renderWebhookPreview } from '@/utils/alerts/template'
import './alert-editor.css'

const LABEL = Object.fromEntries(RECEIVER_TYPES.map(t => [t.type, t.label]))
// A header that carries a credential is masked, with Reveal, as the PagerDuty
// key is (R35): production shows them in clear text.
const SECRET_HEADER = /authorization|token|secret|api[-_]?key|password/i

// Production's "Refresh … list" links re-ask Slack or Jira for what changed.
// The prototype's lists are fixed, so the link re-reads them and says so.
function RefreshLink({ what, count, onRefreshed }) {
  return (
    <button type="button" className="ae-link" onClick={() => onRefreshed(`Up to date: ${count} ${what}.`)}>
      <RotateCw aria-hidden="true" />Refresh {what} list
    </button>
  )
}

// Production's non-blocking webhook warnings (reference §7.2): a URL that
// belongs to an integration with its own type here, said once and not blocking.
function webhookWarning(url) {
  if (/events\.pagerduty\.com/.test(url)) return 'PagerDuty webhooks are not supported here. Use the PagerDuty type instead.'
  if (/hooks\.slack\.com/.test(url)) return 'Slack webhooks are not supported here. Use the Slack type instead.'
  if (/chat\.googleapis\.com/.test(url)) return 'Google Chat webhooks are not supported here. Use the Google Chat type instead.'
  return null
}

/**
 * One one-off destination (docs/alerts/DESIGN.md D9): production's channel
 * card, inline in the rule. Its fields are production's per type (§7.2), with
 * what production gets wrong put right where it costs nothing: email
 * addresses are checked, the PagerDuty key is masked with Reveal (R35), and
 * Jira's issue types follow the project, clearing when it changes.
 *
 * "Send test" is simulated in the prototype: it checks the card the way the
 * server would and says so inline, rather than in a toast that has gone by
 * the time anyone looks.
 */
export default function DestinationCard({ index, dest, onChange, onRemove, lookups, problem, autoFocus = false }) {
  const id = useId()
  // A card just added takes focus at its first field: the button that added
  // it sits below the cards, so otherwise the keyboard is left past the very
  // fields it needs (7c).
  const rootRef = useRef(null)
  useEffect(() => {
    if (!autoFocus) return
    const root = rootRef.current
    const field = [...(root?.querySelectorAll('input, textarea, button, [tabindex="0"]') ?? [])]
      .find(el => !el.closest('.ae-dest-head') && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
    ;(field ?? root)?.focus({ preventScroll: false })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [test, setTest] = useState(null)
  const [reveal, setReveal] = useState(false)
  const [shownHeaders, setShownHeaders] = useState(() => new Set())
  const [refreshed, setRefreshed] = useState(null)
  const set = patch => { setTest(null); onChange({ ...dest, ...patch }) }
  // Connecting PagerDuty swaps the button pressed for the service it chose
  // (and back), so focus follows to the new state instead of falling to the
  // page from inside a drawer (7c).
  const pdFocus = useRef(null)
  const revealRef = useRef(null)
  const connectRef = useRef(null)
  useEffect(() => {
    if (!pdFocus.current) return
    ;(pdFocus.current === 'connected' ? revealRef : connectRef).current?.focus()
    pdFocus.current = null
  })
  const label = LABEL[dest.type] ?? 'Destination'
  const sendTest = () => {
    const issue = destinationProblem(dest)
    setTest(issue ? { ok: false, text: `Can't send yet: ${issue}` } : { ok: true, text: `Test notification sent to ${label} (simulated in this prototype).` })
  }
  const jira = (lookups.jiraProjects ?? []).find(p => p.key === dest.project)

  let fields = null
  if (dest.type === 'email') {
    fields = (
      <div className="ae-field">
        <label className="ae-label" htmlFor={`${id}-to`}>Addresses</label>
        <textarea id={`${id}-to`} className="ae-input wide" rows={2} value={dest.to} placeholder="oncall@example.com, sre@example.com" onChange={e => set({ to: e.target.value })} />
        <span className="ae-hint">Separate addresses with commas.</span>
      </div>
    )
  } else if (dest.type === 'slack') {
    fields = (
      <div className="ae-field">
        <span className="ae-label">Channel</span>
        <ExSelect
          value={dest.channel || null}
          searchable
          options={(lookups.slackChannels ?? []).map(c => ({ value: c.id, label: `#${c.name}`, description: c.is_private ? 'Private channel' : undefined }))}
          onChange={v => set({ channel: v })}
          placeholder="Pick a channel"
          ariaLabel="Slack channel"
          width={260}
        />
        <span className="ae-hint">Private channels show only where CubeAPM is a member.</span>
        <RefreshLink what="channels" count={(lookups.slackChannels ?? []).length} onRefreshed={setRefreshed} />
      </div>
    )
  } else if (dest.type === 'pagerduty') {
    fields = dest.serviceName ? (
      <div className="ae-field">
        <span className="ae-label">Service</span>
        <span className="ae-readonly">{dest.serviceName}</span>
        <span className="ae-label">Integration key</span>
        <span className="ae-readonly mono">
          {reveal ? dest.routingKey : `${'•'.repeat(12)}${dest.routingKey.slice(-4)}`}
          <button ref={revealRef} type="button" className="ae-link" onClick={() => setReveal(r => !r)} aria-pressed={reveal}>
            {reveal ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}{reveal ? 'Hide' : 'Reveal'}
          </button>
        </span>
        <button type="button" className="ae-link" onClick={() => { pdFocus.current = 'disconnected'; set({ serviceName: '', routingKey: '' }) }}>Connect a different service</button>
      </div>
    ) : (
      <div className="ae-field">
        <button ref={connectRef} type="button" className="hbtn" onClick={() => { pdFocus.current = 'connected'; set({ serviceName: 'Payments (PagerDuty)', routingKey: 'R02PDDEMO7c1e93b0f6a54e' }) }}>
          Connect a PagerDuty service
        </button>
        <span className="ae-hint">Production opens PagerDuty in a new tab to pick the service; this prototype connects a demo one.</span>
      </div>
    )
  } else if (dest.type === 'jira') {
    fields = (
      <div className="ae-field ae-row">
        <span className="ae-label">Project</span>
        <ExSelect
          value={dest.project || null}
          options={(lookups.jiraProjects ?? []).map(p => ({ value: p.key, label: `${p.name} (${p.key})` }))}
          onChange={v => set({ project: v, issueType: '' })}
          placeholder="Pick a project"
          ariaLabel="Jira project"
          width={220}
        />
        <span className="ae-label">Issue type</span>
        <ExSelect
          value={dest.issueType || null}
          options={(jira?.issueTypes ?? []).map(t => ({ value: t, label: t }))}
          onChange={v => set({ issueType: v })}
          placeholder={jira ? 'Pick a type' : 'Pick a project first'}
          disabled={!jira}
          ariaLabel="Jira issue type"
          width={180}
        />
        <RefreshLink what="projects" count={(lookups.jiraProjects ?? []).length} onRefreshed={setRefreshed} />
        {jira && <RefreshLink what="issue types" count={jira.issueTypes.length} onRefreshed={setRefreshed} />}
      </div>
    )
  } else if (dest.type === 'opsgenie') {
    fields = (
      <div className="ae-field">
        <span className="ae-label">Team</span>
        <ExSelect
          value={dest.apiKey || null}
          options={(lookups.opsgenieTeams ?? []).map(t => ({ value: t.api_key, label: t.team }))}
          onChange={v => set({ apiKey: v })}
          placeholder="Pick a team"
          ariaLabel="Opsgenie team"
          width={240}
        />
      </div>
    )
  } else if (dest.type === 'googlechat' || dest.type === 'msTeamsV2' || dest.type === 'webhook') {
    const key = dest.type === 'msTeamsV2' ? 'webhookUrl' : 'url'
    const warning = dest.type === 'webhook' ? webhookWarning(dest.url) : null
    fields = (
      <>
        <div className="ae-field">
          <label className="ae-label" htmlFor={`${id}-url`}>Webhook URL</label>
          <input id={`${id}-url`} className="ae-input wide" type="url" value={dest[key]} placeholder="https://" onChange={e => set({ [key]: e.target.value })} />
          {warning && <span className="ae-hint warn">{warning}</span>}
        </div>
        {dest.type === 'webhook' && (
          <>
            <div className="ae-field">
              <span className="ae-label">Headers</span>
              {dest.headers.map((h, i) => (
                <div key={i} className="ae-tag-row">
                  <input className="ae-input" placeholder="Name" aria-label={`Header ${i + 1} name`} value={h.name} onChange={e => set({ headers: dest.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <input
                    className="ae-input"
                    placeholder="Value"
                    aria-label={`Header ${i + 1} value`}
                    type={SECRET_HEADER.test(h.name) && !shownHeaders.has(i) ? 'password' : 'text'}
                    value={h.value}
                    onChange={e => set({ headers: dest.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                  />
                  {SECRET_HEADER.test(h.name) && (
                    <button
                      type="button"
                      className="ae-link"
                      aria-pressed={shownHeaders.has(i)}
                      onClick={() => setShownHeaders((prev) => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next })}
                    >
                      {shownHeaders.has(i) ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}{shownHeaders.has(i) ? 'Hide' : 'Reveal'}
                    </button>
                  )}
                  <button type="button" className="hbtn icon-only" aria-label={`Remove header ${h.name || i + 1}`} title="Remove header" onClick={() => set({ headers: dest.headers.filter((_, j) => j !== i) })}>
                    <X aria-hidden="true" />
                  </button>
                </div>
              ))}
              <button type="button" className="ae-link" onClick={() => set({ headers: [...dest.headers, { name: '', value: '' }] })}>
                <Plus aria-hidden="true" />Add header
              </button>
            </div>
            <div className="ae-field">
              <label className="ae-label" htmlFor={`${id}-body`}>Payload</label>
              <textarea id={`${id}-body`} className="ae-input wide mono" rows={5} value={dest.body} placeholder='{"text": "{{ .CommonAnnotations.summary }}"}' onChange={e => set({ body: e.target.value })} />
              <span className="ae-hint">Leave empty for the default payload, Alertmanager&apos;s JSON.</span>
              <details className="ae-vars">
                <summary>Template variables</summary>
                <dl>
                  {WEBHOOK_VARIABLES.map(v => (
                    <div key={v.name}><dt><code>{`{{ ${v.name} }}`}</code></dt><dd>{v.description}</dd></div>
                  ))}
                </dl>
              </details>
              {dest.body.trim() && (
                <div className="ae-payload-preview">
                  <span className="ae-label">Preview, for an example firing alert</span>
                  <pre>{renderWebhookPreview(dest.body)}</pre>
                </div>
              )}
            </div>
          </>
        )}
      </>
    )
  }

  const checks = [
    ['sendResolved', 'Notify when resolved'],
    ...(['slack', 'googlechat', 'msTeamsV2'].includes(dest.type) ? [['showQuery', 'Show the query']] : []),
    ...(['slack', 'googlechat'].includes(dest.type) ? [['showSampleLog', 'Show a sample log']] : []),
  ]

  return (
    <div ref={rootRef} className={`ae-dest${problem ? ' invalid' : ''}`} id={`ae-field-destination-${index}`} tabIndex={-1}>
      <div className="ae-dest-head">
        <span className="ae-dest-type">{label}</span>
        <button type="button" className="hbtn" onClick={sendTest}><Send aria-hidden="true" />Send test</button>
        <button type="button" className="hbtn icon-only" aria-label={`Remove the ${label} destination`} title="Remove destination" onClick={onRemove}>
          <X aria-hidden="true" />
        </button>
      </div>
      {fields}
      <div className="ae-checks">
        {checks.map(([key, text]) => (
          <label key={key} className="ae-check">
            <input type="checkbox" checked={!!dest[key]} onChange={e => set({ [key]: e.target.checked })} />
            {text}
          </label>
        ))}
      </div>
      {dest.type === 'pagerduty' && dest.sendResolved && (
        <span className="ae-hint">Resolved notifications also resolve the PagerDuty incident.</span>
      )}
      {problem && <span className="ae-field-problem">{problem}</span>}
      {refreshed && <p className="ae-hint" role="status">{refreshed}</p>}
      {test && <p className={`ae-test ${test.ok ? 'ok' : 'bad'}`} role="status">{test.text}</p>}
    </div>
  )
}
