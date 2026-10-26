// The part of Go's text/template an alert name uses: production's help text
// documents `{{ .Labels.service }}` and `{{ index .Labels "host.name" }}`, and
// its rules template their value annotation as `{{ printf "%.2f" .Value }}`.
// The editor previews a name against the preview's series with this, and the
// list renders each firing series' name with it (docs/alerts/DESIGN.md D8).
//
// Deliberately small. An action this does not understand is left exactly as
// written, so the preview shows the author what will not be filled in rather
// than quietly dropping it. A label the series does not carry renders as Go's
// own `<no value>`, for the same reason: blank would hide the mistake.

const NO_VALUE = '<no value>'
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

// `{{ … }}`, with Go's `{{-` / `-}}` trim markers tolerated (and not trimmed:
// a name is one line).
const ACTION = /\{\{-?\s*([\s\S]*?)\s*-?\}\}/g

function formatPrintf(fmt, value) {
  const m = /^%(\.(\d+))?([dfsgv])$/.exec(fmt)
  if (!m) return null
  const n = Number(value)
  if (m[3] === 'f') return Number.isFinite(n) ? n.toFixed(m[2] != null ? Number(m[2]) : 6) : String(value)
  if (m[3] === 'd') return Number.isFinite(n) ? String(Math.trunc(n)) : String(value)
  return String(value)
}

// One action's text → its rendering, or null when it is not something we know.
function renderAction(body, { labels = {}, value }) {
  const has = k => Object.prototype.hasOwnProperty.call(labels, k)
  const label = k => (has(k) ? String(labels[k]) : NO_VALUE)
  let m
  if ((m = /^(?:\.Labels|\$labels)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(body))) return label(m[1])
  if ((m = /^index\s+(?:\.Labels|\$labels)\s+"((?:[^"\\]|\\.)*)"$/.exec(body))) return label(JSON.parse(`"${m[1]}"`))
  if (/^(?:\.Value|\$value)$/.test(body)) return value == null ? NO_VALUE : String(value)
  if ((m = /^printf\s+"([^"]*)"\s+(?:\.Value|\$value)$/.exec(body))) return value == null ? NO_VALUE : formatPrintf(m[1], value)
  return null
}

/** `text` with every action we understand filled in from `{ labels, value }`. */
export function renderTemplate(text, ctx = {}) {
  return String(text ?? '').replace(ACTION, (whole, body) => renderAction(body.trim(), ctx) ?? whole)
}

/** Whether `text` has any `{{ … }}` in it at all. */
export const usesTemplate = text => /\{\{[\s\S]*?\}\}/.test(String(text ?? ''))

/**
 * The label keys `text` reads, in order of first use. The editor uses this to
 * couple the name to grouping: a name that varies by label needs one
 * notification per series (production warns on another step; D8).
 */
export function templateLabels(text) {
  const keys = []
  for (const [, raw] of String(text ?? '').matchAll(ACTION)) {
    const body = raw.trim()
    const m = /^(?:\.Labels|\$labels)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(body)
      ?? /^index\s+(?:\.Labels|\$labels)\s+"((?:[^"\\]|\\.)*)"$/.exec(body)
    if (!m) continue
    const key = body.startsWith('index') ? JSON.parse(`"${m[1]}"`) : m[1]
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/**
 * The action that reads label `key`, in the spelling Go needs: a plain field
 * for an identifier, `index` for anything else (`host.name`, `k8s-pod`). What
 * "Insert label" puts at the cursor, so nobody has to learn the rule.
 */
export function labelAction(key) {
  return IDENT.test(key) ? `{{ .Labels.${key} }}` : `{{ index .Labels ${JSON.stringify(String(key))} }}`
}

/**
 * A templated name as one line for a rule with several series: each action
 * shown as what it reads — "CPU high on ‹host.name›", "‹value›" — since no one
 * series' value can stand for all of them. Each alert keeps its own rendered
 * name; this is the rule's, for lists and its page title.
 */
export function templateDisplay(text) {
  const labels = Object.fromEntries(templateLabels(text).map(k => [k, `‹${k}›`]))
  return renderTemplate(text, { labels, value: '‹value›' })
}

/**
 * The variables a webhook payload template can read (Alertmanager's
 * notification data), each with what it holds — the reference production's
 * Payload box never gives (R36). `example` is what the preview fills in.
 */
export const WEBHOOK_VARIABLES = [
  { name: '.Status', description: '"firing" or "resolved"', example: 'firing' },
  { name: '.Receiver', description: 'The contact point the message went to', example: 'Payments on-call' },
  { name: '.CommonLabels.alertname', description: 'The rule\'s name, when every alert in the message shares it', example: 'payment-service error rate' },
  { name: '.CommonLabels.severity', description: '"critical" for the critical tier; absent otherwise', example: 'critical' },
  { name: '.CommonAnnotations.summary', description: 'The rule\'s summary line', example: 'payment-service is failing 13.85% of requests' },
  { name: '.GroupLabels.alertname', description: 'What the message was grouped by', example: 'payment-service error rate' },
  { name: '.ExternalURL', description: 'A link back to CubeAPM', example: 'https://cubeapm.example' },
  { name: 'len .Alerts', description: 'How many alerts the message carries', example: '1' },
]

const WEBHOOK_VALUES = new Map(WEBHOOK_VARIABLES.map(v => [v.name, v.example]))

/**
 * A webhook payload template rendered against an example firing alert, for
 * the preview beside its box. Only the variables listed above are filled in;
 * anything else renders as Go's `<no value>`, so a misspelling shows itself.
 */
export function renderWebhookPreview(body) {
  return String(body ?? '').replace(ACTION, (whole, inner) => {
    const key = inner.trim()
    if (WEBHOOK_VALUES.has(key)) return WEBHOOK_VALUES.get(key)
    return /^\.?[A-Za-z]/.test(key) ? NO_VALUE : whole
  })
}
