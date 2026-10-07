# Reference — the Metrics editor

Derived by reading the playground's shipped bundle (`app.pretty.js`, 384k lines, pretty-printed).
This note covers the **Metrics** datasource editor only: its three tabs (Quick, Advanced, Code), the
query each one generates, and the state machine that joins them. The Logs/Traces/Mobile editor is a
different component (`pce`, tabs `builder` | `code`) and is not covered here.

Identifiers are from one build and will not survive a rebuild; behaviour and verbatim strings are
the durable part. Line numbers are given as a finding aid, not as a contract.

## Where it lives

| Thing | Identifier | Line |
|---|---|---|
| Datasource switch (Metrics/Logs/Traces/Mobile) | `Cne` | 305973 |
| Metrics editor — tab shell | `oVn` | 305886 |
| Quick tab | `iVn` | 305433 |
| Advanced tab | `sVn` | 305627 |
| Code tab | `rVn` | 305870 |
| Shared filter-row list (WHERE/AND) | `vvt` | 305317 |
| Read-only "Generated Query" panel | `pvt` | 305305 |
| PromQL Monaco editor | `H9` | 305215 |
| Monaco completion provider | `Jzn` | 305150 |
| Operation catalogue | `Yzn` | 305019 |
| Operation descriptions | `vce` | 304988 |
| Label descriptions | `fvt` | 304971 |
| Metric descriptions | `Qzn` | 304955 |

Minification aliases used below: `f.jsx(s)` = JSX, `y.useState` = `useState`, `vt` = antd `Select`,
`en` = antd `Input`, `Qe` = antd `Button`, `fd` = antd `Checkbox`, `hn.Group`/`hn.Button` = antd
`Radio.Group`/`Radio.Button`, `c_` = antd `Tabs`, `Ds` = antd `Tooltip`, `sn` = the app's axios
instance, `bv` = a filled info-circle icon, `yp` = an X icon.

## The Explore page around it

`Cne` is rendered by the Explore page (`title: "Explore"`, line 350224) inside one bordered card.
Below it sit **Generate Graph** (antd primary button, `disabled` while the committed query is empty),
a CSV download button, and the chart/table controls. Nothing runs automatically: the editor only
reports `(datasource, query, model)` upward, and the page copies query → chart state when
**Generate Graph** is pressed.

The same `Cne` appears in three other places with different props: the alert rule editor
(`quickLatencyInMs: true`), the read-only alert preview (`readOnly: true, quickLatencyInMs: true`),
and the dashboard panel editor (no `quickLatencyInMs`, panels addressed by a `hide` flag).

### Props

| Prop | Type | Default | Effect |
|---|---|---|---|
| `hide` | bool | — | Renders `null` from `oVn`; `Cne` keeps every child mounted and only hides, so editor state survives. |
| `mode` | `"all"` \| `"metrics"` \| `"logs_traces"` | `"all"` | `"metrics"` disables the Logs/Traces/Mobile radio buttons; `"logs_traces"` removes the Metrics button and starts on `vlogs`. |
| `datasource` | `"prometheus"` \| `"vlogs"` \| `"traces"` \| `"mobile"` | `"prometheus"` | Which editor is shown. |
| `query` | string | — | Incoming query text. |
| `model` | object | — | Incoming builder model; see **The tab state machine**. |
| `quickLatencyInMs` | bool | falsy | Quick tab only: relabels the two latency options and multiplies the generated query by 1000. |
| `readOnly` | bool | falsy | Disables every control **and** disables all three tabs (see bug R3). |
| `onChange` | `(datasource, query, model) => void` | — | Fired on every edit and on every tab/datasource switch. |

## Shared shapes

### Filter row (`labelPair`)

```js
{ label: "", operator: "=", values: [], options: [] }   // gke, the blank row
```

`options` is the fetched value list for that row's dropdown; it is **not** part of the query and is
stripped (`options: []`) whenever a model is read back in.

### Models

```js
{ type: "quick",    calculate, value, labelPairs, groupBy }
{ type: "advanced", metric, labelPairs, functions }
// Code tab emits no model (undefined)
```

`calculate` is one of `"rpm" | "error_percentage" | "latency_percentile" | "latency_average"`;
`value` is the percentile **as a string** (the raw input value, e.g. `"90"`); `groupBy` is an array
of label names; `functions` is an array of operation entries (see **Advanced**).

### Matcher serialisation (`mvt`)

```js
`${label}${operator}${operator.endsWith("~") ? Qk(values) : me(values[0] || "")}`
```

- `me(v)` → `"` + v with `\` and `"` backslash-escaped + `"`.
- `Qk(values)` → each value has every character in `/[.*+?^${}()|[\]\\"'<>-]/g` prefixed with `\`,
  the results are joined with `|`, and the whole thing goes through `me`. Because `me` then escapes
  the backslashes again, `service` ∈ {`svc-a`, `svc.b`} serialises to `service=~"svc\\-a|svc\\.b"`
  — a PromQL string literal holding `svc\-a|svc\.b`, which is the intended regex.
- A non-`~` operator with an empty `values` array serialises to `label=""`, not to nothing.

### Metadata endpoints

All are POSTs with `Content-Type: application/x-www-form-urlencoded` and a body of
`{ start, end }` plus `match[]` when the selector string is non-empty. `start`/`end` are the
**step-aligned** unix seconds from the global time-range hook `fn()`
(`[refreshToken, start, end, step, rawStart, rawEnd]`).

| Helper | Endpoint | Returns |
|---|---|---|
| `Tw(selector, start, end)` | `POST /api/metrics/api/v1/labels` | sorted label names |
| `In(label, selector, start, end)` | `POST /api/metrics/api/v1/label/<label>/values` | sorted label values |

Both swallow failures: they `Bt.error("Failed to fetch labels (…): …")` /
`"Failed to fetch label values (…): …"` as a toast and resolve to `[]`. There is no retry, no
in-flight flag and no spinner anywhere in the editor — a failed fetch is indistinguishable from an
empty result in the dropdown, which falls back to antd's default **"No data"** empty state.

`In("__name__", "", start, end)` is how both the metric picker and the code-editor autocomplete get
the metric-name list.

## Filter rows — WHERE / AND (`vvt`)

One shared component, used by both Quick and Advanced. It renders one row per entry in `pairs` and
takes `filters` (a list of base matcher strings used only for narrowing value lookups), `labels`
(the label names offered), `pairs`, `setPairs` and `readOnly`.

Each row is a flex line of up to five controls:

| Control | Type | Width | Behaviour |
|---|---|---|---|
| heading | `<h1>` | — | `"WHERE"` on row 0, `"AND"` on every later row. |
| label | `Select` | `280px` fixed | `showSearch`, `allowClear`. Option label is two lines — the label name, then its description from `fvt` in `text-xs text-[#999]` — but `labelRender: ({value}) => value`, so the collapsed control shows the bare name. |
| operator | `Select` | `minWidth 160px` | Four options, below. |
| value | `Select` | `minWidth 280px` | `showSearch`; `mode: "multiple"` iff the operator ends in `~`, otherwise single. Options are `row.options.map(v => ({value: v}))` — no labels, no descriptions. |
| Remove | `Button danger` | — | Rendered only when `!readOnly && pairs.length > 1`. `pairs.toSpliced(i, 1)`. |
| Add more | `Button primary` | — | Rendered only when `!readOnly && i === pairs.length - 1`. Appends the blank row `gke`. |

Operator options, value and visible label verbatim:

| Value | Label |
|---|---|
| `=` | `equals` |
| `!=` | `not equals` |
| `=~` | `in` |
| `!~` | `not in` |

Interactions:

- **Changing the label** rewrites the row as `{...row, label, values: [], options: []}` — the chosen
  values and the cached option list are both dropped.
- **Changing the operator** keeps `values` untouched when the new operator ends in `~` or when
  `values` is already empty; otherwise it truncates to `[values[0]]`. So `in [a, b]` → `equals`
  keeps only `a`, and switching back to `in` does not restore `b`.
- **Changing the value** stores `typeof v === "string" ? [v] : v`, so `values` is always an array.
- **Opening the value dropdown** (`onOpenChange(true)`) is the only thing that fetches options:

  ```js
  const preceding = pairs.slice(0, i).filter(r => r.label).map(mvt);
  const selector = `{${[...filters, ...preceding].join(", ")}}`;
  In(row.label, selector, start, end).then(opts => setPairs(pairs.with(i, {...row, options: opts})));
  ```

  Narrowing therefore comes from the base `filters` **and from rows strictly above this one** — a
  row is never narrowed by itself or by rows below it. The fetch is re-issued on every open (no
  cache, no debounce, no abort) and the dropdown shows antd's default **"No data"** while it is in
  flight, since nothing tracks loading.

Option search is antd's default. No `optionFilterProp` is set and these options carry either no
`label` or a React element as the label, so filtering falls through to `cre(option.value, query)` —
a case-insensitive substring test **against the value**. Label descriptions are not searchable.

Each row's React key is `` `${row.label}-${i}` ``.

## Quick tab (`iVn`)

Label `"Quick"`, key `"quick"`. Mounted first, so its state exists from the moment the editor opens.

### State

```js
calculate   // undefined initially — nothing is preselected
percentile  // string, "90"
pairs       // [gke] — one blank WHERE row
groupBy     // []
```

A model-sync effect on `[model]` copies an incoming `type: "quick"` model in:
`calculate = model.calculate`, `percentile = String(model.value)`,
`pairs = model.labelPairs.map(p => ({...p, options: []}))`, `groupBy = model.groupBy`.

### The label list

Quick does **not** fetch label names. It uses a hard-coded list, in this order, with two of them
flagged `isSpecial`:

| Label | Special |
|---|---|
| `env` | |
| `service` | |
| `root_name` | |
| `service.version` | |
| `host.name` | |
| `http_code` | ✓ |
| `exception` | ✓ |

The same list feeds the WHERE/AND label picker and the GROUP BY picker. "Special" means *present
only on error spans*, and it changes how Error % is built (below).

Value lookups for the filter rows are narrowed by a fixed base:

```js
filters: ['__name__="cube_apm_calls_total"', 'span_kind=~"server|consumer"']
```

— the calls metric, always, even when the chosen calculation reads `cube_apm_latency_bucket`.

### Controls

| Control | Type | Visible label | Notes |
|---|---|---|---|
| CALCULATE | `Select`, `minWidth 280px` | heading `CALCULATE` | Four options; no placeholder; starts empty. |
| percentile | `Input type=number`, `width 120px`, `required`, `suffix "%ile"` | — | **Rendered only when calculate is `latency_percentile`.** |
| WHERE / AND | `vvt` | `WHERE` / `AND` | As above. |
| GROUP BY | `Select`, `minWidth 280px`, `mode="multiple"`, `showSearch` | heading `GROUP BY` | Options are `{value: labelName}` — no descriptions here. |
| Generated Query | `pvt` | heading `Generated Query` | Read-only `H9` editor over the current query. |

CALCULATE options, value and visible label verbatim:

| Value | Label (`quickLatencyInMs` falsy) | Label (`quickLatencyInMs` true) |
|---|---|---|
| `rpm` | `RPM` | `RPM` |
| `error_percentage` | `Error %` | `Error %` |
| `latency_percentile` | `%ile Latency` | `%ile Latency (millis)` |
| `latency_average` | `Avg Latency` | `Avg Latency (millis)` |

Every control takes `disabled={readOnly}`.

### Percentile validation

The raw string goes through `yh(value)`:

```js
/^[+-]?((\d{1,8})|(\.\d{1,6})|(\d{1,8}\.\d{0,6}))$/
```

with no min and no max. So `90`, `99.9`, `.5`, `-5` and `150` all pass; `90%`, `1e2` and an empty
box do not. The quantile sent to PromQL is `value / 100`. When `yh` returns `undefined` the whole
query becomes the empty string and the emitted model is `undefined`.

### Query generation

One effect, deps `[calculate, percentile, pairs, groupBy]`. It returns immediately when `calculate`
is unset — nothing is emitted and the outer query keeps its previous content.

The matcher list is built by a local helper:

```js
function matchers(dropSpecial) {
  const out = pairs
    .filter(p => p.label && (!dropSpecial || !isSpecial(p.label)))
    .map(mvt);
  out.push('span_kind=~"server|consumer"');
  return out;
}
```

`span_kind=~"server|consumer"` is always last and is not user-removable.

Operations are composed by `q2(expr, op)` (left fold):

| Op shape | Result |
|---|---|
| `{value: "rate", args: []}` | `rate(expr)` |
| `{value: "sum", args: [{type: "aggregation", value: ["a","b"]}]}` | `sum(expr) by (a, b)` — the ` by (…)` suffix is omitted when the array is empty |
| `{value: "histogram_quantile", args: [{type: "number", value: "0.9", position: "before"}]}` | `histogram_quantile(0.9, expr)` |
| `{type: "operator", value: "*", args: [{type: "number", value: "2"}]}` | `expr * 2` |

Per calculation:

**`rpm`**

```
sum(rate(cube_apm_calls_total{<matchers()>} default 0))[ by (<groupBy>)] * 60
```

**`error_percentage`** — numerator over the full matcher list plus `status_code="ERROR"`, grouped by
everything; denominator over the matcher list with special labels dropped, grouped by the non-special
group-bys only, joined with `ignoring (<special group-bys>) group_left` when any group-by is special:

```
sum(increase(cube_apm_calls_total{<matchers()>, status_code="ERROR"} default 0))[ by (<groupBy>)]
  * 100 /[ ignoring (<special groupBy>) group_left] sum(increase(cube_apm_calls_total{<matchers(true)>} default 0))[ by (<plain groupBy>)]
```

**`latency_percentile`**

```
histogram_quantile(<p/100>, sum(increase(cube_apm_latency_bucket{<matchers()>} default 0)) by (<groupBy…>, vmrange))[ * 1000]
```

`vmrange` is always appended to the grouping, so this branch always emits ` by (…)`. The `* 1000`
tail is present only when `quickLatencyInMs` is set.

**`latency_average`**

```
sum(increase(cube_apm_latency_total{<matchers()>} default 0))[ by (<groupBy>)][ * 1000] / sum(increase(cube_apm_calls_total{<matchers()>} default 0))[ by (<groupBy>)]
```

The `* 1000` sits on the numerator only, which is correct — the ratio is seconds→millis.

### Worked examples

RPM, no filters, no grouping:

```promql
sum(rate(cube_apm_calls_total{span_kind=~"server|consumer"} default 0)) * 60
```

RPM, `WHERE env equals prod`, group by `service`:

```promql
sum(rate(cube_apm_calls_total{env="prod", span_kind=~"server|consumer"} default 0)) by (service) * 60
```

RPM, `WHERE service in [svc-a, svc.b]` (note the double escaping from `Qk` + `me`):

```promql
sum(rate(cube_apm_calls_total{service=~"svc\\-a|svc\\.b", span_kind=~"server|consumer"} default 0)) * 60
```

Error %, no filters, group by `service`:

```promql
sum(increase(cube_apm_calls_total{span_kind=~"server|consumer", status_code="ERROR"} default 0)) by (service) * 100 / sum(increase(cube_apm_calls_total{span_kind=~"server|consumer"} default 0)) by (service)
```

Error %, group by `http_code` (a special label — the denominator loses the grouping and the division
gains an `ignoring … group_left`):

```promql
sum(increase(cube_apm_calls_total{span_kind=~"server|consumer", status_code="ERROR"} default 0)) by (http_code) * 100 / ignoring (http_code) group_left sum(increase(cube_apm_calls_total{span_kind=~"server|consumer"} default 0))
```

Error %, `WHERE http_code equals 500`, no grouping — the special filter is dropped from the
denominator, so the result is "share of all traffic that failed with 500", not "share of 500s":

```promql
sum(increase(cube_apm_calls_total{http_code="500", span_kind=~"server|consumer", status_code="ERROR"} default 0)) * 100 / sum(increase(cube_apm_calls_total{span_kind=~"server|consumer"} default 0))
```

p90 latency, group by `service`, `quickLatencyInMs` set:

```promql
histogram_quantile(0.9, sum(increase(cube_apm_latency_bucket{span_kind=~"server|consumer"} default 0)) by (service, vmrange)) * 1000
```

Average latency, no grouping, `quickLatencyInMs` set:

```promql
sum(increase(cube_apm_latency_total{span_kind=~"server|consumer"} default 0)) * 1000 / sum(increase(cube_apm_calls_total{span_kind=~"server|consumer"} default 0))
```

### Emission

```js
if (generated !== incomingQuery) {
  onChange(generated, isValid ? {type:"quick", calculate, value: percentile, labelPairs: pairs, groupBy} : undefined);
}
```

where `isValid` is `calculate !== "latency_percentile" || yh(percentile) !== undefined`. The guard
compares against the **incoming** `query` prop, so an edit that happens to regenerate the identical
string emits nothing — including the model, which is therefore not refreshed.

## Advanced tab (`sVn`)

Label `"Advanced"`, key `"advanced"`. Mounted the first time it is opened and kept mounted
thereafter (antd `Tabs` with `removeOnLeave: false`), so its two metadata fetches do not run until
the user first visits the tab.

### State

```js
metrics    // [] — every metric name, from In("__name__", "", start, end)
showAll    // false
metric     // ""
labels     // [] — label names for the selected metric
pairs      // [gke]
functions  // []
```

A model-sync effect on `[model]` copies an incoming `type: "advanced"` model in: `metric`,
`pairs = model.labelPairs.map(p => ({...p, options: []}))`, `functions = model.functions`.

### Metadata

| Effect | Deps | Call |
|---|---|---|
| metric list | `[refreshToken]` | `In("__name__", "", start, end)` → `metrics` |
| label list | `[refreshToken, metric]` | when `metric !== ""`: clears `labels` to `[]`, then `Tw('{__name__="<metric>"}', start, end)` → `labels` |

Both are keyed on the refresh token rather than on `start`/`end` directly; the time-range picker
writes a refresh timestamp alongside the range, so in practice a range change does refetch.

### FROM — the metric picker

```
FROM  [x] Show all
[ Select, minWidth 456px ]
```

- `Show all` is an antd `Checkbox` sitting inside the `FROM` heading (`className="ml-4"`),
  unchecked by default. While unchecked the option list is
  `metrics.filter(m => m.startsWith("cube_apm_"))`; checked, it is every metric the backend
  returned. Toggling it does not change the current selection, so a non-`cube_apm_` metric chosen
  with Show all on stays selected (and shows correctly, because `labelRender` reads the value) after
  the box is unchecked.
- `showSearch`, no `allowClear`, no placeholder. Option labels are two lines — the metric name, then
  `Qzn[name]` in `text-xs text-[#999] max-w-[400px]`; `labelRender: ({value}) => value`.
- Search matches the metric **name** only (same antd default as everywhere else here).

The six documented `cube_apm_*` metrics and their verbatim descriptions:

| Metric | Description |
|---|---|
| `cube_apm_calls_total` | `API calls tracked by CubeAPM. Use this to calculate request rates, e.g. RPM, error rate, etc.` |
| `cube_apm_ingested_bytes_total` | `Amount of data ingested by CubeAPM. Use this to calculate data ingestion rate/cost.` |
| `cube_apm_latency_bucket` | `Latencies of API calls tracked by CubeAPM, segmented into buckets. Use this to calculate latency percentiles, e.g., p90 latency.` |
| `cube_apm_latency_count` | `Count of API calls tracked by CubeAPM. Use this to calculate estimates over sampled data.` |
| `cube_apm_latency_sum` | `Latencies of API calls tracked by CubeAPM. Use this to calculate estimates over sampled data.` |
| `cube_apm_latency_total` | `Latencies of API calls tracked by CubeAPM. Use this to calculate average latency.` |

Any other metric renders with no description line.

### WHERE / AND

The same `vvt` as Quick, with `labels` = the selected metric's label names and
`` filters: [`__name__=${me(metric)}`] ``. Before a metric is chosen that base is `__name__=""`, and
the label list is empty, so the rows are present but useless.

Label descriptions (`fvt`) are shared with Quick and cover more labels than Quick offers:

| Label | Description |
|---|---|
| `__name__` | `Special label whose value is the metric name` |
| `env` | `Identifier of the environment. Useful for multi-environment deployments.` |
| `exception` | `Type of the error` |
| `group_name` | `Grouping identifier for external calls by a micro-service, e.g., database name for db calls and domain name for HTTP calls. Useful for segmentation of count and latency of external calls.` |
| `host.name` | `Name of the host where the micro-service is running` |
| `http_code` | `HTTP response code of the API endpoint` |
| `instance` | `Identifier of CubeAPM node. Useful for analyzing a particular node in a CubeAPM cluster.` |
| `root_name` | `Name of API endpoint` |
| `service` | `Name of the micro-service` |
| `service.version` | `Version of the micro-service` |
| `span_kind` | `Type of operation - server means incoming request and client means outgoing request` |
| `status_code` | `Status of operation - OK means completed successfully, ERROR means resulted in error, UNSET means not set` |

Any other label renders with no description line.

### SELECT — the operation catalogue

Operations are a flat ordered list; each is rendered as a bordered card, and a trailing `Select`
(`width 280px`, `showSearch`) appends a new one. The picker's own `value` is `""` once at least one
operation exists and `"* "` while the list is empty — `"* "` matches no option, so antd renders the
literal string `* ` in the closed control as an "identity" placeholder.

Catalogue (`Yzn`), verbatim. The option's visible label is the operation's value rendered over its
description from `vce`; group headers are plain strings.

**Aggregation**

| Value | Args | Description |
|---|---|---|
| `avg` | `aggregation` | `Average of values. Also supports group_by.` |
| `count` | `aggregation` | `Number of samples. Also supports group_by.` |
| `max` | `aggregation` | `Maximum value. Also supports group_by.` |
| `min` | `aggregation` | `Minimum value. Also supports group_by.` |
| `sum` | `aggregation` | `Sum of values. Also supports group_by.` |
| `topk` | `number k` (default `"5"`, `position: "before"`), then `aggregation` | `Top k values. Also supports group_by.` |

**Rounding**

| Value | Args | Description |
|---|---|---|
| `ceil` | — | `Round up to nearest integer` |
| `clamp` | `number min` (**no default**), `number max` (default `"1"`) | `Converts values less than min to min and values greater than max to max` |
| `clamp_max` | `number max` (default `"1"`) | `Converts values greater than max to max` |
| `clamp_min` | `number min` (**no default**) | `Converts values less than min to min` |
| `floor` | — | `Round down to nearest integer` |
| `round` | `number to_nearest` (default `"1"`) | `Round to nearest multiple of to_nearest. to_nearest can also be a fraction.` |

**Range**

| Value | Args | Description |
|---|---|---|
| `changes` | — | `Number of value changes` |
| `delta` | — | `Difference between values. Should be used with gauge metrics only. Gauge metrics are those that can go up and down.` |
| `deriv` | — | `Rate of change. Should be used with gauge metrics only. Gauge metrics are those that can go up and down.` |
| `increase` | — | `Increase in value. Should be used with counter metrics only. Counter metrics are those that can only go up.` |
| `rate` | — | `Rate of change. Should be used with counter metrics only. Counter metrics are those that can only go up.` |
| `resets` | — | `Number of value resets. Should be used with counter metrics only. Counter metrics are those that can only go up.` |

**Histogram**

| Value | Args | Description |
|---|---|---|
| `histogram_quantile` | `number quantile` (default `"0.9"`, `position: "before"`) | `Used to calculate percentiles, e.g., p90 latency. The quantile argument must be between 0 and 1.` |

**Operators** — these carry `type: "operator"`, which changes how `q2` renders them.

| Value | Args | Description |
|---|---|---|
| `*` | `number by` (default `"1"`) | *(none — no `vce` entry, so no description line and no info tooltip)* |
| `/` | `number by` (default `"1"`) | *(none)* |

Because the group header is a plain string while the leaf labels are React elements, antd's default
filter matches a typed query against **the group name or the operation value**. Typing `round`
matches both the `round` operation and the whole `Rounding` group.

### Adding and editing an operation

```js
onChange: (_, option) => setFunctions([...functions, {
  ...option,
  label: "",
  args: option.args.map(a => ({...a, value: a.type === "aggregation" ? [] : (a.default ?? 0)})),
}])
```

`a.default ?? 0` seeds a **number** `0` for the two args with no default (`clamp.min`,
`clamp_min.min`), while every other seeded value is a **string**. The arg's `label` field survives
and is used as the input's heading.

Each card renders:

- a header: the operation's `value` as text, an info icon (`bv`, size 12) wrapped in an antd
  `Tooltip` whose `title` is the `vce` description — omitted when there is no description, i.e. for
  `*` and `/` — and an X icon (`yp`, size 12) that calls `functions.toSpliced(i, 1)` unless
  `readOnly`;
- one control per arg:
  - `aggregation` → heading `group by`, `Select minWidth 180px`, `mode="multiple"`, `showSearch`,
    options `labels.map(l => ({value: l}))`. **Rendered only when a metric is selected**, so an
    aggregation added before choosing a metric shows an empty card body.
  - `number` → heading = the arg's `label`, `Input type=number required maxWidth 120px`.

There is no reordering: operations apply in insertion order, and the only way to change the order is
to delete and re-add.

### Query generation

One effect, deps `[metric, pairs, functions]`; returns immediately when `metric` is falsy.

```js
const matchers = pairs.filter(p => p.label).map(mvt);
let q = "";
if (/^[a-zA-Z][a-zA-Z0-9_:.]*$/.test(metric)) q = metric;
else matchers.unshift(`__name__=${me(metric)}`);
if (matchers.length) q += `{${matchers.join(", ")}}`;
q = functions.reduce(q2, q);
```

So a metric whose name is a valid PromQL identifier becomes a bare selector prefix; anything else
(leading digit, a `-`, a `.` at the start) is pushed into the braces as a `__name__` matcher. Note
that `.` **is** allowed by the identifier test even though it is not a legal PromQL metric-name
character — `host.name`-style metric names will be emitted bare and will not parse.

Advanced never adds `default 0`, never adds `span_kind`, and never adds a range selector such as
`[5m]` — `rate` renders as `rate(expr)`, which is a VictoriaMetrics extension rather than
Prometheus-legal PromQL.

### Worked examples

Metric only:

```promql
cube_apm_calls_total
```

Metric + `WHERE service equals checkout`:

```promql
cube_apm_calls_total{service="checkout"}
```

Same, plus `rate` then `sum` grouped by `service`:

```promql
sum(rate(cube_apm_calls_total{service="checkout"})) by (service)
```

Same, plus `topk` with `k = 5` grouped by `service`:

```promql
topk(5, sum(rate(cube_apm_calls_total{service="checkout"})) by (service)) by (service)
```

`cube_apm_latency_bucket`, `increase`, `sum` grouped by `service, vmrange`, then
`histogram_quantile` with the default quantile:

```promql
histogram_quantile(0.9, sum(increase(cube_apm_latency_bucket)) by (service, vmrange))
```

Freshly added `clamp` (min seeded to the number `0`, max to `"1"`), then `/` with the default `by`:

```promql
clamp(cube_apm_calls_total, 0, 1) / 1
```

A metric name that fails the identifier test, with one filter:

```promql
{__name__="2xx_total", service="checkout"}
```

### Generated Query

Advanced ends with the same `pvt` panel as Quick: heading `Generated Query` over a read-only `H9`
editor showing the **incoming** `query` prop (not the locally computed string), so it lags by one
render when the parent does not echo the value back.

## Code tab (`rVn`)

Label `"Code"`, key `"code"`. The whole tab is:

```
<h1 class="ctext">Query Editor</h1>
<div class="w-full csthemebg border cborder">  <H9 value={query} readOnly onChange /> </div>
```

There is no Generated Query panel here — the editor *is* the query — and no placeholder text. An
empty editor is an empty box with a caret.

### The editor (`H9`)

A Monaco instance via `@monaco-editor/react`, `language: "promql"`,
`theme: isDark() ? "vs-dark" : "vs"`, `className: "… min-h-[30px]"`, `width: "100%"`. Options,
verbatim:

```js
{
  codeLens: false,
  contextmenu: false,
  fixedOverflowWidgets: true,
  lineNumbers: "off",
  lineDecorationsWidth: 0,
  minimap: { enabled: false },
  overviewRulerLanes: 0,
  padding: { top: 6, bottom: 6 },
  renderLineHighlight: "none",
  scrollBeyondLastLine: false,
  scrollbar: { alwaysConsumeMouseWheel: false },
  readOnly,
}
```

`onMount` installs a single listener: on `onDidContentSizeChange` it sets the container element's
`style.height` to `Math.max(contentHeight, 30)px`, and it sets that once at mount. The editor
therefore has no scrollbar of its own and grows with the query; page scroll is not swallowed
(`alwaysConsumeMouseWheel: false`).

While Monaco's loader is still resolving, `@monaco-editor/react` renders its default placeholder,
the literal string `Loading...`.

The same `H9` is reused read-only for the Generated Query panels in Quick and Advanced, so three
Monaco editors are typically alive at once.

### Highlighting

`beforeMount` registers a language descriptor:

```js
{ id: "promql", extensions: [".promql"],
  aliases: ["Prometheus","prometheus","prom","Prom","promql","Promql","promQL","PromQL"],
  mimetypes: [] }
```

and, on first use of that language, lazily imports a separate chunk (`promql-*.js`) that supplies a
Monarch tokens provider and a language configuration. The configuration's `wordPattern` is
overridden with

```js
/(-?\d*\.\d\w*)|([^`~!#%^&*()\-=+[{\]}'",<>/?\s]+)/g
```

so `_`, `:` and `.` count as word characters and `cube_apm_calls_total` or `service.version` is a
single word for completion purposes. Highlighting is purely lexical: there is no parser and no
diagnostics.

### Autocomplete

Registered on the promql language. `triggerCharacters: ["{", "[", "(", '"', ",", " "]`.

On each request the provider scans the whole model for this delimiter pattern

```
(=\s*["`']|!=\s*["`']|=~\s*["`']|!~\s*["`']|\{|\}|\[|\]|\(|\)|\+|-|\/|\*|%|\^|\band\b|\bor\b|\bunless\b|==|>=|!=|<=|>|<|=|~|,)
```

and takes the **last match ending at or before the cursor**. Two helpers do the lookups: "the word
immediately left of position p, skipping whitespace and line breaks" and "the metric name of the
innermost selector", which is defined as *the word before the last `{` anywhere in the document*.

| Last delimiter before the cursor | Suggestions | Kind | Backing call |
|---|---|---|---|
| `}` `]` `)` | none | — | — |
| `[` | the single literal `5m` | `Value` | — |
| `{` or `,` | label names of the metric before the last `{`; none if no metric word is found | `Property` | `Tw(metric, start, end)` |
| `"` `` ` `` `'` (the quote that opens a matcher value) | label values; suppressed when the text between that quote and the cursor already contains the same quote (cursor is past the closing quote); none if no metric word is found | `Value` | `In(label, metric, start, end)` |
| `(` preceded by the word `by` or `without` | label names; the metric may be empty, in which case every label is offered | `Property` | `Tw(metric \|\| "", start, end)` |
| anything else, or no delimiter at all | the promql chunk's own completions **plus every metric name** | mixed + `Struct` | `In("__name__", "", start, end)` |

The metric-name list is a module-level array refreshed by an effect keyed on the global refresh
token — which the time-range picker bumps — so every mounted `H9`, including the two read-only
Generated Query editors, issues the same `__name__` request on every range change.

Label and value lookups go through a module-level LRU (`lru-cache`, `max: 10`, **no TTL**) shared by
every editor instance. Keys are the selector string for labels and `` `${selector}/${label}` `` for
values. Consequences worth knowing:

- Results are never invalidated when the time range changes — the request captures `start`/`end`
  from a ref at call time, but a cached answer from the previous range is returned unchanged.
- `Tw`/`In` resolve to `[]` on failure, and `[]` is cached, so one failed lookup is permanent for
  that key until the key is evicted.
- There is no in-flight de-duplication and no debounce; two overlapping requests for the same key
  both go out.
- With `max: 10`, a query touching more than ten distinct selector/label pairs thrashes the cache.

### Validation and run keys

There is none. `onValidate` is not wired, no marker provider is registered, and nothing parses the
PromQL before it is sent. The only gate is the page's **Generate Graph** button, which is `disabled`
while the committed query string is empty; a syntactically invalid query is submitted and fails at
the backend, surfacing as the page's error band.

No Monaco commands or keybindings are added, so the editor keeps stock behaviour:

- `Enter` inserts a newline — the editor is multi-line and auto-grows. There is no run-on-Enter and
  no `Ctrl`/`Cmd`+`Enter`.
- `Tab` inserts indentation and is swallowed by the editor; `tabFocusMode` is not enabled, so
  keyboard users cannot `Tab` out of the field.
- `Ctrl`+`Space` opens the suggest widget manually, `Escape` closes it, `Enter`/`Tab` accept.
- The right-click context menu is disabled (`contextmenu: false`); `F1` still opens the command
  palette.

## The tab state machine (`oVn`)

The shell keeps **three independent drafts** plus a record of what it last emitted:

```js
activeKey                      // "quick" | "advanced" | "code"; initial "quick"
quickQuery,    quickModel      // "", undefined
advancedQuery, advancedModel   // "", undefined
codeQuery                      // ""            (the Code tab has no model)
lastQuery,     lastModel       // "", undefined  — what this component last pushed upward
```

Every emission goes through one function:

```js
const emit = (q, m) => { lastQuery = q; lastModel = m; onChange?.(q, m); };
```

### Choosing the opening tab

A single effect on `[query, model]`:

```js
if (query === lastQuery && model === lastModel) return;   // our own echo — ignore
let next = "code";
if (model?.type === "quick" || model?.type === "advanced") next = model.type;
else if (!model && !query) next = "quick";
if (next === "quick")        { quickQuery = query;    quickModel = model; }
else if (next === "advanced"){ advancedQuery = query; advancedModel = model; }
else                         { codeQuery = query; }
activeKey = next;
```

So:

| Incoming | Opens on |
|---|---|
| nothing (no query, no model) | **Quick** |
| a `type: "quick"` model | **Quick**, with the model loaded |
| a `type: "advanced"` model | **Advanced**, with the model loaded |
| a raw query with no model | **Code**, with the query loaded |
| a query *and* a quick/advanced model | that builder tab; the query is handed to the builder, which immediately regenerates it from the model |
| a model of some other type (e.g. a Logs `builder` model) | **Code** |

The echo guard compares by identity, so a parent that clones the model object on every render
re-runs this effect and can snap the user back to another tab mid-edit.

### Switching tabs

```js
onChange: key => {
  if (key === "quick")         emit(quickQuery, quickModel);
  else if (key === "advanced") emit(advancedQuery, advancedModel);
  else if (key === "code")     emit(codeQuery);          // model = undefined
  activeKey = key;
}
```

A tab switch **re-emits that tab's own remembered draft**. Nothing is translated between tabs: the
Quick builder does not seed Code, and Code does not parse back into a builder. Combined with the
echo guard, the practical behaviour is:

- Build a query in Quick, switch to Code → Quick's emission was recorded as `lastQuery`, so the
  effect short-circuited and `codeQuery` was never updated. Code opens **empty** and the switch
  emits `""`, wiping the query the user just built. (See bug R1.)
- Switch back to Quick → Quick's draft is intact and is re-emitted, so the query returns.
- Open a saved panel whose query is raw text → Code is the opening tab with the text loaded;
  switching to Quick emits `""` and discards it.

Each tab is `disabled: readOnly`, so a read-only editor shows three dead tab headers and only the
pane that was opened.

Panes are lazily mounted (antd `Tabs`, `type: "card"`, `removeOnLeave: false`): Quick exists from the
start, Advanced and Code are constructed the first time they are shown and stay mounted afterwards.
That is why Advanced's metric list is not fetched until the tab is first opened.

### Above the tabs — the datasource switch (`Cne`)

`Cne` holds one `(query, model)` pair per datasource and renders all four editors at once, hiding
the inactive ones, so each datasource keeps its own drafts. The radio group:

| Value | Label | Hidden when | Disabled when |
|---|---|---|---|
| `prometheus` | `Metrics` | `mode === "logs_traces"` | `readOnly` |
| `vlogs` | `Logs` | — | `readOnly \|\| mode === "metrics"` |
| `traces` | `Traces` | — | `readOnly \|\| mode === "metrics"` |
| `mobile` | `Mobile` | — | `readOnly \|\| mode === "metrics"` |

Switching datasource emits `(newDatasource, thatDatasource'sQuery, thatDatasource'sModel)`. The
whole group is hidden when `hide` is set.

## Bugs in the reference, and what to do about them

**R1 — a tab switch silently destroys the query.** `oVn` records what it emitted and then ignores
the echo, so the tab the user switches *to* never learns the current query; switching emits that
tab's stale (usually empty) draft. Quick → Code loses everything the user built.
*Recommendation:* carry the query forward on every switch — into Code always, and into a builder tab
only when the incoming model matches that tab. A tab that cannot represent the current query should
be visibly marked rather than silently resetting it.

**R2 — Quick narrows its value lookups against the wrong metric.** The filter rows are always
narrowed by `__name__="cube_apm_calls_total"`, even when the calculation reads
`cube_apm_latency_bucket`. *Recommendation:* derive the base matcher from the chosen calculation.

**R3 — `readOnly` disables the tabs themselves.** An antd tab with `disabled: true` cannot be
clicked, so a read-only editor (the alert preview) cannot be navigated at all; the viewer sees only
the pane the state machine opened. *Recommendation:* keep the panes read-only but leave the tab
headers clickable.

**R4 — `p99.9` generates a float artifact.** `${parseFloat("99.9") / 100}` is
`0.9990000000000001`, which is what lands in the query. `99.99` → `0.9998999999999999`.
*Recommendation:* format the quantile with a fixed precision, e.g. `(p / 100).toFixed(6)` with
trailing zeros stripped.

**R5 — clearing a filter row's label issues a bad request.** The value dropdown's open handler
guards with `if (!open || row.label === "") return;`, but `allowClear` sets the label to `undefined`,
not `""`. Opening that row's value dropdown then POSTs to
`/api/metrics/api/v1/label/undefined/values`. *Recommendation:* guard on falsiness.

**R6 — duplicate React keys on filter rows.** The key is `` `${row.label}-${i}` ``; two rows on the
same label (`service = a` AND `service != b`, a normal thing to write) collide. Using the index
alone would be both simpler and correct here, since rows are addressed positionally everywhere else.

**R7 — the metric-name identifier test admits `.`, which ties the output to MetricsQL.**
`/^[a-zA-Z][a-zA-Z0-9_:.]*$/` lets `http.server.duration` through as a bare selector prefix. That is
legal in MetricsQL (which CubeAPM's metrics API speaks — see also `default 0` and the missing range
windows) but not in Prometheus. *Recommendation:* leave the regex alone and record the dependency;
it is a deliberate MetricsQL affordance, not an oversight.

**R8 — no loading, empty or error states anywhere.** Metadata failures become a toast and an empty
dropdown that is indistinguishable from "no values in this range", and an empty result is cached in
the editor's LRU forever. *Recommendation:* track a per-field loading flag, distinguish "failed"
from "empty" in the dropdown, and give the cache a TTL keyed on the time range.

**R9 — the autocomplete's "current metric" is the last `{` in the document, not the nearest one to
the left of the cursor.** Editing the first selector of `a{…} / b{…}` offers `b`'s labels.
*Recommendation:* restrict the search to matches before the cursor.

**R10 — the operation picker's empty-state value is the literal `"* "`.** It renders as stray text
in the closed control. *Recommendation:* use a real `placeholder` instead.

**R11 — `Tab` is a keyboard trap in the Code editor,** and there is no keyboard way to run a query.
*Recommendation:* enable `tabFocusMode` (or bind `Esc` then `Tab`) and add `Ctrl`/`Cmd`+`Enter` as a
run key.

## Divergences from our implementation

Checked line for line against `src/utils/explore/builders.js` and `src/utils/explore/catalogs.js`
(66 passing tests in `builders.test.js`, which were written against an **older** build of this
bundle).

**Nothing in the generated PromQL has changed, and no option list has changed.** The following all
match the new build exactly, string for string:

- `METRIC_DOCS`, `LABEL_DOCS`, `FUNCTION_DOCS` — every key and every sentence.
- `ADVANCED_OPERATIONS` — 21 operations in five groups, in picker order, with the same arg shapes,
  the same string defaults, the same two args with no default, and the same `position: 'before'` on
  `topk.k` and `histogram_quantile.quantile`.
- `QUICK_LABELS` — the same seven labels in the same order, with `http_code` and `exception` flagged
  `isSpecial`.
- `MATCH_OPERATORS` — `=`/`equals`, `!=`/`not equals`, `=~`/`in`, `!~`/`not in`.
- `quoteString` ≡ `me`, `quoteAlternation` ≡ `Qk` (same `REGEX_META` class, same double escaping),
  `labelMatcher` ≡ `mvt`, `applyOperation` ≡ `q2`, `newOperation` ≡ the picker's `onChange`,
  `parsePercentile` ≡ `yh` (same regex, still no bounds).
- `buildQuickQuery` for all four calculations, including the `status_code="ERROR"` placement, the
  special-label split in the Error % denominator, the `ignoring (a,b) group_left` spelling with no
  space after the comma, `vmrange` appended to the percentile grouping, the `* 60` / `* 100` / `* 1000`
  placement, and the `99.9 → 0.9990000000000001` float artifact.
- `buildAdvancedQuery`, `BARE_METRIC` ≡ `nVn`, and both `*MatchFor` narrowing helpers.

The disagreements are these.

**1. Identifiers in our comments are from the old build.** Our source cites `FWn`, `qpt`, `lce`,
`BWn`, `Kje`, `Gpt`, `V2`, `bh`, `qN`. In this build they are `Qzn`, `fvt`, `vce`, `Yzn`,
(logs chunk), `mvt`, `q2`, `yh`, `Qk`. The comments are otherwise still accurate. Worth a pass so the
next person can re-find them.

**2. Our models drop `options`; the reference's carry it.** `emptyPair()` returns
`{label, operator, values}`, but the reference's blank row is
`{label: "", operator: "=", values: [], options: []}` and it emits `labelPairs` **with the fetched
option lists still attached** — so a saved panel or alert built in the playground embeds stale value
lists in its model. Ours is the better shape, but any loader we write must tolerate and strip an
incoming `options` key, exactly as the reference does on the way in
(`labelPairs.map(p => ({...p, options: []}))`).

**3. `QUICK_CALCULATE` has no `(millis)` variant, although `buildQuickQuery` has `latencyInMs`.**
The reference labels the two latency options `%ile Latency (millis)` / `Avg Latency (millis)`
whenever `quickLatencyInMs` is set. Explore never sets it, so for Explore we agree; but the generator
supports the flag while the catalog does not, which will bite if this editor is ever reused for
alerts. Either drop the generator option or add the labels.

**4. Deliberate hardening where the reference throws.** Four places, all already commented:
`buildQuickQuery` returns `''` for an unknown `calculate` (reference: `throw new Error("unhandled
calculate value …")`); it defaults a missing `model.value` to `'90'` (reference: `i.value.toString()`
throws while loading such a model); `buildAdvancedQuery` catches an unknown arg type and returns `''`
(reference: throws); and `applyOperation` falls back to `arg.default ?? 0` / `[]` for an arg with no
`value` (reference reads `o.value` straight and `o.value.join` throws for an aggregation). None of
these change the output for a model the picker produced.

**5. `defaultQuickModel()` preselects `rpm` grouped by `service`.** The reference opens with
`calculate` **undefined** and generates nothing until the user picks one. This is our CLAUDE.md
rule 5 departure and is already documented in `ARCH.md` D2.

**6. `quickMatchFor` / `advancedMatchFor` return a one-element array.** The reference passes the
selector as a bare string into `match[]`. Cosmetic — the endpoint takes either — but the shape
differs if anything compares them.

**7. We reproduce the `p99.9` float artifact on purpose.** Bug R4 above recommends fixing it;
`builders.test.js` currently pins `0.9990000000000001`. Fixing it is a deliberate divergence from the
reference and needs that test updated, not a silent change.

### Present in the reference, not yet encoded in either file

These are component-level behaviours with no home in `builders.js`/`catalogs.js` yet. Listed so the
editor work does not have to re-derive them:

- The Advanced **Show all** filter predicate, `name.startsWith("cube_apm_")`, and the fact that the
  checkbox lives inside the `FROM` heading and does not clear the current selection.
- Quick's GROUP BY picker shows **no** descriptions, while its WHERE label picker does — the same
  `LABEL_DOCS` map is used in one place and not the other.
- Advanced's `aggregation` arg control is **hidden entirely** until a metric is chosen.
- The operation picker's empty-state value `"* "`, and its `value: ""` once any operation exists.
- Search in every one of these dropdowns matches on the option's **value**, never on its description;
  in the grouped operation picker it also matches the group header (`Aggregation`, `Rounding`,
  `Range`, `Histogram`, `Operators`).
- The whole Code-tab story: trigger characters, the five completion contexts, the `5m` suggestion
  after `[`, the shared `max: 10` LRU with no TTL, and the absence of validation and of any run key.
  Our `src/utils/explore/promql/` has a lexer, parser and evaluator but no completion module; the
  reference's PromQL keyword list lives in a lazily loaded `promql-*.js` chunk that is **not present
  in this bundle**, so the claim in `catalogs.js` that its list is wrong could not be re-verified
  here.
- The tab state machine's opening-tab rule and its destructive tab switch (bug R1) — nothing in our
  two files models tab state yet.
