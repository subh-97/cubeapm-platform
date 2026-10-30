# Infrastructure charts are the service page's charts

Every chart on `/infrastructure` (every source, every drill-in) is drawn with
one of the APM service page's chart components. Before this, Infra had its own
copies: a private chart frame (`useChartTime`), its own two tooltips, a fleet
chart with no legend, and cards with no ⋮ menu. They drifted from the service
page each time the service page improved. Now an improvement to a shared
component reaches both pages.

## Which component draws what

| Infra chart | Component | Service page origin |
|---|---|---|
| Host list and K8s Node list: CPU, Memory, Disk, one line per host or node, three cards in one row with no legends | `CardChart` (`InfraCard`, `legend={false}`, `tooltipLimit`, `budgetNoun`), via `FleetCards` | Runtime tab's chart card |
| K8s Pod list, per namespace and Filter: CPU Used (cores), Memory Remaining (bytes), Disk Used %, one line per pod (a pod with no memory limit has no Memory Remaining line), and the Pods count, in a 2×2 grid with no legends | `CardChart` (`InfraCard`, `legend={false}`) | Runtime tab's chart card |
| Every other chart: host disk/network/disk I/O, node and pod charts, cluster allocation and containers, deployment, MySQL, Redis | `CardChart` (`InfraCard`) | Runtime tab's chart card |
| Host CPU and Memory, beside the host's top processes | `.panel` + `.drill2` frame (`ProcessChartPanel`) | Detail tab's Latency Drilldown |
| A source with no integration (AWS, GCP, empty K8s resources) | `NoDataChart`, in the Runtime card's chrome | — |

`CardChart` is the Runtime tab's `RuntimeChart`, moved out of `ServiceOverview`
unchanged. The Runtime tab renders the same markup it did before; this was
checked byte for byte when it moved. It also gained optional props that the
Runtime tab leaves out:

- `value`: the window's reading beside the title.
- `span="full"`: a card that spans the whole grid row.
- `allowDecimals`: lets a count's axis tick at whole numbers only.
- `legend={false}`: no legend under the plot, for a card whose lines are a
  list of things the tooltip names (the Host, Node and Pod lists), as
  production draws them.
- `tooltipLimit`: the most series the tooltip lists before it counts the rest
  (`ChartTooltip`'s `limit`); the Host list passes `TOOLTIP_ROWS` (12).
- `budgetNoun`: puts the card under a series budget (`useSeriesBudget`, with
  `SeriesBudgetFooter` under the plot), worded with that noun ("hosts").

Both the Runtime tab and every Infra card pass `forWindow`: the card over
another window, for its Compare (`docs/decisions/chart-compare-expand.md`).

`RT_COLORS`, `LIMIT_DASH` and `fmtRuntimePct` moved with it, as
`RESOURCE_COLORS` (`utils/chartPalette`), `LIMIT_DASH` and `fmtPct1`
(`chartDefaults`).

## Decisions

- **The fleets are cards without legends.** The Host and Node lists draw CPU,
  memory and disk as three cards in one row; the Pod list follows production
  with four cards, two by two. A line is named by the tooltip only. The cost:
  there is no legend search and no isolating one host across the charts; the
  table under them is where a host is found and opened. Each fleet card keeps
  the series budget the legend charts had (`budgetNoun`): it draws the busiest
  8 at a third's width and offers "Show 20 more · Show all" under its plot,
  each card on its own, with the axis fixed over every host while any are held
  back.
- **A fleet is listed busiest first.** Each card orders its hosts by the
  window's mean, the order the tables sort by, which is also the order its
  budget draws in, so the quiet hosts are the ones held back. Once more than 12
  are drawn the tooltip lists the busiest 12 (`TOOLTIP_ROWS`), always keeps the
  line under the pointer, and counts the rest, and its figure matches the table
  row (`fmtPct2`). A host keeps its colour on every card, keyed on its place in the
  data, not its rank.
- **The Pod list narrows by its Filter** (a workload kind, then one workload of
  it). A pod keeps its colour while the Filter narrows, keyed on its place in
  the namespace.
- **Charts and table both stay visible.** The RED tab and the Browser page put
  their charts and table behind a Graph | Table switch. Infra doesn't, because
  its table is how you drill into a host, and before this change both were
  visible. The fleets' cards keep the charts to one row above the table.
- **No status hues on series (rule 2).** Infra used to draw CPU in amber,
  memory in red and disk in green, and the process list used reds, oranges and
  yellows. Now:
  - fleets use `infraColor`: the Browser palette, built for long lists that
    must avoid every status hue;
  - a reading and its ceilings use `RESOURCE_COLORS`, the Runtime tab's
    used/committed/limit/alt colours;
  - a single series uses the brand blue.

  `InfraView.test.js` fails if any view renders a status hex.
- **Configuration lines are dashed.** In cluster allocation, total, request and
  limit are configured values, not readings, so they take `LIMIT_DASH`, the
  same dash Runtime uses for a JVM's limit. A request is coloured as
  "committed". The two allocation charts keep their old draw orders: memory
  draws `used` under its ceilings, CPU doesn't.
- **Network traffic shows both directions everywhere.** Host, node and pod all
  draw transmit and receive stacked. Host and pod used to draw receive only,
  under the title "Network Traffic".
- **The process column is a ranking, not a legend.** The agent reports each
  process's share as a single figure, not a series, so the chart has no line
  for a process. The rows therefore have no swatch and do nothing when clicked.
  They are searchable and scroll, like the service page's legends. The process
  figures (`HOST_PROCESSES`) are static: the same for every host and every
  window.
- **CPU State % and Load Average are stubbed.** These two tabs on the CPU panel
  have no data in this prototype. They show dimmed and inert with a title that
  says so, the same way the sidebar stubs pages that aren't built. They used to
  look clickable and do nothing.
- **Every chart expands and compares.** Each chart's corner is Expand and the
  ⋮ (`ChartActions`), and the ⋮'s Compare draws the chart over the page's
  window and over the same span an hour, a day or a week back
  (`docs/decisions/chart-compare-expand.md`). The earlier chart is drawn by the
  derivation the card uses, run on the earlier window's rows:
  - A drill-in's cards (a host, a node, a pod, a pod's container) are each one
    function of the row they chart (`rowCard`). The earlier copy finds that
    row in the earlier window by name, the way the page resolves its own
    selection. The container charts keep the picked container's name.
  - A fleet card keeps the page's busiest-first order, and so its hosts, in
    the earlier copy. Re-ranked by its own means, the hosts at the edge of the
    budget trade places (an hour back on CPU, a day back on disk), and the two
    charts would draw different hosts under one title. Colours are keyed on a
    host's place in the data, which every window shares.
  - The Pod list's cards re-apply the namespace and the Filter to the earlier
    window's pods.
  - A host's CPU and memory panels draw the chart with its Top processes
    column in the modal, as the panel does under the one tab with data. The
    stubbed tabs stay on the page.
  - The figures beside MySQL's titles and beside Redis's memory and commands
    are the summary's current readings, not the window's, so the earlier copy
    prints none rather than today's figure over another day's line. A figure
    read off the window (a host's disk, a node's CPU, Redis's evictions) is
    worked out again for the earlier window.

  Every view reads its rows through per-window caches (`perWindow`), so an
  earlier window's 64 hosts are built once however many cards draw them.
- **The rest of the ⋮ shows a toast.** Create Alert on a host's CPU opens the
  alert editor. The other items' screens aren't wired to Infra yet (alerts on
  other metrics, Explore over host metrics), so they say "not part of this
  prototype yet" rather than doing nothing. `system_cpu_utilization` and
  friends exist in the Explore metrics store (`data/explore/metricsStore.js`),
  so the Explore item is the obvious next one to wire.
- **No-data cards have no menu and no Expand.** They contain nothing to alert
  on, compare, explore or look at closer. They also carry no drag handlers,
  because there is no tooltip to start the gesture from.
- **The card grid is the Runtime tab's six tracks** (`.infra-card-grid`): a half
  spans three tracks, a third two, a full card six. It reflows on the Infra
  column's own width through a container query, as the Runtime grid does.

## Not fixed here

The time axis can place its last tick label so close to the right edge that it
overruns the plot by a few pixels (for example "18:50" when the window ends at
18:50). It happens on the service page's charts too, so the fix belongs in
`timeAxis.js`, not here.
