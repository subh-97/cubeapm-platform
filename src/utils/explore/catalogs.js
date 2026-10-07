// Fixed vocabularies for the Explore editors: what the Quick, Advanced and
// Builder dropdowns offer, the help text under each option, and the word lists
// the Code tabs complete from.
//
// Every user-visible string here is copied VERBATIM from the playground bundle
// (FWn / qpt / lce / BWn / Kje, and the lazily loaded LogsQL language chunk),
// because these strings are the product's documentation of itself — someone
// moving between the playground and our Explore should read the same sentence
// under the same option. The one deliberate departure is PROMQL_KEYWORDS, whose
// reference list is known to be wrong (see there).
//
// Everything is deep-frozen. These objects are shared by every editor on the
// page, and the reference's habit of spreading catalog entries into state
// (`{ ...option, args: … }`) makes an accidental in-place edit easy; frozen,
// that mistake throws where it is made instead of leaking into the next pick.

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

// ---------- Metrics: descriptions ----------

// Second line under each FROM option in the Advanced tab (FWn). Only the six
// CubeAPM metrics have one; everything else under "Show all" shows the name only.
export const METRIC_DOCS = deepFreeze({
  cube_apm_calls_total:
    'API calls tracked by CubeAPM. Use this to calculate request rates, e.g. RPM, error rate, etc.',
  cube_apm_ingested_bytes_total:
    'Amount of data ingested by CubeAPM. Use this to calculate data ingestion rate/cost.',
  cube_apm_latency_bucket:
    'Latencies of API calls tracked by CubeAPM, segmented into buckets. Use this to calculate latency percentiles, e.g., p90 latency.',
  cube_apm_latency_count:
    'Count of API calls tracked by CubeAPM. Use this to calculate estimates over sampled data.',
  cube_apm_latency_sum:
    'Latencies of API calls tracked by CubeAPM. Use this to calculate estimates over sampled data.',
  cube_apm_latency_total:
    'Latencies of API calls tracked by CubeAPM. Use this to calculate average latency.',
})

// Second line under each WHERE label option, Quick and Advanced alike (qpt).
// Labels outside this map (anything a non-APM metric carries) get no second line.
export const LABEL_DOCS = deepFreeze({
  __name__: 'Special label whose value is the metric name',
  env: 'Identifier of the environment. Useful for multi-environment deployments.',
  exception: 'Type of the error',
  group_name:
    'Grouping identifier for external calls by a micro-service, e.g., database name for db calls and domain name for HTTP calls. Useful for segmentation of count and latency of external calls.',
  'host.name': 'Name of the host where the micro-service is running',
  http_code: 'HTTP response code of the API endpoint',
  instance:
    'Identifier of CubeAPM node. Useful for analyzing a particular node in a CubeAPM cluster.',
  root_name: 'Name of API endpoint',
  service: 'Name of the micro-service',
  'service.version': 'Version of the micro-service',
  span_kind:
    'Type of operation - server means incoming request and client means outgoing request',
  status_code:
    'Status of operation - OK means completed successfully, ERROR means resulted in error, UNSET means not set',
})

// Help for each Advanced SELECT operation (lce): shown under the option in the
// add-operation picker and behind the info icon on the operation card. `*` and
// `/` have none, so their cards carry no info icon.
export const FUNCTION_DOCS = deepFreeze({
  avg: 'Average of values. Also supports group_by.',
  count: 'Number of samples. Also supports group_by.',
  max: 'Maximum value. Also supports group_by.',
  min: 'Minimum value. Also supports group_by.',
  sum: 'Sum of values. Also supports group_by.',
  topk: 'Top k values. Also supports group_by.',
  ceil: 'Round up to nearest integer',
  clamp:
    'Converts values less than min to min and values greater than max to max',
  clamp_max: 'Converts values greater than max to max',
  clamp_min: 'Converts values less than min to min',
  floor: 'Round down to nearest integer',
  round:
    'Round to nearest multiple of to_nearest. to_nearest can also be a fraction.',
  changes: 'Number of value changes',
  delta:
    'Difference between values. Should be used with gauge metrics only. Gauge metrics are those that can go up and down.',
  deriv:
    'Rate of change. Should be used with gauge metrics only. Gauge metrics are those that can go up and down.',
  increase:
    'Increase in value. Should be used with counter metrics only. Counter metrics are those that can only go up.',
  rate: 'Rate of change. Should be used with counter metrics only. Counter metrics are those that can only go up.',
  resets:
    'Number of value resets. Should be used with counter metrics only. Counter metrics are those that can only go up.',
  histogram_quantile:
    'Used to calculate percentiles, e.g., p90 latency. The quantile argument must be between 0 and 1.',
})

// ---------- Metrics: Advanced SELECT operations (BWn) ----------

// The complete list — 21 operations in five groups, in picker order. There are
// no range windows (MetricsQL fills `[w]` in itself), no `without`, no
// query-to-query binary ops: `*` and `/` only ever take a scalar.
//
// Arg shapes: `aggregation` is the group-by label list; `number` is a text input
// whose `default` (a STRING) seeds it — an arg without a default starts at the
// number 0, which is how the reference picker initialises it (see
// `newOperation` in builders.js). `position: 'before'` puts the arg ahead of the
// inner query (`topk(5, Q)`); anything else goes after it (`round(Q, 1)`).
export const ADVANCED_OPERATIONS = deepFreeze([
  {
    label: 'Aggregation',
    options: [
      { value: 'avg', args: [{ type: 'aggregation' }] },
      { value: 'count', args: [{ type: 'aggregation' }] },
      { value: 'max', args: [{ type: 'aggregation' }] },
      { value: 'min', args: [{ type: 'aggregation' }] },
      { value: 'sum', args: [{ type: 'aggregation' }] },
      {
        value: 'topk',
        args: [
          { label: 'k', type: 'number', default: '5', position: 'before' },
          { type: 'aggregation' },
        ],
      },
    ],
  },
  {
    label: 'Rounding',
    options: [
      { value: 'ceil', args: [] },
      {
        value: 'clamp',
        args: [
          { label: 'min', type: 'number' },
          { label: 'max', type: 'number', default: '1' },
        ],
      },
      { value: 'clamp_max', args: [{ label: 'max', type: 'number', default: '1' }] },
      { value: 'clamp_min', args: [{ label: 'min', type: 'number' }] },
      { value: 'floor', args: [] },
      { value: 'round', args: [{ label: 'to_nearest', type: 'number', default: '1' }] },
    ],
  },
  {
    label: 'Range',
    options: [
      { value: 'changes', args: [] },
      { value: 'delta', args: [] },
      { value: 'deriv', args: [] },
      { value: 'increase', args: [] },
      { value: 'rate', args: [] },
      { value: 'resets', args: [] },
    ],
  },
  {
    label: 'Histogram',
    options: [
      {
        value: 'histogram_quantile',
        args: [{ label: 'quantile', type: 'number', default: '0.9', position: 'before' }],
      },
    ],
  },
  {
    label: 'Operators',
    options: [
      { type: 'operator', value: '*', args: [{ label: 'by', type: 'number', default: '1' }] },
      { type: 'operator', value: '/', args: [{ label: 'by', type: 'number', default: '1' }] },
    ],
  },
])

// ---------- Metrics: Quick tab ----------

// CALCULATE options, in order. Alert pages add " (millis)" to the two latency
// labels; Explore never does, and neither do we.
export const QUICK_CALCULATE = deepFreeze([
  { value: 'rpm', label: 'RPM' },
  { value: 'error_percentage', label: 'Error %' },
  { value: 'latency_percentile', label: '%ile Latency' },
  { value: 'latency_average', label: 'Avg Latency' },
])

// The fixed WHERE / GROUP BY labels. Not fetched: the Quick tab only ever
// queries the APM metrics, which all carry these. `isSpecial` labels exist only
// on error series, so Error % leaves them out of its denominator — and nothing
// else treats them differently.
export const QUICK_LABELS = deepFreeze([
  { label: 'env' },
  { label: 'service' },
  { label: 'root_name' },
  { label: 'service.version' },
  { label: 'host.name' },
  { label: 'http_code', isSpecial: true },
  { label: 'exception', isSpecial: true },
])

// ---------- Shared: filter-row operators ----------

// One operator vocabulary for every WHERE/AND, STREAM and FIELDS row, in this
// order. The values are PromQL matchers; the LogsQL generators translate them
// (`=~` is "in", not "matches regex": the picked values are regex-escaped and
// alternated, so the user never writes a pattern).
export const MATCH_OPERATORS = deepFreeze([
  { value: '=', label: 'equals' },
  { value: '!=', label: 'not equals' },
  { value: '=~', label: 'in' },
  { value: '!~', label: 'not in' },
])

// ---------- Logs/Traces: Builder stats functions (Kje) ----------

// The function select on a stats card, in order; the label is the value.
// Changing the function re-seeds `args` from these specs (`default ?? ''`), which
// is why a picked field clears and quantile snaps back to 0.9.
export const LOGS_STATS_FUNCTIONS = deepFreeze([
  { value: 'avg', args: [{ type: 'field', label: 'field' }] },
  { value: 'count', args: [{ type: 'field', label: 'field' }] },
  { value: 'count_empty', args: [{ type: 'field', label: 'field' }] },
  { value: 'count_uniq', args: [{ type: 'field', label: 'field' }] },
  { value: 'max', args: [{ type: 'field', label: 'field' }] },
  { value: 'median', args: [{ type: 'field', label: 'field' }] },
  { value: 'min', args: [{ type: 'field', label: 'field' }] },
  {
    value: 'quantile',
    args: [
      { type: 'number', label: 'quantile', default: '0.9' },
      { type: 'field', label: 'field' },
    ],
  },
  { value: 'sum', args: [{ type: 'field', label: 'field' }] },
])

// ---------- Logs/Traces: Code-tab completion lists ----------
// From the LogsQL language chunk, entry shape `{ name, detail }` as it ships
// there, order preserved (it is alphabetical, aliases listed individually).

// 60 pipe names — offered right after a `|`.
export const LOGSQL_PIPES = deepFreeze([
  { name: 'block_stats',               detail: 'return per-column storage stats for processed blocks' },
  { name: 'blocks_count',              detail: 'count the data blocks processed by the query' },
  { name: 'collapse_nums',             detail: 'replace numbers in a field value with <N> placeholders' },
  { name: 'copy',                      detail: 'copy fields to new names' },
  { name: 'cp',                        detail: 'copy fields to new names' },
  { name: 'decolorize',                detail: 'strip ANSI color escape sequences from a field' },
  { name: 'del',                       detail: 'drop the given fields from results' },
  { name: 'delete',                    detail: 'drop the given fields from results' },
  { name: 'drop',                      detail: 'drop the given fields from results' },
  { name: 'drop_empty_fields',         detail: 'drop fields with empty values from results' },
  { name: 'eval',                      detail: 'compute arithmetic expressions into new fields' },
  { name: 'extract',                   detail: 'extract fields from a field using a pattern' },
  { name: 'extract_regexp',            detail: 'extract fields via named capture groups of a regexp' },
  { name: 'facets',                    detail: 'return the most frequent values per each log field' },
  { name: 'field_names',               detail: 'return all log field names with their hit counts' },
  { name: 'field_values',              detail: 'return unique values with hit counts for a field' },
  { name: 'fields',                    detail: 'keep only the given fields in results' },
  { name: 'filter',                    detail: 'keep only the rows matching the given filter' },
  { name: 'first',                     detail: 'return the first N rows in the given sort order' },
  { name: 'format',                    detail: 'build a new field from a format string with placeholders' },
  { name: 'generate_sequence',         detail: 'generate n rows with sequential numbers in _msg' },
  { name: 'hash',                      detail: 'store a numeric hash of the given field value' },
  { name: 'head',                      detail: 'return only the first N rows' },
  { name: 'join',                      detail: "join rows with another query's results on the given fields" },
  { name: 'json_array_len',            detail: 'store the number of items in a JSON array field' },
  { name: 'keep',                      detail: 'keep only the given fields in results' },
  { name: 'last',                      detail: 'return the last N rows in the given sort order' },
  { name: 'len',                       detail: 'store the byte length of the given field value' },
  { name: 'limit',                     detail: 'return only the first N rows' },
  { name: 'math',                      detail: 'compute arithmetic expressions into new fields' },
  { name: 'mv',                        detail: 'rename fields' },
  { name: 'offset',                    detail: 'skip the first N rows' },
  { name: 'order',                     detail: 'sort rows by the given fields' },
  { name: 'pack_json',                 detail: 'pack the given fields into a JSON object field' },
  { name: 'pack_logfmt',               detail: 'pack the given fields into a logfmt-encoded field' },
  { name: 'query_stats',               detail: 'return query execution stats such as bytes and rows read' },
  { name: 'rename',                    detail: 'rename fields' },
  { name: 'replace',                   detail: 'replace substring occurrences in a field' },
  { name: 'replace_regexp',            detail: 'replace regexp matches in a field' },
  { name: 'rm',                        detail: 'drop the given fields from results' },
  { name: 'running_stats',             detail: 'add running stats over rows ordered by _time to each row' },
  { name: 'sample',                    detail: 'keep on average one row out of every n rows' },
  { name: 'set_stream_fields',         detail: 'rebuild the _stream field from the given fields' },
  { name: 'skip',                      detail: 'skip the first N rows' },
  { name: 'sort',                      detail: 'sort rows by the given fields' },
  { name: 'split',                     detail: 'split a field value by a separator into a JSON array' },
  { name: 'stats',                     detail: 'calculate stats over rows, optionally grouped by fields' },
  { name: 'stats_remote',              detail: 'stats variant that exports partial state for merging' },
  { name: 'stream_context',            detail: 'return surrounding logs before and after each match' },
  { name: 'time_add',                  detail: 'shift timestamps in the given time field by an offset' },
  { name: 'top',                       detail: 'return the most frequent value sets with hit counts' },
  { name: 'total_stats',               detail: 'add total stats over all rows to every row' },
  { name: 'union',                     detail: 'append the results of another query to the results' },
  { name: 'uniq',                      detail: 'return unique value sets for the given fields' },
  { name: 'unpack_json',               detail: 'unpack a JSON object field into separate fields' },
  { name: 'unpack_logfmt',             detail: 'unpack a logfmt-encoded field into separate fields' },
  { name: 'unpack_syslog',             detail: 'parse a syslog-formatted field into separate fields' },
  { name: 'unpack_words',              detail: 'split a field into words stored as a JSON array' },
  { name: 'unroll',                    detail: 'expand JSON array values into separate rows' },
  { name: 'where',                     detail: 'keep only the rows matching the given filter' },
])

// 25 stats functions — offered after `stats`. Inserted bare, no parentheses.
export const LOGSQL_STATS_FUNCTIONS = deepFreeze([
  { name: 'any',                       detail: 'an arbitrary non-empty value of the given field' },
  { name: 'avg',                       detail: 'average of numeric values in the given fields' },
  { name: 'count',                     detail: 'count rows, or rows with non-empty given fields' },
  { name: 'count_empty',               detail: 'count rows where the given fields are empty' },
  { name: 'count_uniq',                detail: 'count unique value sets of the given fields' },
  { name: 'count_uniq_hash',           detail: 'count unique value sets via value hashes' },
  { name: 'field_max',                 detail: 'value of a field at the row with the max source field' },
  { name: 'field_min',                 detail: 'value of a field at the row with the min source field' },
  { name: 'histogram',                 detail: 'JSON buckets with hit counts for the field values' },
  { name: 'json_values',               detail: 'matching fields of every row as JSON objects' },
  { name: 'max',                       detail: 'maximum value among the given fields' },
  { name: 'median',                    detail: 'median (0.5 quantile) of the given field values' },
  { name: 'median_absolute_deviation', detail: 'median absolute deviation of the given field values' },
  { name: 'min',                       detail: 'minimum value among the given fields' },
  { name: 'quantile',                  detail: 'the given phi-quantile of the given field values' },
  { name: 'rate',                      detail: 'per-second rate of matching rows' },
  { name: 'rate_sum',                  detail: 'per-second rate of the sum of the given field values' },
  { name: 'row_any',                   detail: 'an arbitrary matching row as a JSON object' },
  { name: 'row_max',                   detail: 'the row with the max value of the given field, as JSON' },
  { name: 'row_min',                   detail: 'the row with the min value of the given field, as JSON' },
  { name: 'stddev',                    detail: 'standard deviation of the given field values' },
  { name: 'sum',                       detail: 'sum of numeric values in the given fields' },
  { name: 'sum_len',                   detail: 'sum of the byte lengths of the given field values' },
  { name: 'uniq_values',               detail: 'sorted unique values as a JSON array' },
  { name: 'values',                    detail: 'all values as a JSON array' },
])

// 23 filter functions — offered in the default (filter) position.
export const LOGSQL_FILTER_FUNCTIONS = deepFreeze([
  { name: 'contains_all',              detail: 'matches logs containing all the given values' },
  { name: 'contains_any',              detail: 'matches logs containing any of the given values' },
  { name: 'contains_common_case',      detail: 'matches a phrase in original, lower and upper case' },
  { name: 'eq_field',                  detail: 'matches if the two given fields have equal values' },
  { name: 'equals_common_case',        detail: 'matches exact value in original, lower and upper case' },
  { name: 'exact',                     detail: 'matches the exact field value' },
  { name: 'i',                         detail: 'matches a phrase case-insensitively' },
  { name: 'in',                        detail: 'matches any exact value from the list or subquery' },
  { name: 'ipv4_range',                detail: 'matches ipv4 addresses in the given range' },
  { name: 'ipv6_range',                detail: 'matches ipv6 addresses in the given range' },
  { name: 'json_array_contains_any',   detail: 'matches if a JSON array field contains any given value' },
  { name: 'le_field',                  detail: 'matches if the field is <= the other given field' },
  { name: 'len_range',                 detail: 'matches values with length in the given range' },
  { name: 'lt_field',                  detail: 'matches if the field is < the other given field' },
  { name: 'pattern_match',             detail: 'matches a collapse_nums pattern anywhere in the value' },
  { name: 'pattern_match_full',        detail: 'matches a collapse_nums pattern against the whole value' },
  { name: 'pattern_match_prefix',      detail: 'matches a collapse_nums pattern at the value start' },
  { name: 'pattern_match_suffix',      detail: 'matches a collapse_nums pattern at the value end' },
  { name: 'range',                     detail: 'matches numeric values in the given range' },
  { name: 're',                        detail: 'matches the given regular expression' },
  { name: 'seq',                       detail: 'matches an ordered sequence of phrases' },
  { name: 'string_range',              detail: 'matches string values in [minValue, maxValue)' },
  { name: 'value_type',                detail: 'matches fields with the given stored value type' },
])

// ---------- Metrics: Code-tab keywords ----------
// The reference takes these from monaco-promql, whose list is generated and
// wrong in two ways we do not copy: it offers `<aggregation>_over_time` for
// every aggregation (so `topk_over_time` and `count_values_over_time`, which do
// not exist) while missing `last_over_time` and `present_over_time`; and it has
// no MetricsQL at all, although every Quick query this page generates ends in
// `default 0`. It also lacks `clamp`, which the Advanced tab itself emits.

const PROMQL_AGGREGATIONS = [
  'sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar', 'count', 'count_values',
  'bottomk', 'topk', 'quantile',
]

const PROMQL_FUNCTIONS = [
  'abs', 'absent', 'ceil', 'changes', 'clamp', 'clamp_max', 'clamp_min', 'day_of_month',
  'day_of_week', 'days_in_month', 'delta', 'deriv', 'exp', 'floor', 'histogram_quantile',
  'holt_winters', 'hour', 'idelta', 'increase', 'irate', 'label_join', 'label_replace', 'ln',
  'log2', 'log10', 'minute', 'month', 'predict_linear', 'rate', 'resets', 'round', 'scalar',
  'sort', 'sort_desc', 'sqrt', 'time', 'timestamp', 'vector', 'year',
]

const PROMQL_OVER_TIME = [
  'avg_over_time', 'min_over_time', 'max_over_time', 'sum_over_time', 'count_over_time',
  'quantile_over_time', 'stddev_over_time', 'stdvar_over_time', 'last_over_time',
  'present_over_time',
]

const PROMQL_VECTOR_MATCHING = ['on', 'ignoring', 'group_right', 'group_left', 'by', 'without']

// `bool` for comparisons; `default` is MetricsQL's gap filler (`x default 0`).
const PROMQL_MODIFIERS = ['offset', 'bool', 'default']

// The same words, grouped, for a completion item that wants to say what it is.
export const PROMQL_KEYWORD_GROUPS = deepFreeze({
  aggregations: PROMQL_AGGREGATIONS,
  functions: PROMQL_FUNCTIONS,
  overTime: PROMQL_OVER_TIME,
  vectorMatching: PROMQL_VECTOR_MATCHING,
  modifiers: PROMQL_MODIFIERS,
})

// Flat, de-duplicated, in the reference's group order: aggregations, functions,
// over-time rollups, vector matching, modifiers.
export const PROMQL_KEYWORDS = deepFreeze([...new Set([
  ...PROMQL_AGGREGATIONS,
  ...PROMQL_FUNCTIONS,
  ...PROMQL_OVER_TIME,
  ...PROMQL_VECTOR_MATCHING,
  ...PROMQL_MODIFIERS,
])])
