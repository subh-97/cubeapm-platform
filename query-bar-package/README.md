# CubeAPM Logs Query Bar — integration package

The chip query builder, the pipe toolbar (Group by / Aggregation / Math / Order / Limit), and the
query history drawer, extracted from the redesigned frontend as a self-contained set.

Three things travel together:

| | |
|---|---|
| **Live prototype** | https://cubeapm-platform.vercel.app/logs — sign in with any email and password, the gate checks nothing |
| **Handoff document** | https://claude.ai/code/artifact/174e9d5a-31bc-4599-8a36-d8fd201163d2 |
| **This package** | the code, its tests, and its tokens |

**Read the handoff document first**, specifically the section *The invisible logic*. It is eight
decisions, each with what breaks if you reverse it. Every one of them was arrived at by hitting the
alternative first, and none of them is visible in the code.

---

## Verified before packaging

- **200 tests pass from inside this folder**, using only the files here — nothing resolves back to
  the original repo.
- **Every `@/` and relative import resolves within the package.** Checked mechanically, not by eye.
- The only external packages required are `react`, `react-dom`, `lucide-react`, `clsx` and
  `recharts`. Notably **not** `react-router-dom` — that belongs to the app shell, not this surface.

```bash
npm install
npm test        # 200 assertions across 5 files
```

---

## What's here

Paths mirror the original repo, so the `@/` alias resolves unchanged. Copying `src/` over your own
`src/` works without editing a single import.

### Core — copy as-is

Zero dependencies outside this set.

| Path | Role |
|---|---|
| `src/utils/queryTree.js` | Chip tree: leaves, groups, paths, `normalize`, `concatWithAnd` |
| `src/utils/typedQuery.js` | Interpreting typed text as field / operator / value / free text |
| `src/utils/pipes.js` | Pipe model, serializers, validators, and the parser that inverts them |
| `src/utils/aggregator.js` | Client-side stats/math/sort/limit — **replace with the backend** |
| `src/components/PipePill.jsx` | Toolbar pill, empty and filled modes |
| `src/components/PipePopover.jsx` | Shared popover shell — anchoring, positioning, dismissal |
| `src/components/PipeSelect.jsx` | Styled select used inside the pipe editors |
| `src/components/GroupByPopover.jsx` | Multi-select field picker with search |
| `src/components/AggregationPopover.jsx` | Function, field, quantile *p*, `if` condition, `as` alias |
| `src/components/MathPopover.jsx` | Expression editor, insert-at-caret, in-scope name hints |
| `src/components/OrderPopover.jsx` | Sort field and direction |
| `src/components/LimitPopover.jsx` | Row cap |
| `src/components/AggregateResults.jsx` | Renders aggregate output |
| `src/components/Toast.jsx` | Transient confirmation, auto-dismiss at 4,500 ms |
| `src/components/layout/PageBar.jsx` | Page header — only needed to run `LogsView` |

### Needs rewiring

| Path | What to change |
|---|---|
| `src/components/QueryBuilder.jsx` | Imports `logRows` for the synchronous fallback in `computeTopValues`. Pass `fetchFieldValues` (below) and that import goes away. |
| `src/utils/rawQuery.js` | Imports `logRows` for `suggestRaw`, and `FIELD_CATALOG` from `QueryBuilder` — see the import cycle note below. |
| `src/data/observability.js` | **The only place mock data enters.** Keep it while you work, replace it last. |

### Reference, not for reuse

| Path | Why it's here |
|---|---|
| `src/pages/LogsView.jsx` | The worked example of how every piece wires together — state ownership, deferred execution, paste handling. Read it, then write your own. |

### Styles and config

| Path | Notes |
|---|---|
| `src/index.css` | The complete stylesheet. This surface's ~114 classes are contiguous blocks — search `.qb-`, `.pipe-`, `.qh-`, `.logs-query-`. The CSS custom properties they depend on are defined at the top. |
| `tailwind.config.js` | Token definitions — needed only if you adopt the utility layer. See the styling note below. |
| `vite.config.js` | Shows the `@` alias. Match it in your bundler or rewrite the imports. |
| `postcss.config.js` | Tailwind + autoprefixer. |
| `scripts/run-tests.mjs` | Test runner. Bundles each `*.test.js` with esbuild so tests can use the `@/` alias. |

---

## Wiring it to a real API

### Value suggestions

`QueryBuilder` takes an optional provider. Omit it and the builder reads the local index
synchronously — which is what makes the mock build instant, and why the default path has no loading
state to flicker through.

```js
<QueryBuilder
  fetchFieldValues={(field, { signal }) =>
    fetch(`/api/logs/values?field=${encodeURIComponent(field)}`, { signal })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`Value service unavailable (${r.status}).`)))
  }
  …
/>
```

Return `Array<{ value, count? }>`. The four states — loading, ready, empty, failed — are already
built, styled, and wired:

- Requests are **debounced at 180 ms and aborted** on change, so arrowing through fields does not
  fire a request per keystroke.
- Every result is **stamped with the field it describes**; a reply that lands after the user has
  moved on is discarded rather than rendered against the wrong field.
- **Only a settled list is navigable.** Skeleton and error rows are excluded from the keyboard
  index, so <kbd>Enter</kbd> during a load cannot commit a placeholder.
- The error state carries the message you reject with, plus a Retry.

High-cardinality fields (`trace_id`) take typed input and never fetch at all.

### Running a query

`LogsView.runQuery` keeps a promise round trip even though the mock resolves in a microtask — that
is what lets the in-flight, stale and failed states exist. Swap the resolved promise for your fetch
and the states already work: Run shows a spinner and reads *Running*, results dim and go inert
rather than being replaced, and a failure shows a dismissible banner with *Try again* while leaving
the previous results on screen.

A sequence number drops replies from superseded runs. Keep it.

### The four shapes the backend needs to provide

Derived from what `src/data/observability.js` supplies today:

1. **Facets** — field catalogue with type and cardinality hints. Drives which operators are offered.
2. **Value suggestions** — per field, scoped to the active time range.
3. **Log rows** — the fields the table and detail panel read.
4. **Aggregation results** — series and groups. `src/utils/aggregator.js` is the executable
   specification here: whatever the backend returns should slot in where its output does.

---

## Two things that will bite you

**The import cycle is deliberate.** `rawQuery.js` imports `FIELD_CATALOG` and `getFieldValue` from
`QueryBuilder.jsx`, so the builder cannot import the parser back. Where it needs parsing — the paste
handler — the parse is injected from the parent as the `parsePastedQuery` prop. Moving the field
catalogue into its own module dissolves the cycle and lets the injection go; until then, leave it.

**There are two styling systems and neither is marked canonical.** This surface is styled with
hand-written classes in `index.css` using CSS custom properties. The project *also* has a full
Tailwind token layer in `tailwind.config.js` exposing the same palette as utilities. Nothing in this
surface uses the Tailwind utilities. **Pick one before you extend anything**, or the next component
added here will be styled a third way.

---

## Acceptance criteria

Two round-trip properties are the real contract. Both are asserted in the suite, and both catch the
class of bug that is invisible in a browser:

```js
chipsToString(parseConditions(q)) === q
serializePipe(parsePipeStage(p)) === p
```

The first holds for every query the builder can express, nesting included. The second holds for
every pipe stage — 16 fixtures covering group-by lists, quantile *p*, `as` aliases, `if` clauses,
sort-direction defaulting, and verbatim raw stages.

Any reimplementation that passes these is correct by construction. If you refactor, these are the
tests that tell you whether you broke it.

| Suite | Tests | Covers |
|---|---:|---|
| `src/utils/rawQuery.test.js` | 72 | Grammar, round-trip, error messages, caret-aware suggestions |
| `src/utils/pipes.test.js` | 60 | Serialization against playground fixtures, parsing, validation |
| `src/components/QueryBuilder.test.js` | 31 | Chip matching, free-text ladder, evaluation |
| `src/utils/queryTree.test.js` | 27 | Tree mutation, `normalize` invariants, paste joining |
| `src/utils/typedQuery.test.js` | 10 | Interpreting typed input |

---

Packaged from `main` at commit `3bd8401`. Where this README and the code disagree, the code is right.
