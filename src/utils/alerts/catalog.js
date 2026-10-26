// Production's Alerts vocabulary, verbatim: the option lists, operator words,
// receiver types and help text the module shows (docs/alerts/reference/
// production.md §6–§11). Our labels differ where DESIGN.md renames them; what a
// stored rule holds — operator symbols, seconds, type keys — stays production's,
// so a rule written here reads back there and the other way round.

/** Production's datasource values, and the words the UI uses for them. */
export const DATASOURCES = [
  { value: 'prometheus', id: 'metrics', label: 'Metrics' },
  { value: 'vlogs', id: 'logs', label: 'Logs' },
  { value: 'traces', id: 'traces', label: 'Traces' },
  { value: 'mobile', id: 'mobile', label: 'Mobile' },
]
const DATASOURCE_ID = new Map(DATASOURCES.map(d => [d.value, d.id]))
/** 'prometheus' → 'metrics', and so on; an unknown value is metrics, as production's default. */
export const datasourceId = value => DATASOURCE_ID.get(value) ?? 'metrics'
export const datasourceValue = id => DATASOURCES.find(d => d.id === id)?.value ?? 'prometheus'

/**
 * Static conditions. `op` is what a stored expression holds; `words` is
 * production's select label; `symbol` is how our sentence writes it.
 */
export const STATIC_OPERATORS = [
  { op: '==', words: 'equal to', symbol: '=' },
  { op: '!=', words: 'not equal to', symbol: '≠' },
  { op: '>', words: 'greater than', symbol: '>' },
  { op: '<', words: 'less than', symbol: '<' },
  { op: '>=', words: 'greater than or equal to', symbol: '≥' },
  { op: '<=', words: 'less than or equal to', symbol: '≤' },
]

/** Anomaly conditions, in production's order. `<>` is "either side". */
export const ANOMALY_OPERATORS = [
  { op: '>', words: 'above by', symbol: 'above' },
  { op: '<', words: 'below by', symbol: 'below' },
  { op: '<>', words: 'above or below by', symbol: 'outside' },
]

export const DEFAULT_STATIC_OPERATOR = '>'
export const DEFAULT_ANOMALY_OPERATOR = '<>'
/** What production fills in when a rule is switched to Anomaly with no threshold. */
export const DEFAULT_ANOMALY_DEVIATIONS = 2

const sec = { s: 1, m: 60, h: 3600 }
const durations = list => list.map(t => (t === 'Immediate' ? 0 : Number(t.slice(0, -1)) * sec[t.slice(-1)]))

/** "Evaluation Interval": 15 options, default 1m. Seconds. */
export const EVALUATION_INTERVALS = durations(['30s', '1m', '2m', '5m', '10m', '15m', '30m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '24h'])
/** "Wait for": 17 options, Immediate first, default 5m. Seconds. */
export const WAIT_FOR = durations(['Immediate', '30s', '1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '24h'])
/** "Repeat after": 12 options, default 4h. Seconds. */
export const REPEAT_AFTER = durations(['5m', '10m', '15m', '30m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '24h'])

/** A new rule's settings, as production defaults them (§6.1). */
export const RULE_DEFAULTS = Object.freeze({
  interval: 60,
  duration: 300,
  repeatInterval: 14400,
  groupingDisable: false,
  group: 'Default Group',
  status: 'ACTIVE',
})

/** Production's help text for the settings, verbatim (§6.4). */
export const SETTINGS_HELP = {
  interval: 'Decides how frequently the alert query is evaluated',
  duration: 'Decides how long to wait before firing alert. Alert will be fired if the alert condition is continuously satisfied for the waiting period.',
  repeatInterval: 'Decides how long to wait before triggering alert notification again, in case the alert is not resolved by then.',
  grouping: 'Whether to attempt to group multiple alerts into a single notification. If disabled, each alert will trigger a separate notification.',
  tags: 'Add key-value pairs as tags to categorize and filter alerts. Reserved fields (alertgroup, alertname, group, rule_id, query) cannot be used as tag keys.',
  group: 'Alerts with same group name are shown together on the alerts page. You can select one of the existing groups from the suggestions or provide a new name to create a new group.',
}

/** Label keys a rule's tags may not use: the evaluator writes them itself. */
export const RESERVED_TAG_KEYS = ['alertgroup', 'alertname', 'group', 'rule_id', 'query']

/** The folder a rule with no `group` label is listed under. */
export const DEFAULT_GROUP = 'Default Group'

/**
 * Quick CALCULATE, as the alert editor labels it: latencies in milliseconds
 * (production's `quickLatencyInMs`), which Explore's own catalog leaves off.
 * `unit` is what a threshold on it is written in.
 */
export const QUICK_CALCULATE = [
  { value: 'rpm', label: 'RPM', metric: 'RPM', unit: 'rpm' },
  { value: 'error_percentage', label: 'Error %', metric: 'Error %', unit: '%' },
  { value: 'latency_percentile', label: '%ile Latency (millis)', metric: 'latency', unit: 'ms' },
  { value: 'latency_average', label: 'Avg Latency (millis)', metric: 'Avg latency', unit: 'ms' },
]

/**
 * Receiver types in production's order, with the field each stores under.
 * `jira` is listed: v1 builds it (signed off as Q6), though the playground's
 * server has it switched off.
 */
export const RECEIVER_TYPES = [
  { type: 'email', label: 'Email', configs: 'email_configs' },
  { type: 'slack', label: 'Slack', configs: 'slack_configs' },
  { type: 'pagerduty', label: 'PagerDuty', configs: 'pagerduty_configs' },
  { type: 'jira', label: 'Jira', configs: 'jira_configs' },
  { type: 'opsgenie', label: 'Opsgenie', configs: 'opsgenie_configs' },
  { type: 'googlechat', label: 'Google Chat', configs: 'googlechat_configs' },
  { type: 'msTeamsV2', label: 'Microsoft Teams', configs: 'msteamsv2_configs' },
  { type: 'webhook', label: 'Webhook', configs: 'webhook_configs' },
]
const RECEIVER_BY_CONFIGS = new Map(RECEIVER_TYPES.map(r => [r.configs, r]))
/** The receiver type a `…_configs` key holds. */
export const receiverTypeOf = configsKey => RECEIVER_BY_CONFIGS.get(configsKey) ?? null

/** The snooze menu's presets, in minutes (§4), before "Custom". */
export const SNOOZE_PRESETS = [5, 15, 30, 60]

/** Notification statuses, as the log stores them and its filter lists them (§11). */
export const NOTIFICATION_STATUSES = ['SUCCESS', 'ERROR', 'MUTE', 'SNOOZE']
/** What our log calls each one. */
export const NOTIFICATION_STATUS_LABELS = { SUCCESS: 'Sent', ERROR: 'Failed', MUTE: 'Muted', SNOOZE: 'Snoozed' }
