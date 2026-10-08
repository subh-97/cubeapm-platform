# The Errors page

A top-level page at `/errors` (sidebar → Errors) that answers "what is failing,
where, and since when" across every service, and walks from a group of errors
to one occurrence, its stack trace and its trace. It mirrors the journey of the
original CubeAPM Errors page (`/errors?kind=server&stream=…`): a Server/Client
toggle, a facet rail, a search bar, rows grouped by service + endpoint +
exception with HTTP codes, a count and a chart, an "Error Details" drawer that
steps through sample occurrences, and a link to the traces behind each row.

What follows is what is worth not re-deriving.

## The unit is a series, not a group

`data/errors.js` hands the page `ErrorSeriesRow`s: one value per field, like a
Prometheus series `sum by (service, root_name, span_name, exception, http_code)`.
The page filters those (facets, then chips) and only then groups them into table
rows. That is what let it reuse the Logs/Traces evaluator (`applyChipsToLog`) and
facet model unchanged: a group carries a list of HTTP codes, and `in` / `:=`
compare one value.

Grouping keys: Server rows group by service + endpoint + exception; Client rows
also keep the outgoing call (`span_name`), so a Redis GET and a Redis SETEX that
throw the same exception under the same endpoint stay two rows. The service
page's Errors tab reads the same module and, on Client, groups one row per call
(`by: ['side','service','spanName','exception']`), so its numbers add up to the
page's.

How the counts are made — calibrated to the RED/DB/External tables at Last 1
hour, diluted by the shared incident profile at wider ranges, samples encoded in
their trace ids — is in `time-range-windowing.md` ("Errors are counted, not
placed") and the header of `data/errors.js`.

## The search is the Logs/Traces builder, told what an error is

`components/errors/ErrorsQueryBuilder.jsx` is `QueryBuilder` with an errors
vocabulary and five opt-in props; Logs and Traces pass none of them and are
unchanged.

- **Field names are the ones the original page shows and puts in its URL**
  (`exception`, `service`, `endpoint`, `http_code`, `span_name`, `message`), not
  the span spellings. The span spellings (`exception.type`, `root_name`,
  `http.status_code`, …) still resolve, so a query copied from Traces filters.
- **`field:value` is a contains** (`colonMatch`), case-insensitive, as in the
  original: `exception:Jedis` and `service:pay` find what they say. `:=` stays
  exact. On Logs and Traces `:` keeps its LogsQL meaning, a whole-word match.
- **Matching values** (`valueSuggestFields`): from two typed characters the
  overlay lists values of exception / service / endpoint / span_name that
  contain the text, with counts. Exception classes are 50-odd characters long;
  people remember `Pool` or `Timeout`, not the package.
- **Free text knows class names.** The words of `java.lang.RuntimeException`
  are one token to the matcher, so free text also searches the class with dots
  as spaces and the short name split at its capitals (`Timeout Exception`).
- **Bare text is a contains too, and Enter commits it** (`freeTextLead`,
  `enterCommitsFreeText`): `payment` or `503` finds rows, the way the original's
  bare term and the service page's Errors search do. Quotes still mean a phrase
  and a trailing `*` a prefix. Free text covers the exception, message,
  service, endpoint, call and HTTP code.
- Counts show on value rows (`showValueCounts`), and the examples are
  errors-shaped (`exampleQueries`), with free-text wording to match
  (`freeTextNoun`, `freeTextMeta`).
- **No Run button.** Chips apply as they are committed, the way the original's
  search filters as you type; the data is local and a chip still being composed
  never filters.

`chipsToString` quotes what needs quoting and `rawQuery` reads every spelling
the builder writes, so the bar's text round-trips through the URL, history and
paste.

## Facets

Not cross-filtered (as on Logs, Traces and the original): a facet's counts are
the side and the range, whatever else is ticked. Exception values are drawn
with the package muted and cut from the left (`FacetGroup`'s `renderLabel`), so
the class name is the part that shows. Services sort critical →
warning → healthy, then by count (CLAUDE.md rule 3). A selected value with no
errors in the range stays listed at 0, so a value seeded from a link can be
seen and unticked.

## The URL

`utils/errorsUrl.js` reads two dialects: ours (`kind`, `service`, `endpoint`,
`span_name`, `exception`, `http_code`, `q`, `time`) and the original's (`error`,
`name`, `root_name`, `stream`), ignoring the keys this page has no notion of
(`index`, `view`, `refresh`, `category`, `host`, `sv`, `env`). So a link copied
from the original lands on the same errors, or on an empty state that says
which value has no occurrences in the range. The page writes back only our
dialect, with `replace`, and only while the path is `/errors`; `time` is read
once on a cold load and never written, because the range belongs to `App`.

A link opened while signed out now survives sign-in (App keeps it as
`returnTo`), and App no longer follows the view into the address bar while
signed out — the two effects used to push `/` and the page's path at each other.

## Leaving the page

- **Traces** (row link, drawer): `openLink({ view: 'traces', filters })` with
  `tracesFiltersFor(group)` — service, span_kind, status_code=ERROR, span_name,
  exception.type, and on Client the caller endpoint (root_name) — which App
  turns into AND-ed chips. The error profiles count far more exceptions than
  the few hundred seeded spans hold, so the data layer keeps one sample span per
  group (the drawer's newest) and Traces merges those in only for a query that
  names an exception (`utils/tracesHandoff.js`); the unfiltered stream is the
  seeded spans alone. Every group's link lands on a row, and that is tested.
- **A trace** (drawer): `/trace/<sample.traceId>`, which rebuilds the failing
  request from the id alone.
- **The service** (drawer): the service page's Errors tab, on the same side
  (`errorsSide`), which links back with "Open in Errors". The tab reads the same
  module and now shows the same delta as the page.

## Client errors that do not fail the request

A Client row counts failed *calls*, at the DB and External tables' rates, and
those tables make several Redis calls per request. So a Redis pool or Hikari
failure on the Client side is absorbed (the request still answers): its sample
trace shows the failing call under a root that succeeded. The request-level
pool failures are the Server rows, whose traces show the failing call under a
failing root. Without this the Client side "failed" 3–19× more payment
requests than the Server side and the RED table say exist. Calls that do fail
the request (the stripe timeout, downstream calls) are mirrored on both sides
and count the same on each.

## Where it deliberately differs from the original

Results load without a click (rule 5); every count carries a delta against the
previous period, "New" when there was none (rule 6); the Traces link opens
already filtered and run; the drawer is our right-side record drawer rather than
a bottom sheet, and adds where the errors happen (hosts, versions) — the canary
`v9.11.0` shows up there; loading and empty states say why they are empty.

## Known gaps

- Browser Back does not map the URL back to a view (App-wide; the
  `fix/service-url-state` work addresses it), and Trace Detail's breadcrumb
  returns to Traces, not to Errors.
- The Traces volume histogram scales a baseline by the filtered share, so after a
  hand-off it can read differently from the exact count beside it.
