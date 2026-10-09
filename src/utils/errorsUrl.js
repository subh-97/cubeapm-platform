import { TIME_PRESETS } from '@/utils/timeRange'
import { encodeValue } from '@/utils/searchParams'

/**
 * The Errors page's URL: which side, which facet values, the search text and —
 * read on the way in only — the time range.
 *
 *   state = { kind: 'server' | 'client', facets: { [field]: string[] }, q: string, time: string | null }
 *
 * Two dialects come in. Ours (kind, service, endpoint, span_name, exception,
 * http_code, q, time), which is also what the page writes back. And the
 * original CubeAPM Errors page's, so a link copied out of it lands on the same
 * errors here: `error` is the exception, `name` the span name, `root_name` the
 * endpoint, and `stream` a JSON object of facet lists. Its other keys (index,
 * view, refresh, category, host, sv, env) select things this page has no notion
 * of; they are read past rather than rejected, so the rest of the link applies.
 *
 * `q` is the search bar's chips as text (QueryBuilder chipsToString), parsed
 * back by the page with rawQuery.tryParseConditions. This module keeps it a
 * string, so it stays free of the builder and of any import cycle with it.
 */

// Also the order they are written in, so the same state is always the same URL.
const FACET_KEYS = ['service', 'endpoint', 'span_name', 'exception', 'http_code']

// A Map, not an object literal: the keys come from whoever wrote the link.
// Looked up on a plain object, `?toString=1` found Object.prototype.toString
// and became a facet on a field no row has, which filtered the page to nothing.
const FIELD_FOR_KEY = new Map([
  ...FACET_KEYS.map(k => [k, k]),
  ['error', 'exception'],
  ['name', 'span_name'],
  ['root_name', 'endpoint'],
])

const PRESETS = new Set(TIME_PRESETS.map(p => p.value))

// A facet value as JSON can carry it. Anything else (an object, a list, null)
// is not a value the original ever wrote, and as text it would only be a
// filter on "[object Object]".
const isScalar = v => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

// The original page's facet selection. A malformed one is dropped on its own:
// one bad parameter should not cost the link its other filters.
function streamEntries(text) {
  try {
    const obj = JSON.parse(text)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return []
    return Object.entries(obj).map(([key, values]) => [key, (Array.isArray(values) ? values : [values]).filter(isScalar)])
  } catch {
    return []
  }
}

// The query string out of whatever was passed. A raw `#` always starts the
// fragment (inside a value it is written %23). A path or a whole URL is cut at
// its first `?`; a bare query string is taken whole, since a `?` inside one of
// its values (`q=why?`) is not where it starts.
function queryPart(raw) {
  const s = raw.split('#', 1)[0]
  const at = s.indexOf('?')
  return at === -1 || /[=&]/.test(s.slice(0, at)) ? s : s.slice(at + 1)
}

/** URL search string (with or without the `?`, or a whole path) → state. */
export function parseErrorsSearch(search) {
  const params = new URLSearchParams(queryPart(String(search ?? '')))

  const facets = {}
  // Empty values are how the original writes "no filter" (`endpoint=&host=`),
  // so they are skipped rather than kept as a filter on the empty string. The
  // same value arriving under two spellings is still one filter.
  const add = (field, value) => {
    const v = String(value ?? '').trim()
    if (!v) return
    const list = facets[field] ?? (facets[field] = [])
    if (!list.includes(v)) list.push(v)
  }
  for (const [key, value] of params) {
    if (FIELD_FOR_KEY.has(key)) add(FIELD_FOR_KEY.get(key), value)
    else if (key === 'stream') {
      for (const [k, values] of streamEntries(value)) {
        if (FIELD_FOR_KEY.has(k)) for (const v of values) add(FIELD_FOR_KEY.get(k), v)
      }
    }
  }

  const time = params.get('time')
  return {
    kind: params.get('kind')?.toLowerCase() === 'client' ? 'client' : 'server',
    facets,
    q: (params.get('q') ?? '').trim(),
    // An absolute `ISO~ISO` range is the original's; ours is owned by App and
    // only presets are worth carrying in a shared link.
    time: PRESETS.has(time) ? time : null,
  }
}

// encodeValue writes values in their readable spelling, so a shared link reads
// `span_name=POST+api.stripe.com/v1/charges`. It lives in searchParams.js,
// shared with the Browser page's URL, and is re-exported here under its name.
export { encodeValue }

/**
 * State → search string: `?…`, or '' when there is nothing to say, so the page
 * can compare it with `location.search` directly.
 *
 * Writes only what the page owns. The time range belongs to App and the
 * original's refresh/index keys mean nothing here, so none are ever written;
 * `kind` is left out at its default.
 */
export function errorsSearch({ kind = 'server', facets = {}, q = '' } = {}) {
  const parts = []
  const put = (key, value) => parts.push(`${key}=${encodeValue(value)}`)
  if (kind === 'client') put('kind', 'client')
  for (const key of FACET_KEYS) {
    // A Set (the page's own state) or an array (what parseErrorsSearch returns).
    // A lone string is one value: iterated, it would be written a letter at a
    // time. Repeats are dropped, as reading the link back would drop them.
    const given = facets?.[key] ?? []
    const values = new Set(typeof given === 'string' ? [given] : [...given].map(String))
    for (const v of values) if (v !== '') put(key, v)
  }
  if (q?.trim()) put('q', q.trim())
  return parts.length ? `?${parts.join('&')}` : ''
}
