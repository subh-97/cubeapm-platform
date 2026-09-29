# CubeAPM Log Record Drawer — integration package

The panel that opens when a log row is clicked: severity and record shape, identity cards, field
search, the message card, grouped fields, pinning, a numbered JSON view, and time-based navigation
between records.

Three things travel together:

| | |
|---|---|
| **Live prototype** | https://cubeapm-platform.vercel.app/logs — sign in with anything, then click any row |
| **Handoff document** | https://claude.ai/code/artifact/3774865c-8640-446e-b726-583262b7ef57 |
| **This package** | the code, its tests, and its tokens |

---

## Verified before packaging

- **35 tests pass from inside this folder**, using only the files here — nothing resolves back to
  the original repo.
- **Every `@/` and relative import resolves within the package.** Checked mechanically; it is what
  caught `src/data/logRecordTypes.js` missing on the first pass.
- **Every copy is byte-identical to its source.**
- External packages required: `react`, `react-dom`, `lucide-react`, `clsx`. That is all — no
  charting library, no router.

```bash
npm install
npm test        # 35 assertions across 2 files
```

---

## What's here

Paths mirror the original repo, so the `@/` alias resolves unchanged.

| Path | Lines | Role |
|---|---:|---|
| `src/components/LogRecordDrawer.jsx` | 744 | The drawer, plus the pieces only it uses: `LinkMarker`, `NoiseGroup`, `FieldRow`, `PinButton`, `MessageCard`, `StackTrace`, `JsonLine` |
| `src/utils/logFields.js` | 351 | **The interesting half.** Field concepts and aliases, record-shape detection, field grouping, link resolution, duration glosses |
| `src/utils/highlight.jsx` | 17 | Search-term highlighting, shared with the log table |
| `src/utils/status.js` | 65 | Severity resolution — load-bearing across the whole product |
| `src/components/shared/StatusBadge.jsx` | 27 | Severity badge |
| `src/data/logRecordTypes.js` | — | Record shape definitions for the mock stream |
| `src/data/observability.js` | — | Mock log rows |
| `src/data/services.js` | — | APM service list — used to decide whether a service link can resolve |
| `src/index.css` | — | Full stylesheet. The drawer's classes are contiguous: search `.log-detail-`, `.log-sel-`, `.log-hit` |
| `src/components/LogRecordDrawer.test.js` | 81 | Renders every record shape on both tabs |
| `src/utils/logFields.test.js` | 235 | Grouping, links, glosses, shape detection |

---

## The component

```jsx
<LogRecordDrawer
  record={selectedRecord}      // the log row
  onClose={() => …}
  searchTerms={terms}          // string[], longest-first — highlights matches
  onAddChip={(field, value, op) => …}   // "filter to this" from the field menu
  onDistribution={(field) => …}         // "show distribution" for a field
  onCopy={(text) => …}                  // copy message / copy JSON
  index={i} total={n} onNavigate={(dir) => …}   // Newer / Older
  pinned={pinnedFields} onTogglePin={(field) => …}
  onOpenLink={(link) => …}     // see the link contract below
  initialView="fields"         // 'fields' | 'json'
/>
```

**It owns no query state.** Every action is handed back as a callback, which is what lets the same
drawer sit in front of a different data source.

### Record shapes

`recordType()` classifies each record, and the shape decides which fields lead. A database call
opens with the call and ends with the resource block; a Kubernetes event opens with what happened
rather than with metadata.

| Shape | Label |
|---|---|
| `request` | Request |
| `db-span` | Database call |
| `exception` | Exception |
| `k8s-event` | Kubernetes event |
| `k8s-log` | Container log |
| `record` | Record *(fallback)* |

`fieldGroupsFor()` guarantees **every field lands in exactly one group** — asserted in the tests.
Unrecognised fields fall through to a rest group, and noise fields collapse behind a disclosure
rather than being dropped.

### Navigation is time-based, not positional

`hasOlder` uses `index < total - 1`, but the labels say Newer and Older rather than Previous and
Next. Logs are newest-first and paginated, so a total is only ever "what has loaded" — an ordinal
would describe that window rather than the result set.

**When you paginate:** Older at the loaded edge should fetch the next page rather than disable. The
in-flight and stale states for that already exist on the query path.

### The link contract

`linkFor()` decides where a value leads and returns one of two kinds:

```js
{ kind: 'open',   view: 'traces' | 'service' | …, label, hint }   // navigate
{ kind: 'filter', field, value, label, hint }                     // narrow the current query
```

The destination is described in `logFields.js` rather than at each render site, so **the marker
beside a value and the entry in its field menu can never name different places.**

One rule worth keeping: a log's service is not always an APM service. On a real instance log rows
carry `search` while APM knows `search-service`. Linking anyway produces a page that loads, shows
nothing, and blames the user — so the resolver is handed the set of names that actually exist and
degrades to a filter when there is no match. Pass your real service list.

`onOpenLink` receives the resolved link; wire it to your router. In this build the destination for
traces is `TraceDetail`, which is **not** shipped here — it is its own piece of work.

---

## Wiring it to a real API

Everything the drawer renders comes from the record you hand it, so there is no fetching inside the
component. What needs attention:

1. **Field metadata.** `logFields.js` encodes aliases (`service.name` and `service` are one concept)
   and which fields are noise. Real instances will carry fields this file has never seen — they land
   in the rest group, which is the intended behaviour, but the alias table is worth reviewing
   against your actual field catalogue.
2. **The service list.** `services.js` is mock. Pass your APM service names so links resolve
   correctly rather than degrading to filters.
3. **Pagination.** See the navigation note above.
4. **`onCopy`.** Currently used for the message and the JSON view; wire it to your clipboard and
   toast.

---

## Acceptance criteria

`LogRecordDrawer.test.js` exists because a prop rename once left the JSON view passing the old shape
to `LinkMarker`, which threw and blanked the drawer. Every path it covers was reachable by clicking
and none by reading the Overview tab alone.

It earned its keep again during this extraction: it caught `StatusBadge` and `statusForLogLevel`
being left behind — a `ReferenceError` invisible to both the build and eslint.

**Render every shape on both tabs after any change to the drawer's props or its children.**

| Suite | Tests | Covers |
|---|---:|---|
| `src/utils/logFields.test.js` | 29 | Grouping (every field in exactly one group), link resolution, duration glosses, shape detection, stream membership |
| `src/components/LogRecordDrawer.test.js` | 6 | All five shapes on both tabs, pinned fields, JSON link decoration |

---

Packaged from the record-drawer extraction. Where this README and the code disagree, the code is right.
