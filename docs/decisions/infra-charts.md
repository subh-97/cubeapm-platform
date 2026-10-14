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
| Host list and K8s Node list: CPU, Memory, Disk, one line per host or node | `LegendLineChart`, three in one panel (`FleetCharts`) | RED tab, Graph view |
| Every other chart: host disk/network/disk I/O, node and pod charts, cluster allocation and containers, deployment, MySQL, Redis | `CardChart` (`InfraCard`) | Runtime tab's chart card |
| Host CPU and Memory, beside the host's top processes | `.panel` + `.drill2` frame (`ProcessChartPanel`) | Detail tab's Latency Drilldown |
| A source with no integration (AWS, GCP, empty K8s resources) | `NoDataChart`, in the Runtime card's chrome | — |

`CardChart` is the Runtime tab's `RuntimeChart`, moved out of `ServiceOverview`
unchanged. The Runtime tab renders the same markup it did before; this was
checked byte for byte when it moved. It also gained three optional props that
the Runtime tab leaves out:

- `value`: the window's reading beside the title.
- `span="full"`: a card that spans the whole grid row.
- `allowDecimals`: lets a count's axis tick at whole numbers only.

`RT_COLORS`, `LIMIT_DASH` and `fmtRuntimePct` moved with it, as
`RESOURCE_COLORS` (`utils/chartPalette`), `LIMIT_DASH` and `fmtPct1`
(`chartDefaults`).

## Decisions

- **The fleet legends sort busiest first** (`legendSort="valueDesc"`). This is
  the same order as the hosts table, and the series budget draws in legend
  order. So a chart that can't draw all 64 hosts holds back the quiet ones, not
  whichever hosts come last in the data. A legend figure is the window mean and
  matches the table row exactly (`fmtPct2`).
- **Isolation is shared across the three fleet charts**, by host name. This is
  how the Browser page's metric tabs work: click a host in any legend, and CPU,
  memory and disk all show only that host.
- **Charts and table both stay visible.** The RED tab and the Browser page put
  their charts and table behind a Graph | Table switch. Infra doesn't, because
  its table is how you drill into a host, and before this change both were
  visible. The cost is that the table now sits below three full-height charts.
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
- **The ⋮ menus show a toast.** Infra's card menus offer what the service page's
  offer. The screens behind them aren't wired to Infra yet (alerts, Compare,
  Explore over host metrics), so every item says "not part of this prototype
  yet" rather than doing nothing. `system_cpu_utilization` and friends exist in
  the Explore metrics store (`data/explore/metricsStore.js`), so the Explore
  item is the obvious next one to wire.
- **No-data cards have no menu.** They contain nothing to alert on, compare or
  explore. They also carry no drag handlers, because there is no tooltip to
  start the gesture from.
- **The card grid is the Runtime tab's six tracks** (`.infra-card-grid`): a half
  spans three tracks, a third two, a full card six. It reflows on the Infra
  column's own width through a container query, as the Runtime grid does.

## Not fixed here

The time axis can place its last tick label so close to the right edge that it
overruns the plot by a few pixels (for example "18:50" when the window ends at
18:50). It happens on the service page's charts too, so the fix belongs in
`timeAxis.js`, not here.
