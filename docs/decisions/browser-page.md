# The Browser (RUM) page

A top-level page at `/browser` (sidebar → Browser) that shows what real users'
browsers saw of the two browser apps — page loads, the Ajax calls the pages
made, Core Web Vitals, script and Ajax errors, and the traces behind them. It
keeps the journey of the original CubeAPM Browser page (a Service select, the
tabs Page Views | Ajax Calls | Web Vitals | Errors | Traces, Graph | Table,
Script | Ajax, an error modal with un-minified / original stack traces, and a
Path Patterns | Source Maps settings drawer), drawn in the APM & Services
page's design language rather than the original's.

What follows is what is worth not re-deriving.

## The URL is the state, in the original's dialect

`utils/browserUrl.js` reads and writes `service`, `tab`
(`pageviews | ajax-calls | web-vitals | errors | traces`), `view`
(`graph | table`), `kind` (`server | client`, shown as Script | Ajax), and the
Traces filters `endpoint` and `error`. Those are the original's keys and
values, so a link copied out of it opens the same screen. Keys this page has no
notion of (`index`, `name`, `refresh`) are ignored, and `name` never becomes
the endpoint. `time` is read once on a cold load and never written, because
the range belongs to `App`.

`BrowserView` parses `location.search` on every render and holds no copy of it.
The address is corrected in place to one spelling: fixed key order, `service`
always written, defaults omitted, and a bare `/browser` gains the app it opened
on. Moving to another tab or app, and an Errors row opening the Traces tab,
push, so Back undoes them. Graph | Table, Script | Ajax, Type, Endpoint and
Error replace, because they refine the screen you are on. The sidebar's Browser
item reopens the last Browser URL (`App`'s `lastBrowserSearch`).

Other pages reach Browser only through URLs this page wrote itself: the
sidebar's last Browser URL, and a trace's way back (below). `openLink` has no
Browser branch. A future link to one Browser screen should navigate to
`browserUrl(state)`, that screen's one spelling, rather than add a second
dialect for the same state.

## The frame is the service page's

`PageBar` (with refresh and Auto, as on Errors and Explore), then the
`card-tab-strip` (`ServicePicker` over the browser apps, severity-sorted;
the Traces tab's Type and Error selects in `.subtab-filters`), the
`view-tabs`, and the `.svc-main` scroller. On Traces the Endpoint select sits in
the sticky `.endpoint-strip` that hides on scroll down, as on the service
page's Detail tab (`hooks/useScrollReveal`). A refresh dims the tab body but
not the filter strip or an open modal (`browser.css`).

The card ⋮ menus' Explore items open Explore on the app's RUM logs with
`service:<app> | stats count()`, because Explore reports an error rather than
events for a logs query with no stats pipe. The query comes from
`rumExploreQuery` in `data/explore/eventsStore.js`, beside the generator, and
is null for an app the store holds no PageActions for. Today that is
`cubedemo-admin`, whose Explore items show a toast saying so rather than
opening an empty chart. Every other menu item shows the same "not part of
this prototype" toast as on APM.

The view tabs follow the tablist pattern. Each tab names `.svc-main` as the
panel it controls, and the panel names the open tab. Only the open tab is a
Tab stop: the arrows, Home and End move focus along the strip, and Enter or
Space opens a tab. Opening on arrow would push a history entry per keypress.
The CubeAPM crumb is a real `href="/"` link, so it is in the Tab order.

There is no "pick a service" screen as in the original (rule 5): with no
`service` in the URL the page opens on the most severe app.

## Metric tabs: three cards, one Graph | Table panel

Page Views, Ajax Calls and Web Vitals have the same shape. A `.charts-row` of
three `SummaryCard`s shows the app-wide figure with its delta against the
previous period (rule 6) over a `MiniChart`. Below it is one `MetricPanel`,
which is RedTab's markup with the Table | Graph switch in its head.

- **Graph** is three `LegendLineChart`s, one line per route, call or page.
  Each legend is sorted by its own figure. Clicking a legend row isolates
  that series in all three charts at once: the tab holds the choice, by
  label, and passes it to every chart.
- **Table** is the shared `SortableTable` with an ⓘ on every column, as the
  original has. The ⓘ never sorts. Rows open nothing, as in the original, so
  `.brw-static` resets the pointer cursor.
- **Default order** is by impact, never alphabetical. Page Views sorts by
  average load time, Ajax Calls by error %, and Web Vitals by worst rating
  and then LCP.
- **Series colours** come from `browserColor` (`BROWSER_COLORS`, blues to
  violets only), so a line never looks like the good / needs-improvement /
  poor bands drawn behind the vitals charts (rule 2).
- **Severity on Web Vitals** shows in three places, all read off
  `WEB_VITAL_THRESHOLDS` through `statusForWebVital`: a card's rating chip,
  the bands, and one worst-rating dot on each page's URL cell. The figures
  themselves stay plain text.

Figures are page-view means, as in the original, so nothing calls them a p75.

## Errors and Traces reuse the service page's panels

- **Errors** is `ErrorGroupsPanel` (the APM Errors-tab body) with a
  Script | Ajax toggle.
  - A Script row shows the JS exception class and its message. The class opens
    the group's newest sample in the exception modal.
  - An Ajax row shows the status chip and its reason phrase.
  - Clicking a whole row stands in for the original's ↗: it pushes to Traces
    with `kind`, `endpoint` and `error` set. The row is not itself a button,
    because it holds the exception's own button. For the keyboard, the
    Endpoint text is a real button (`.err-open`) that does the same thing.
  - Ten rows show, with "Show all" below.
- **Traces** is `RequestTraceSplit` (APM's Slow Requests split). It has Sort
  by Latency | Time | None (default None), an "N results" picker, an error
  summary, the shared waterfall, and "Trace ID ↗" to `/trace/<id>`.
- **"N results" is a sample of the range, newest first, not the newest N.**
  Production returns the latest N requests. At hundreds of page loads or calls
  a minute, those all come from the last few seconds or minutes, whatever
  range is picked, so on 7 days its ten wealth-search 404s are minutes apart.
  Here the N are spread through the window. Unfiltered requests are spread by
  traffic. An error's samples are placed where its counts are, so an
  incident-only code never predates the incident. The range the reader chose
  therefore shapes the list, and Sort by Latency compares requests from across
  it. The first row is still the newest, and the first ten are among the first
  hundred. For a group with one message, the Errors tab's sample is therefore
  the Traces tab's first row (`browserTracesForWindow`, `pickEvenly`).
- **Filters drop values that can't match.** Changing Type drops an Endpoint or
  Error that the new type doesn't have; the original keeps them and answers
  "No results". Changing Endpoint drops an Error that endpoint never threw.
  An empty list names its filters and offers Clear filters.
- **A failed Ajax call has no browser exception.** For a 5xx, the summary names
  the backend span's exception (for example payment-service's pool exception)
  and prefixes it with that service and span. Clicking it opens
  `SpanExceptionModal`, the same stack modal the trace page opens for that
  span.

## The exception modal is gated on Source Maps

`BrowserExceptionModal` reads everything off the trace id
(`browserExceptionFor`). It has three tabs: Un-minified stack trace, Original
stack trace (the minified bundle frames the browser sent), and Attributes.

The un-minified stack only shows when Settings › Source Maps holds a map for
the exception's bundle file under the exception's own app. Otherwise the tab says which bundle is missing
and offers "Open Source Maps settings", and the modal opens on the original
stack. The source maps start seeded from `BROWSER_SOURCE_MAP_SEED`, so the
readable stack is there to begin with. Deleting the map in Settings shows why
the setting exists.

Path Patterns and Source Maps live in `App` state because the drawer unmounts
when it closes. Path patterns start empty, as in the original.

## A trace remembers it came from Browser

`App.openTraceFrom(id, origin)` puts `{ view, label, url, state }` in the
history entry's state, not in the URL, so `/trace/<id>` stays the one address
of a trace. It is a separate function so that `openTrace(id, datasource)`
stays the call every other page makes. The trail then reads
`CubeAPM / Browser / Trace …` and leads back to the exact Browser screen, and
the sidebar keeps Browser lit, including after a reload. A trace opened any
other way is unchanged.

`state` holds the Traces tab's place: the "N results" count and the open
request. The URL does not hold these, and production's does not either.
`BrowserView` also writes them into its own history entry before leaving, so
both Back and the trace page's Browser crumb (`leaveTrace`) return the list
as it was left, scrolled to that request.

A browser script error's trace opens the same `BrowserExceptionModal` on the
trace page, behind the same Source Maps gate. There, "Open Source Maps
settings" returns to the Browser screen the trace came from (or, for a trace
reached another way, the last Browser screen left), with the drawer open on
Source Maps.

## The data

`data/browser.js` is a pure function of the window, like every other module.
Its header gives the four rules:

1. The original's 7-day figures are the quiet values, so Last 1 hour
   reproduces them to the digit on rows the incident doesn't reach.
2. The payment-service incident reaches the browser through the backend: the
   payment calls' error rate and latency, and checkout's load time and INP.
3. Errors are counted, not placed. Each `clientSecret` TypeError on checkout
   matches one failed create-payment call.
4. A sample is its trace id.

`cubedemo-admin` is small and healthy, and reaches at most warning during the
incident. Both apps are sorted by severity.

**Only Last 1 hour reproduces the original's figures.** Page views and calls
a minute carry the daily traffic wave (`diurnal`, ±38% in `timeWindow.js`),
and pinning to the hour normalises the wave to the hour the demo was opened.
A wider range averages the whole wave. Its rates, and the error counts made
from them, therefore read between about 0.72× (opened at the afternoon peak)
and 1.6× (opened at the early-morning trough) the original's 7-day figures.
QA saw 1.49× on a morning cold load of the user's 7-day link, and 0.77× in the
afternoon. Load times, error %, and the vitals carry no wave, so they match at
7 days (checkout INP 571 ms against 569.73). Pinning the daily mean instead
would match 7 days but break the 1-hour reproduction. That calibration is the
one every data module keeps (`time-range-windowing.md`), and the browser's
incident is tied to the backend's through it.

**A range in which nothing has happened yet shows nothing.** The time
picker checks a custom range against the clock, but the data is checked
against `BASE_TIME`. Once the app has been open a while, a range that lies
wholly after load can therefore be picked. Every reader answers such a
window, which has no past buckets, as it would an app with no data: no rows,
so each table shows its own "No … in this time range" message, and a `null`
summary, so no cards. Without this, the cards would show baseline rates
beside 0 ms load times rated Good.

## Shared pieces extracted for it

All of these render the APM, Infra, Errors and Trace pages exactly as before
when their new props are left out:

- `FilterSelect`, `ViewToggle`, `SearchGlyph`, `TitleDropdown`
- `SortableTable` (promoted from Infra)
- `useScrollReveal`
- `LegendLineChart` (from RedDrilldownChart), `MiniChart`, `thresholdBands`
- `ErrorGroupsPanel`, `ExceptionModal` (from the trace page's StackModal),
  `SpanExceptionModal` (that modal for a backend span, now used by both the
  trace page and the Traces tab), `StackTraceView`
- `RequestTraceSplit` (from SlowRequests)
- `utils/focusTrap` (`trapTab`, used by the exception modal and the settings
  drawer)

`ServicePicker` gained `items`, `label`, `noun` and `idPrefix`. `TabBar`
gained `idPrefix`, which turns it into a full tablist with arrow keys and one
Tab stop.

## Known gaps

- **Long Ajax endpoints in narrow legends.** At 1280px the longest endpoints
  are already cut short. At tablet widths the cut falls right after the host,
  so the four search calls read alike. Each row's title holds the full
  endpoint.
