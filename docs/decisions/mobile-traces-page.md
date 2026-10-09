# The Mobile Traces page

A top-level page at `/mobile-traces` (sidebar → MTraces) over what the
Cubedemo Shop app reports from the phones it runs on: screens, taps, sessions,
breadcrumbs, network requests, custom business events, crashes and ANRs. It
mirrors production's `/mobile-traces`, which is the Traces explorer pointed at
a separate index (`/api/mobile/select/logsql/*`) in the same query dialect. A
request's trace id opens a one-span trace at `/trace/<id>?datasource=mobile`
(production: `/apm/inspect/<id>?datasource=mobile`).

What follows is what is worth not re-deriving.

## One page, two sources

Production's two pages are the same surface over different records, so this is
one page too. `pages/TracesView.jsx` takes a `source` prop
(`utils/explorerSources.js`) and reads everything that differs from it: the
rows and their window, the histogram's bands, the facet rail, the field
catalogue, columns, severity, badges, the example, recent and history queries,
the bar's wording, the CSV, the Alert drawer's labels, and whether Explore and
the docs link exist. Traces passes nothing and gets `TRACES_SOURCE`; Mobile
Traces passes `MOBILE_TRACES_SOURCE`. The page itself holds no knowledge of
either dataset, and the contract — every key, and every key agreeing with the
others — is tested for both sources in `utils/explorerSources.test.js`.

Reused unchanged: the filters rail and its resize, the chip query builder,
Run and its dirty state, the history drawer, Save Query and My Queries, the
pipe toolbar, the generated query, the histogram with drag-to-zoom and Reset,
Live, the Fields picker, CSV, the Alert drawer, and the record drawer with
pinning and Newer/Older.

App mounts each page with its own `key` (`traces`, `mtraces`). Without it React
reuses one instance for both routes, and the chips, recents, columns and saved
queries of one page would appear on the other. Saved queries are therefore per
page, as they are per page load (they were never persisted).

The mobile modules:

- `data/mobileTracesExplorer.js` — the records, the histogram counts, the
  facets, and `mobileRecordForTraceId`.
- `utils/mobileTraceFields.js` — the field catalogue, columns, severity, bands,
  and the example, history and recent queries.
- `data/mobileTraceDetail.js` — `buildMobileTrace(id)`, the one-span trace.
- `data/traceResolvers.js` — which store a trace id is looked up in, and how
  the trace view differs per datasource.

## The data

Records are generated per window from whole **sessions**, the way span rows are
built from whole traces: one device, OS, build, country and connection per
session, and a plausible run — launch, Home, catalogue requests, product pages,
cart, checkout, payment — so the drawer's device fields agree across a session
and a crash's `analytics_events` is the trail that session left just before it
(production's shape). Every window of 15 minutes or more carries four forced
sessions so the rare records are always there to find: a crash triggered by a
request that never got an answer (status 0), an ANR after a 4xx from the payment
provider, a first launch (`Mobile/App/Install`), and a checkout whose
`POST /v1/payments` gets a 502/503.

The backend incident reaches the phone: calls that land on payment-service fail
with the shared incident weight (`timeWindow.incidentWeight`), so the outage is
visible from the user's side and a week dilutes it like everything else. The
histogram is calibrated to production's Last 1 hour legend (98.27K: about
86.2K healthy, 9.79K with no status, 692 4xx, 1.57K failing), each band pinned
to its figure.

A field a record does not have is **absent**, never blank: a crash has no
duration, status_code or trace_id, and a custom event has no status_code.
Screens, taps, sessions and breadcrumbs carry `status_code: UNSET`, as in
production. Long values (`stacktrace`, `analytics_events`) stay JSON strings.
Tag names that change how the shared drawer reads a record (`host`, `k8s.*`,
`endpoint`, `http.status_code`, `exception.type`, `status`, …) are not used.

A trace id is decodable: it packs the session's offset from `BASE_TIME`, its
identity word and the record's index behind a checksum, the way the Errors
page's sample ids do. `mobileRecordForTraceId` rebuilds exactly that record from
the id alone, so a reload or a pasted link from any window opens the same
request, and an id that does not decode is not found.

## Severity

Production's mobile page has none: every bar, swatch and row gutter is the same
grey, even on 5xx and crash rows. Here `status_code` holds the HTTP answer,
read by `statusForHttpStatus` (`utils/status.js`): 0 (no answer) and 5xx are
critical, 4xx a warning, 1xx–3xx and UNSET healthy, anything else neutral. A
record's severity (`statusForMobileRecord`) is the worse of that and "critical"
for a crash or an ANR. It drives the row gutter, the status_code cell, the drawer
badge and the histogram band, so a record reads the same everywhere. The CSS
gained the missing warning rules (`.span-status.status-warning`,
`.span-bar-warning`).

The histogram stacks by **severity band**, not by raw status code as production
does: `2xx · UNSET` (healthy), `no status` (neutral: custom events), `4xx`
(warning), and `5xx · 0 · crash` (critical). Ten codes drawn in severity
colours would be four reds nobody could tell apart. Each band's description is
its legend row's tooltip. Band colours are the status tokens
(`var(--critical)` …), never hex — and Traces' own bands moved to the same
scheme.

## The trace view

`/trace/<id>?datasource=mobile` is parsed by `utils/route.js`. The key is
present only for `mobile`, so a backend trace's route is the shape it always
was, and `canonicalUrl` owns the whole URL for a trace so the query is never
written twice. App's `openTrace(id, datasource)` writes it. The mobile page
opens its table's trace links with `datasource: 'mobile'`, and tags the
drawer's "Open this trace" link, which names no dataset, on its way to
`openLink`.

`TraceDetail` resolves the id through `resolveTrace(id, datasource)`. The
mobile resolver returns a trace of one span: kind client, category http (an
install is `internal`), the record's own duration (an install has none and
reads 0), the HTTP code when it is three digits, status `error` and an exception
`{ type: errorType, message: networkError || 'HTTP <code>' }` for a failed
request, and every record attribute as a tag, sorted and not renamed. The
breadcrumb reads "Mobile Traces" and goes back there, and the sidebar keeps
MTraces lit. Database and Profiles are not offered, because a device's request
has neither. Check Logs is hidden, because no log record carries a device's
trace id and the button could only land on an empty page.

An id the resolver cannot find gets a real "Trace <id> not found" page with a
way back to the list, on either datasource. In practice only mobile ids reach
it: the backend resolver keeps its borrow-a-seeded-trace behaviour for ids it
has no spans for, which log records rely on.

## Every difference from production, and what we did

| Production | Here | Why |
|---|---|---|
| No My Queries on Mobile Traces | Kept (Save Query and My Queries) | The same activity as Traces; it is per page because the view is keyed |
| Facets are the stream labels | Pinned to the same five, in production's order | `service` has one value and would fail the span admission test, which would admit device, OS and the rest |
| cube.eventType lists only ANR | Lists MobileSession and ANR | We count record values, and session records carry MobileSession |
| Histogram by raw status_code, all grey | By severity band, in status colours | Rule 1: severity is shown, and it is never ambiguous |
| Row severity bar always grey | Coloured by the record's severity | A 5xx or a crash should look like one |
| "0 ns" for records with no duration | "—" | No duration is not zero duration |
| trace_id links to `/apm/inspect/undefined` when absent | "—" | A link to nothing reads as a broken trace |
| crash_location links to the Mobile page's Crashes tab | Narrows the results to that location (AND chip on the applied query, runs) | That page is a stub here. The row came from the applied query, so the narrowed query is built from it — not from an unrun edit in the bar — and always keeps the row |
| Check Logs on a mobile trace | Hidden | It would always land on an empty Logs page |
| Database and Profiles tabs on a mobile trace | Hidden | Empty by construction |
| Open in Explore uses Explore's mobile datasource | Hidden (`exploreDatasource: null`) | Explore has no mobile datasource yet; sending `traces` would chart backend spans |
| Query placeholder blank once a chip is set | Mobile wording ("e.g. eventType, span_name, crash_location") | The bar should teach this index's fields |

## What changed on Traces along the way

- The free-text rows say "Search spans …" / "Span name", not the Logs wording
  the builder defaulted to.
- Band colours come from status tokens; span events use `--neutral`.
- Under a filter, a band with no sample rows in a bucket is scaled by its
  whole-window filtered share (`filterVolume`) instead of dropping to 0, and a
  band with no sample in the whole window by the share of all rows the filter
  kept. Rare bands used to vanish under any filter, even one that kept every
  row.
- Legend totals past a million read "26.04M", not "26040.64K".
- The drawer's trace link hint names the list the trace opens under (the
  page's title), so on Mobile Traces it says "in Mobile Traces".
- A row with no trace_id shows "—" instead of a link to `/trace/undefined`.
- "View distribution" in the drawer's field menu is offered only where the page
  can draw one. On Traces it threw.
- The trace header and waterfall say "1 span" and "1 service"; Summary lists the
  root when it is the only span; an unknown id has a real not-found page.

## Follow-ups

- **crash_location's target.** Link it to the Mobile page's Crashes tab
  (`/mobile?tab=crashes&service=…&crash_location=…`) once that page exists.
- **Explore's mobile datasource.** Add `mobile` across `editorState`, `api.js`
  and `eventsStore` (and their tests), then set `exploreDatasource: 'mobile'`.
- **JSON values in the drawer.** `stacktrace` and `analytics_events` show as one
  wrapped string, as in production. A "parses as JSON → collapsible pretty
  block" branch in the drawer's field row would help Logs too.
- **URL state.** The query, facets and columns are not in the URL on either page
  (see `query-builder-phase8.md`).
- **Drawer record types.** Every mobile record is typed "Record" with generic
  highlight cards (service, host, trace id). A drawer prop for the highlights —
  eventType, device, OS, app build — would make a crash read as one.
- **Generated query.** Only `service` and `env` are promoted to the `{…}` stream
  selector; production's mobile stream labels (category, eventType, …) are not.
