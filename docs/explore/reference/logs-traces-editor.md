# Reference — the Logs and Traces query editor

Derived by reading the playground's production bundle (`app.pretty.js`, pretty-printed). Everything
below is what the reference build does, not what we should do; the recommendation column of
[Reference bugs](#10-reference-bugs-and-recommendations) and the closing
[Divergences](#divergences-from-our-implementation) section are where judgement is applied.
Where this note and [ARCH.md](../ARCH.md) disagree, ARCH.md wins.

Minified names are kept in parentheses the first time a thing is named, so the bundle can be
re-read against this note.

## 1. Scope and entry points

The Explore page mounts one datasource switcher (`Cne`) holding four bodies. The switcher is an
antd `Radio.Group` of `Radio.Button`s:

| value | label | disabled when |
|---|---|---|
| `prometheus` | `Metrics` | `readOnly`; hidden entirely when `mode === "logs_traces"` |
| `vlogs` | `Logs` | `readOnly`, or `mode === "metrics"` |
| `traces` | `Traces` | `readOnly`, or `mode === "metrics"` |
| `mobile` | `Mobile` | `readOnly`, or `mode === "metrics"` |

Metrics gets its own editor (`oVn`, Quick/Advanced/Code). **Logs, Traces and Mobile all render the
same component** (`pce`), differing only in the `datasource` prop. The switcher keeps a separate
`(query, model)` pair in state per datasource and only ever hides the inactive bodies (`hide` →
returns `null`), so each editor keeps its React state across datasource switches.

### Where Logs and Traces actually differ

Only two things, and both are consequences of the `datasource` string:

1. **API prefix.** Every call goes to `/api/${ds === "vlogs" ? "logs" : ds}/select/logsql/<endpoint>`,
   so Logs hits `/api/logs/select/logsql/…` and Traces hits `/api/traces/select/logsql/…`. Identical
   endpoint names, identical payloads.
2. **Which field catalogue the pickers and the autocomplete read.** Same endpoint names
   (`stream_field_names`, `stream_field_values`, `field_names`, `field_values`), different prefix,
   therefore different vocabularies — `service`/`log.level`/`_msg` for logs, span attributes for
   traces.

There is no third difference. No operator, pipe, function, label, placeholder or keybinding varies
between the two.

## 2. Component map

| Minified | Role |
|---|---|
| `pce` | the Builder/Code shell — antd `Tabs` (`c_`), `type: "card"` |
| `Gzn` | Builder body: STREAM rows, FIELDS rows, PIPES, generated query |
| `lze` | one pair-row section, rendered twice (STREAM and FIELDS) |
| `Kzn` | Code body: `Query Editor` heading + editor |
| `Uzn` | read-only `Generated Query` block at the foot of the Builder |
| `B9` | Monaco wrapper, `language: "logsql"` |
| `mce` | stream-selector serializer |
| `aze` | field-filter serializer |
| `qzn` | pipe serializer |

antd aliases used below: `vt` = `Select`, `en` = `Input`, `Qe` = `Button`, `hn` = `Radio`,
`c_` = `Tabs`. `sn` is the axios instance. `yp` is the × glyph used as the pipe-card close control.

## 3. The Builder/Code shell

`pce({ datasource, query, model, readOnly, onChange, hide })` renders an antd card `Tabs` with
exactly two items:

| key | label | children | `disabled` |
|---|---|---|---|
| `builder` | `Builder` | `Gzn` | `readOnly` |
| `code` | `Code` | `Kzn` | `readOnly` |

`hide` short-circuits to `null` before the `Tabs` render. There is no third tab, no overflow menu,
no close affordance.

### State

```js
const [tab,         setTab]        = useState("builder");
const [builderQ,    setBuilderQ]   = useState("");   // the Builder tab's own query text
const [builderModel,setBuilderModel]= useState();    // the Builder tab's own model
const [codeQ,       setCodeQ]      = useState("");   // the Code tab's own query text
const [lastModel,   setLastModel]  = useState();     // last value this component emitted
const [lastQuery,   setLastQuery]  = useState("");   // ditto
```

`emit(q, m)` sets `lastQuery`/`lastModel` and then calls `onChange?.(q, m)`. The `lastQuery`/
`lastModel` pair exists purely so the component can recognise its own value coming back down as a
prop and ignore it.

### Incoming props → tab routing

```js
useEffect(() => {
  if (query === lastQuery && model === lastModel) return;   // our own echo, ignore
  let next = "code";
  if (model?.type === "builder") next = model.type;
  else if (!model && !query) next = "builder";
  if (next === "builder") { setBuilderQ(query); setBuilderModel(model); }
  else setCodeQ(query);
  setTab(next);
}, [query, model]);
```

So an externally supplied query lands on **Code** unless it arrives with a `{ type: "builder" }`
model, and an empty, model-less payload lands on **Builder**. Only the destination tab's state is
written; the other tab keeps whatever it had.

### Tab switch

```js
onChange: (key) => {
  if (key === "builder") emit(builderQ, builderModel);
  else if (key === "code") emit(codeQ);          // note: no model argument
  else throw new Error(`unhandled tab ${key}`);
  setTab(key);
}
```

**This is the whole carry-over story, and it is almost certainly not what a user expects.** Each tab
owns its own query string. Switching tabs re-emits *that tab's* stored query, discarding the other
tab's. Concretely:

- Build `{"service"="api"}` in Builder, click **Code** → the page's committed query becomes `""`
  (the Code tab's untouched initial state) and the editor is blank. The built query is not seeded
  into Code.
- Type `_msg:"timeout"` in Code, click **Builder** → the committed query reverts to the Builder's
  last query. The typed text is not parsed into rows; it survives only in `codeQ`, so switching back
  to **Code** restores it verbatim.
- Switching to Code emits `emit(codeQ)` with `model` undefined, so the committed model is cleared.

Round-tripping is therefore lossless *per tab* and lossy *across* tabs. There is no parser from
LogsQL text back into builder rows anywhere in the bundle.

## 4. The Builder model

The model the Builder emits, and the only shape it will hydrate from:

```js
{
  type: "builder",
  streamPairs: Pair[],     // STREAM rows
  labelPairs:  Pair[],     // FIELDS rows  (note the name: "label", not "field")
  pipes:       Pipe[]
}

// Pair — module constant P1e is the blank row
{ label: "", operator: "=", values: [], options: [] }

// Pipe — the two entries of the "add pipe" catalogue (Mdn)
{ value: "stats", by: [], aggs: [ { fn: "count", args: [""], filter: "", alias: "" } ] }
{ value: "math",  expr: "", alias: "" }
```

`options` is the row's last-fetched value list. It is carried *out* in the emitted model and
stripped (`options: []`) on the way back *in*, so it never survives a hydration.

Builder state (`Gzn`):

```js
const [refresh, start, end] = fn();       // see §9 — start/end are step-aligned unix seconds
const [loaded,       setLoaded]       = useState(false);
const [streamLabels, setStreamLabels] = useState([]);   // STREAM field-picker options
const [streamPairs,  setStreamPairs]  = useState([P1e]);
const [fieldNames,   setFieldNames]   = useState([]);   // FIELDS field-picker options
const [fieldPairs,   setFieldPairs]   = useState([P1e]);
const [pipes,        setPipes]        = useState([]);
```

Three effects:

1. `[model]` — sets `loaded = true` unconditionally; if `model?.type === "builder"`, replaces all
   three arrays from it, blanking each pair's `options`.
2. `[refresh]` — clears and refetches both catalogues:
   `stream_field_names` → `streamLabels`; `field_names` → `fieldNames`, **filtered to drop every
   name starting with `_`**. The dep is the `refresh` URL parameter, not the time range and not the
   env (see [bug R4](#10-reference-bugs-and-recommendations)).
3. `[streamPairs, fieldPairs, pipes]` — serialises (§6) and, if the result differs from the `query`
   prop, calls `onChange(query, model)`. Guarded by `loaded`.

The `_` filter applies to `field_names` only. STREAM's picker shows everything the server returns,
including underscore-prefixed stream fields.

## 5. STREAM and FIELDS rows

Both sections are the same component (`lze`) with a different `sectionLabel`, a different field
catalogue and a different `fetchValues`. Rows are `flex items-end space-x-4 mb-4`; there is always
at least one row and it cannot be removed.

Per row, left to right:

| # | Control | Props | Behaviour |
|---|---|---|---|
| 1 | heading | — | row 0 shows the section label, `STREAM` or `FIELDS`; every later row shows `AND` |
| 2 | field `Select` | `width: 280px`, `showSearch`, `allowClear` | options are the catalogue as `{ value }` only (no separate label, so the raw name is the visible text). On change: sets `label` and **resets `values: []` and `options: []`** |
| 3 | operator `Select` | `minWidth: 160px` | four options, below. On change: sets `operator`; if the new operator does not end with `~` and `values` is non-empty, truncates to `[values[0]]` |
| 4 | value `Select` | `minWidth: 280px`, `showSearch`, `mode: "multiple"` iff the operator ends with `~` | value is always the `values` array; on change `typeof v === "string" ? [v] : v`. Options are `pair.options` as `{ value }` |
| 5 | `Remove` | antd `Button danger` | rendered only when `!readOnly && pairs.length > 1`; splices this row out |
| 6 | `Add more` | antd `Button type="primary"` | rendered only when `!readOnly && index === pairs.length - 1`; appends a blank pair |

Operator options, value and visible label verbatim:

| value | label |
|---|---|
| `=` | `equals` |
| `!=` | `not equals` |
| `=~` | `in` |
| `!~` | `not in` |

`readOnly` disables all three selects and hides both buttons. The React key is
`` `${pair.label}-${index}` ``, so renaming a row's field remounts that row.

### How value options are fetched

The value `Select` has no `onSearch` and no `loading` state. Options are fetched once per *open*,
through `onOpenChange(open)`:

```js
if (!open || pair.label === "") return;
fetchValues(pair.label, pairs.slice(0, index)).then(opts => setPairs(pairs.with(index, { ...pair, options: opts })));
```

Three consequences: the first open of a dropdown shows an empty list until the request lands (no
spinner, no "loading" text); narrowing is **prefix-only** — row *n*'s options are constrained by
rows `0…n-1` and by nothing after it; and the typed search term never reaches the server, so the
list is whatever the server returned, filtered client-side.

| Section | `fetchValues` | Endpoint | `query` sent |
|---|---|---|---|
| STREAM | `Pcn(label, mce(preceding), start, end, ds)` | `stream_field_values` | the `{…}` selector built from the preceding STREAM rows, or `*` when empty |
| FIELDS | `In(label, "<stream selector> <preceding field filters>", start, end, ds)` | `field_values` | the full STREAM selector plus every preceding FIELDS row, space-joined |

Both POST `application/x-www-form-urlencoded` to
`/api/<logs|traces>/select/logsql/<endpoint>` with `{ start, end, query, field }`. `query` is
replaced by `*` only when it is the empty string.

The response is `data.values`, an array of `{ value, hits }`. The builder path (`Y8`) maps it to
`.value` and `.sort()` — plain lexicographic, hit counts discarded. Only the Code autocomplete
keeps `hits`.

### Failure, empty and loading states

There are none, beyond a toast. Every fetch helper catches, calls `Bt.error(...)` and returns `[]`:

- `Failed to fetch stream fields (<query>): <err>`
- `Failed to fetch labels (<query>): <err>`
- `Failed to fetch stream field values (<field> <query>): <err>`
- `Failed to fetch label values (<field> <query>): <err>`

where `<err>` is `e.response?.data?.error || e`. The dropdown simply renders empty. There is no
retry, no inline error, no skeleton and no "no results" copy of the reference's own.

## 6. PIPES

Heading: `PIPES (docs ↗)` — the word `docs` plus an external-link glyph (`lc`) is an anchor to
`https://docs.cubeapm.com/logs/querying?utm_source=cubeapm&utm_medium=in-app&utm_campaign=logs-explorer`
(`Q2("/logs/querying", "logs-explorer")`), `target="_blank" rel="noreferrer"`. The same link is
shown on the Traces datasource.

Pipes live in a `flex items-start gap-2 flex-wrap` row: each pipe is a bordered card, and the last
item in the row is the "add pipe" `Select`.

### Pipe card chrome

Header row (`p-2 … border-b`): a `<span>` holding the pipe's `value` verbatim — the visible title is
literally `stats` or `math` — and a 12px × glyph (`yp`) with `cursor-pointer`. Clicking it runs
`readOnly || setPipes(pipes.toSpliced(index, 1))`. The glyph carries **no `title`, no `aria-label`
and no disabled styling**; in `readOnly` it still looks and behaves like a button, it just does
nothing.

### Adding, reordering, removing

- **Add** — the trailing `Select`: `showSearch`, `width: "280px"`, `disabled: readOnly`,
  `value: ""` (hard-coded, so it is permanently blank and never shows the last choice), **no
  placeholder**. `options` is the catalogue `Mdn` itself; because neither entry carries a `label`
  key, the dropdown shows the raw values `stats` and `math`. `onChange: (value, option) =>
  setPipes([...pipes, option])` appends the catalogue object **by reference**, not a clone.
- **Reorder** — not possible. There is no drag handle and no up/down control. Pipes serialise in
  array order, and new pipes always go on the end.
- **Remove** — the × in the card header only.

### The `stats` card

| Field | Control | Options / defaults |
|---|---|---|
| `group by` | `Select`, `mode: "multiple"`, `showSearch`, `minWidth: 180` | the `_`-filtered `field_names` catalogue; bound to `pipe.by` |
| `function` | `Select`, `minWidth: 140` | the nine entries of `u6e`, below. On change the args array is **reset** to `signature.args.map(a => a.default ?? "")` |
| *(per-arg)* | `Select` (`minWidth: 140`, `showSearch`, `allowClear`) when the arg is `type: "field"`; otherwise `Input type="number"`, `width: 80` | field args read the `_`-filtered `field_names` catalogue; number args fall back to `arg.default` for display |
| `if` | a **nested Monaco LogsQL editor** (`B9`) in a `min-w-96` box | bound to `agg.filter`; same datasource mapping as the Code tab; `onSubmit` is a no-op |
| `as` | `Input`, `minWidth: 180` | bound to `agg.alias` |

Each function row ends with `Remove` (danger, shown when `!readOnly && aggs.length > 1`) and
`Add function` (primary, shown on the last row only), which appends a fresh
`{ fn: "count", args: [""], filter: "", alias: "" }`.

The heading above each arg control is the arg's `label`, so a `quantile` row reads
`function | quantile | field | if | as`.

Stats function catalogue (`u6e`), in dropdown order. None of these carries a `label`, a `detail` or
a group, so the dropdown is a flat list of bare identifiers:

| value | args |
|---|---|
| `avg` | `field` (field picker) |
| `count` | `field` |
| `count_empty` | `field` |
| `count_uniq` | `field` |
| `max` | `field` |
| `median` | `field` |
| `min` | `field` |
| `quantile` | `quantile` (number, default `"0.9"`), then `field` |
| `sum` | `field` |

### The `math` card

| Field | Control | Notes |
|---|---|---|
| `expression` | `Input`, `minWidth: 360`, placeholder `e.g. errors / requests * 100` | bound to `pipe.expr`; free text, never validated |
| `as` | `Input`, `minWidth: 360` | bound to `pipe.alias` |

### Generated query

Below the pipes, `Uzn` renders `<h1>Generated Query</h1>` over a read-only `B9` editor holding the
assembled query. Its `datasource` prop is **hard-coded to `"logs"`**, so on the Traces datasource
this preview registers its Monaco model under the wrong catalogue (harmless in practice only
because the editor is read-only).

## 7. The emitted LogsQL

### Quoting primitives

```js
me(s)  = '"' + s.replace(/[\\"]/g, "\\$&") + '"'                 // quote, escaping \ and "
Qk(vs) = me(vs.map(v => v.replace(/[.*+?^${}()|[\]\\"'<>-]/g, "\\$&")).join("|"))
```

`Qk` regex-escapes each value, joins with `|`, then quotes the whole thing — so a value containing
a regex metacharacter comes out double-escaped in the source text (`api-gw` → `"api\\-gw"`), which
decodes back to the regex `api\-gw`. That layering is correct, not a bug, but it is surprising to
read in the preview.

### Stream selector (`mce`)

Rows with an empty `label` are dropped. Each surviving row becomes
`` `${me(label)}${operator}${operator.endsWith("~") ? Qk(values) : me(values[0] || "")}` ``, joined
with `,`, wrapped in `{…}`. An all-empty section yields `""`, not `{}`.

| operator | emits |
|---|---|
| `=` | `"service"="api-gateway"` — only `values[0]`, `""` when unset |
| `!=` | `"service"!="api-gateway"` |
| `=~` | `"service"=~"api\|web"` |
| `!~` | `"service"!~"api\|web"` |

### Field filter (`aze`)

```js
const negated = operator.startsWith("!");
let op = operator.slice(negated ? 1 : 0);
if (op.endsWith("~")) op = "in";
return `${negated ? "NOT " : ""}${label}:${op}${op === "in" ? `(${values.map(me).join(",")})` : me(values[0] || "")}`;
```

| operator | emits |
|---|---|
| `=` | `level:="error"` |
| `!=` | `NOT level:="error"` |
| `=~` | `level:in("error","warn")` |
| `!~` | `NOT level:in("error","warn")` |

Two things to note. The **field name is not quoted here** (unlike `by (…)` in the stats pipe, and
unlike the stream selector). And `=` always maps to LogsQL's exact-match `:=`, never to the
word-match `:` — the builder cannot express a word or phrase match at all.

### Pipes (`qzn`)

```
stats:  `| stats` + (by.length ? ` by (${by.map(me).join(", ")})` : "") + " " + aggs.join(", ")
  agg:  `${fn}(${args.join(", ")})` + (filter ? ` if (${filter})` : "") + (alias ? ` as ${me(alias)}` : "")
math:   expr ? `| math ${expr}` + (alias ? ` as ${me(alias)}` : "") : ""
```

`by` names are quoted; **agg args are joined raw and never quoted**, so a field chosen from the
picker emits `count(log.level)`, not `count("log.level")`. A blank field arg emits `count()`; a
blank `quantile` field emits `quantile(0.9, )` — note the dangling separator. A `math` pipe with an
empty expression serialises to the empty string but still counts as a pipe for assembly.

### Assembly

```js
const parts = [];
if (streamSelector) parts.push(streamSelector);
parts.push(...fieldFilters);          // rows with a label, in order
let q = parts.join(" ");
if (pipeStrings.length) { if (!q) q = "*"; q += " " + pipeStrings.join(" "); }
```

Filters are joined by a bare space — implicit AND. No `and`/`or` connector is ever emitted and
there is no way to express OR in the Builder. Grouping is impossible. The `*` fallback is applied
only when there is at least one pipe *object*, regardless of whether it serialised to anything.

### Worked examples

| Builder state | Emitted query |
|---|---|
| nothing set | `` (empty string) |
| STREAM `service equals api-gateway` | `{"service"="api-gateway"}` |
| STREAM `service in [api, web]` | `{"service"=~"api\|web"}` |
| STREAM `service in [api-gw, web]` | `{"service"=~"api\\-gw\|web"}` |
| STREAM `service = api`, AND `env = prod` | `{"service"="api","env"="prod"}` |
| FIELDS `level equals error` only | `level:="error"` |
| FIELDS `level not equals error` | `NOT level:="error"` |
| FIELDS `level not in [error, warn]` | `NOT level:in("error","warn")` |
| STREAM `service = api` + FIELDS `level = error`, AND `status != ok` | `{"service"="api"} level:="error" NOT status:="ok"` |
| no filters, one default `stats` pipe | `* \| stats count()` |
| no filters, `stats` grouped by `service`, `log.level` | `* \| stats by ("service", "log.level") count()` |
| `stats` with `count` → alias `errors`, and `avg(duration)` → alias `p_avg` | `* \| stats count() as "errors", avg(duration) as "p_avg"` |
| `stats`, `count`, `if` = `level:="error"`, alias `errors` | `* \| stats count() if (level:="error") as "errors"` |
| `stats`, `quantile` 0.95 of `duration`, alias `p95` | `* \| stats quantile(0.95, duration) as "p95"` |
| STREAM `service = api` + the default `stats` pipe | `{"service"="api"} \| stats count()` |
| `stats count() as "c"` then `math` `c * 2` alias `double` | `* \| stats count() as "c" \| math c * 2 as "double"` |
| a single `math` pipe with an empty expression | `* ` — the `*` fallback plus a trailing space |

## 8. The Code tab

`Kzn` is thin: an `<h1 class="ctext">Query Editor</h1>` over a bordered box containing one `B9`
editor with `datasource: ds === "vlogs" ? "logs" : ds`, the query, `onChange`, `readOnly`, and
`onSubmit: () => {}`.

### The editor (`B9`)

`@monaco-editor/react` (`Kk`), `language: "logsql"`, `theme: isDark ? "vs-dark" : "vs"`,
`className: "… min-h-[30px]"`. Options, verbatim:

```js
{ codeLens: false, contextmenu: false, fixedOverflowWidgets: true, lineNumbers: "off",
  lineDecorationsWidth: 0, minimap: { enabled: false }, overviewRulerLanes: 0,
  padding: { top: 6, bottom: 6 }, renderLineHighlight: "none", scrollBeyondLastLine: false,
  scrollbar: { alwaysConsumeMouseWheel: false }, readOnly }
```

`Vzn` makes it auto-grow: on every content-size change the container height is set to
`max(contentHeight, 30)px`. There are no line numbers, no minimap, no context menu.

`beforeMount` registers the language once (`jzn`): id `logsql`, extensions `[".logsql"]`, aliases
`["logsql", "Logsql", "logsQL", "LogsQL"]`, then lazily imports the grammar chunk
(`logsql-*.js`, a separate bundle not present in `app.pretty.js`) and installs its Monarch tokens
provider, its language configuration and the completion provider below. **The highlighting rules
and the static keyword/function lists therefore cannot be read from this bundle** — only how they
are filtered, which is documented below.

`onMount` registers the model URI in a module-level `Map` (`R1e`) against a live ref of
`{ datasource, env, stream, start, end }`, which is how the completion provider later recovers its
context. The entry is deleted on unmount.

### What Explore does *not* turn on

`B9` takes `searchSurface`, `paintChips` and `onProblemChange`. **The Explore editors pass none of
them** — not the Code tab, not the generated-query preview, not the `if` filter inside a stats
function. So in Explore there is:

- **no syntax validation.** The 400 ms debounced server probe, the error-string parser and the
  `logsql-syntax` Monaco markers only run under `searchSurface`. A malformed query surfaces only
  when the request fails.
- **no query chips.** The coloured `filter` / `freetext` / `group` / `stream` decorations and their
  clickable `×` removers only run under `searchSurface && paintChips`.
- **no auto-opened suggest widget.** The focus/click handler that fires
  `editor.action.triggerSuggest` when the buffer is empty or `*` only runs under `searchSurface`.

### Keyboard

Registered unconditionally by `Fzn`:

| Keys | Effect |
|---|---|
| `Enter` | runs the editor action `run-query`, which calls the current `onSubmit` |
| `Cmd/Ctrl+Enter`, `Shift+Enter`, `Alt+Enter`, `WinCtrl+Enter` | insert a newline at the cursor and move to the start of the next line |

Because Explore passes `onSubmit: () => {}`, **`Enter` in the Explore editor does nothing at all** —
it neither runs a query nor inserts a newline. The only way to get a second line is a modifier.

### Autocomplete

Trigger characters: `|`, `{`, `[`, `(`, `"`, `,`, space, `:`, `=`, `~`, `!`.

The provider reads the model's context from `R1e`; with no entry it returns nothing. It then takes
`getWordUntilPosition` as the replacement range, asks the grammar module for its static suggestions,
and finds the **last** match before the cursor of

```
(:\s*"|:?=\s*"|:?!=\s*"|:?=~\s*"|:?!~\s*"|\(|\)|\+|-|\band\b|\bor\b|\bunless\b|==|>=|!=|<=|>|<|=|~|:|,|\||stats)
```

Dispatch on that match:

| Match | Suggestions offered |
|---|---|
| `\|` | only the grammar's **Keyword**-kind items — the pipe names |
| `stats` | only the grammar's **Method**-kind items — the stats functions |
| `(` or `,` | **field names**, kind `Property` |
| ends with `"`, `'`, `` ` `` or `:`, and that character does not reappear between the match and the cursor | **values of the field** found by walking backwards from the match start (`Pzn`), kind `Value` |
| anything else, or no match | operator snippets + recent searches + field names + the grammar's **Function**-kind items, in that order |

**Field names** (`oze`): `POST field_names` with `query = "{" + sc(env, stream) + "}"` over the raw
time bounds, sorted `localeCompare`, `detail` = `"<hits> logs"` when the server reports hits. Cached
in a 10-entry LRU keyed `${datasource}/${sc(env, stream)}`, and only when non-empty.

**Field values** (`Ozn`): `POST field_values` with the same selector plus `field`. **Server order is
preserved** — `sortText` is `"2" + zero-padded index` — so values come back most-frequent-first,
each with the same `"<hits> logs"` detail. Cached under `${datasource}/${sc}/${field}`.

`sc(env, stream)` composes the selector from the `stream` URL parameter (a JSON object of field →
values) with `env` forced to the current env; keys are sorted, a single value emits `"k"="v"` and
several emit `"k"=~"a|b"` over the sorted values.

**Operator snippets** (`Mzn`) — offered only when the word under the cursor is *exactly* one of the
fetched field names. Inserted at a zero-width range at the cursor as snippets, sorted `000`–`009`
(i.e. above everything else), each re-triggering the suggest widget:

| label | detail | insert |
|---|---|---|
| `:` | `word match` | `:$0` |
| `:=` | `exact match` | `:=$0` |
| `!=` | `not equal` | `!=$0` |
| `:"..."` | `phrase match` | `:"$0"` |
| `:~"..."` | `regex match` | `:~"$0"` |
| `!~"..."` | `regex negation` | `!~"$0"` |
| `:*` | `exists (any non-empty)` | `:*` |
| `:in(...)` | `any of these values` | `:in($0)` |
| `:>` | `greater than` | `:>$0` |
| `:<` | `less than` | `:<$0` |

**Recent searches** (`Azn`) — only when the whole buffer trims to `""` or `"*"`. Reads
`localStorage["recent-searches-<logs|traces>"]`, keeps the entries matching the current env, takes
the first three, kind `Snippet`, detail `recent search`, replacing the entire model, sorted
`100`–`102`. Explore **reads** this store but never writes it; only the standalone search surface
appends to it (capped at 10 entries).

## 9. Time range and request plumbing

`fn()` returns `[refreshParam, ...Nf.get(timeParam, minStep)]`, and `Nf.get` returns
`[alignedStart, alignedEnd, step, rawStart, rawEnd]` — unix **seconds**, where the aligned pair is
floored to a multiple of the computed step (adjusted by the UTC offset) and the step is derived from
the window length (15 s under 30 min, rising to 900 s at a day or more).

- The **Builder** destructures `[refresh, start, end]` → the **step-aligned** bounds.
- The **editor** destructures `[refresh, , , , start, end]` → the **raw** bounds.

So the two halves of the same page ask the same endpoints about slightly different windows.

Every request is `POST`, `Content-Type: application/x-www-form-urlencoded`, to
`/api/<logs|traces>/select/logsql/<endpoint>` with a body of `{ start, end, query, field? }`, and
reads `data.values`. The endpoints used by this editor are `stream_field_names`,
`stream_field_values`, `field_names` and `field_values`. `query` is replaced by `*` when it is the
empty string.

## 10. Reference bugs and recommendations

| # | What goes wrong | Recommendation |
|---|---|---|
| R1 | **Switching Builder → Code discards the built query.** The tab handler emits the destination tab's own stored query, and the Builder's output was never copied into it. A user who builds a query and clicks Code gets a blank editor and an empty committed query. | Seed the Code buffer from the query you are leaving while Code is untouched, and say so inline. ARCH D3. |
| R2 | **Every Builder edit wipes the fetched value options.** The emitted model carries each row's `options`; the parent echoes the model back; the hydrate effect strips `options` to `[]`. The dropdown a user just used empties behind them and refetches on the next open. | Keep fetched options out of the model entirely, in a cache keyed by field name. |
| R3 | **Empty pipes still join.** `pipes.map(serialise)` is not filtered before `.length` is tested or before `.join(" ")`, so one empty `math` card emits `"* "` and a `stats` + empty `math` pair emits a trailing space. The query text changes, so it is committed and re-run. | Filter empty strings out before both the test and the join. |
| R4 | **Catalogues refetch on the wrong signal.** The effect that loads `stream_field_names` and `field_names` depends on the `refresh` URL parameter. Change the time range and both pickers keep yesterday's fields; change the env and the same. | Depend on the committed range and env. |
| R5 | **The first FIELDS row can never fetch values.** Its narrowing query is built by a template that always inserts a space, so with no STREAM rows it sends `" "` — one space, which is truthy, so the `*` fallback never fires and the server rejects it. | Trim before the fallback; send `*`. |
| R6 | **The generated-query preview is hard-coded to `datasource: "logs"`.** On the Traces datasource that Monaco model is registered under the logs catalogue. | Pass the datasource through. |
| R7 | **The pipe-remove × has no accessible name** and stays visually interactive under `readOnly`, where its handler no-ops. | Give it a label and disable it properly. Our rule 4 requires the label regardless. |
| R8 | **The add-pipe control is an unlabelled, permanently empty `Select`** — `value: ""` is hard-coded and there is no placeholder, so it renders as a blank 280px box next to the cards. | A labelled `Add pipe` control, or at minimum a placeholder. |
| R9 | **The add-pipe handler appends the catalogue object by reference**, so the first `stats` card *is* the module constant. Nothing mutates it today, because every edit path is copy-on-write, but one `.push` or one `obj.by = …` anywhere would corrupt the catalogue for the rest of the session. | Clone on append; freeze the catalogue. |
| R10 | **Stats arguments are emitted unquoted while `by (…)` names are quoted.** A field the picker itself offers — `compact-revision`, anything with a dash or a space — produces a query that does not parse. The same applies to FIELDS row names. | Quote names that are not plain identifiers. |
| R11 | **`quantile` with no field emits `quantile(0.9, )`.** | Drop trailing empty arguments. |
| R12 | **The value `Select` binds an array to a single-select control** and has no `allowClear`, so a one-value filter can be replaced but never emptied. | Bind a scalar in single mode; add `allowClear`. |
| R13 | **The Builder cannot express most of LogsQL's filters.** Four operators, no OR, no grouping, and `equals` is always the exact-match `:=` — while the Code tab's own snippet list advertises word match, phrase match, regex, `exists`, `>` and `<` as the first things a user should reach for. | Expand the operator vocabulary before adding anything else to the Builder; word match is the one the autocomplete puts first. |
| R14 | **`Enter` in the Explore editor does nothing.** It is bound to the `run-query` action, and Explore passes `onSubmit: () => {}`; the newline bindings are all on modifiers. So Enter neither runs nor breaks the line. | Wire Enter to the page's run action, Shift+Enter to a newline. ARCH D4. |
| R15 | **No validation in Explore.** The debounced server probe and the `logsql-syntax` markers only run under `searchSurface`, which Explore never sets. A syntax error surfaces only as a failed query. | Validate locally; we already have a parser. |
| R16 | **Value narrowing is prefix-only.** Row *n*'s options are constrained by the rows above it and by nothing below, so re-ordering rows changes the suggestions without changing the query. | Narrow by every other row. |
| R17 | **The Mobile datasource reads the traces catalogue.** The autocomplete's fetcher maps `datasource === "logs" ? "vlogs" : "traces"`, so anything that is not logs falls through to traces. Out of scope for us, but it is the same code path Logs and Traces use. | Map explicitly. |
| R18 | **Pipes cannot be reordered.** New pipes append; the only edit is removal. Reordering a `stats` and a `math` means deleting and rebuilding. | Drag or up/down controls on the pipe cards. |

## Divergences from our implementation

Checked against `src/utils/explore/builders.js` (`buildLogsqlQuery`, `streamSelector`, `fieldFilter`,
`pipeToString`, `logsqlValueQueryFor`, `defaultBuilderModel`) and `src/utils/explore/catalogs.js`
(`MATCH_OPERATORS`, `LOGS_STATS_FUNCTIONS`, `LOGSQL_PIPES`, `LOGSQL_STATS_FUNCTIONS`,
`LOGSQL_FILTER_FUNCTIONS`). Our code was derived from an **older** build of this bundle; this is
what a re-read of the current one changes.

### What still agrees, exactly

`quoteString` ≡ `me`; `quoteAlternation` ≡ `Qk`, including the double-escaping and the decision not
to sort. `streamSelector` ≡ `mce`. `fieldFilter`'s operator mapping ≡ `aze` — `=` → `:=`, a leading
`!` → the `NOT ` prefix, `~` → `in`, the list quoted but **not** regex-escaped and joined with a
bare comma. `MATCH_OPERATORS` ≡ the four row options, same values *and* same visible labels.
`LOGS_STATS_FUNCTIONS` ≡ `u6e` — nine entries, same order, same arg specs, `quantile`'s `"0.9"`
default included. `newStatsAgg()` ≡ `tat`. `newLogsqlPipe`'s two shapes ≡ the two `Mdn` entries.
`changeOperator`, `changeLabel` and `withStatsFunction` ≡ the three select handlers.
`buildLogsqlQuery`'s assembly order and `*` fallback ≡ the serialising effect. `logsqlValueQueryFor`'s
prefix-only narrowing ≡ `pairs.slice(0, index)`. `by (…)` names are quoted in both, and both still
emit `quantile(0.9, )` for a quantile with no field. **No disagreement was found in the generated
query for any filter-only or pipe-only combination that the reference can express correctly.**

### Where we deliberately differ, and the reference has not caught up

Each of these was already a known fix; the new build confirms it is still a live reference bug, so
none of them should be reverted for parity.

1. **Field-name quoting** (`quoteFieldName`). The reference still writes FIELDS names and stats
   field arguments bare — `compact-revision:="x"`, `count(compact-revision)` — which does not parse.
   We quote anything outside `[A-Za-z_][A-Za-z0-9_.]*` and anything reading as `and`/`or`/`not`.
   Everything the reference *can* express is byte-identical.
2. **Empty pipes** (`.filter(Boolean)` in `buildLogsqlQuery`). The reference emits `"* "` for a lone
   empty `math` card and a double space in a mixed list.
3. **Empty FIELDS narrowing** (`logsqlValueQueryFor` → `'*'`). The reference still sends `" "`.
4. **Whitespace-only `if` and `as`** (trimmed in `statsPipeToString` / `mathPipeToString`). The
   reference tests raw truthiness and emits `if ( )` and `as " "`.
5. **A `stats` pipe with no aggregates** (we substitute `count()`). The reference emits `| stats `.
6. **An unknown pipe `value`** (we return `''`). The reference still `throw`s `unhandled pipe …`
   from inside a render effect, which takes the page down.

### Real divergences a re-read turns up

7. **The pair shape.** Reference rows are `{ label, operator, values, options }` and the **`options`
   array travels in the emitted model**; `emptyPair()` has no `options` at all. This is not
   cosmetic — carrying options in the model is exactly what causes reference bug R2, and our shape
   makes that bug unreachable. Anything that round-trips a reference model into ours should drop
   `options`, and `changeLabel`'s conditional `options: []` is the only place we tolerate it.
8. **The starting model.** The reference starts at `streamPairs: [blank]`, `labelPairs: [blank]`,
   `pipes: []`, which emits the empty string and shows nothing.
   `defaultBuilderModel(datasource)` seeds a `stats` pipe grouped by `log.level` (logs) or `service`
   (traces), so the datasource opens on `* | stats by ("log.level") count()`. Deliberate — rule 5
   and ARCH D2 — and it means our Builder is never in the reference's initial state.
9. **Catalogue object identity.** `newLogsqlPipe` returns a fresh object and `catalogs.js` is
   deep-frozen; the reference appends the module constant itself (R9). If a reference model is ever
   imported, two `stats` cards may share one object.
10. **`_`-prefixed fields.** The reference drops every `field_names` entry starting with `_` from
    the FIELDS field picker, the stats `group by` and the stats field arguments — but **not** from
    the STREAM picker and **not** from the Code-tab autocomplete. Nothing in `builders.js` or
    `catalogs.js` encodes that filter, and `logFieldNames` in `api.js` deliberately returns `_msg`,
    `_stream` and `_time`. Recommendation: do not copy the filter. `count(_msg)` and
    `stats by ("_stream")` are legitimate queries that the reference's Builder simply cannot write,
    and the Code tab contradicts the Builder about it on the same page.
11. **Two catalogues with near-identical names.** `LOGS_STATS_FUNCTIONS` (9) is the Builder's
    function picker; `LOGSQL_STATS_FUNCTIONS` (25) is the Code tab's post-`stats` completion list
    out of the grammar chunk. Both are faithful, and the reference has the same split — its Builder
    reaches only 9 of the 25. Likewise `LOGSQL_PIPES` (60) is the Code-tab list, while the
    reference's add-pipe select offers exactly two entries, `stats` and `math`, rendered as their
    bare values. The add-pipe control must not be fed `LOGSQL_PIPES`; `newLogsqlPipe` only knows
    the two, so the pair is already consistent.
12. **The operator vocabulary is a ceiling, not a floor.** `MATCH_OPERATORS` matches the reference's
    Builder exactly, but the reference's own Code-tab snippet list offers ten operators and puts
    word match (`:`) first. Our four-operator row is therefore as expressive as the reference's and
    no more, and our `equals` means `:=` — the one filter shape the autocomplete calls `exact match`
    rather than the default. Worth revisiting (R13) rather than treating as settled.

### Beyond `builders.js` — behaviour the reference does differently

13. **Tab carry-over.** ARCH D3 seeds Code from the tab you came from while Code is untouched. The
    reference does the opposite (R1): the built query is discarded. Recorded here so the difference
    is not later mistaken for something we misread.
14. **Keys.** ARCH D4 gives Enter run-or-accept, Shift+Enter a newline and Cmd/Ctrl+Enter an
    unconditional run. The reference binds Enter to a no-op in Explore, and makes
    Cmd/Ctrl/Shift/Alt+Enter all insert a newline. Two separate disagreements.
15. **Validation, chips and auto-suggest.** The reference's Explore editors pass neither
    `searchSurface` nor `paintChips`, so the Code tab there has no error markers, no query chips and
    no suggest menu on focus — all three exist only on the standalone Logs/Traces search surface.
    Our `utils/explore/logsql/` parser and `complete/logsqlComplete.js` give the Code tab a real
    tokenizer-driven completion and local validation. That is richer than the reference by design.
16. **Completion dispatch.** The reference picks its context from the *last regex match before the
    caret*, which misreads `field:in(` as a field-name position (`(` and `,` always mean field
    names) and fires the stats-function list after the literal word `stats` wherever it appears.
    Ours walks the token stream and keeps a paren frame. Keep ours.
17. **Time bounds.** The reference's Builder pickers use step-aligned bounds while its Code
    autocomplete uses the raw ones — the same page asking two different windows. ARCH D5 puts both
    on `src/utils/timeRange.js`; one window for both is correct, and it is a divergence.
18. **When the catalogues reload.** The reference keys that effect on the `refresh` URL parameter
    (R4). Ours should key it on the committed range and env; nothing in `builders.js` governs it, so
    it is the Builder component's job.
