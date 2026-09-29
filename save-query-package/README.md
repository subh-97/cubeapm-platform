# CubeAPM Save Query — integration package

Naming a query so it can be found again, keeping it, and knowing what the query on screen descends
from. Covers the Save Query button and its popover, the note under the bar, and the My Queries panel.

Three things travel together:

| | |
|---|---|
| **Live prototype** | https://cubeapm-platform.vercel.app/logs — sign in with anything, build a query, Run, then Save Query |
| **Handoff document** | https://claude.ai/code/artifact/7268d8e3-0dce-4b3d-9da8-23a8f3f2102c |
| **This package** | the code, its tests, and its tokens |

---

## Verified before packaging

- **16 tests pass from inside this folder**, using only the files here.
- **Every `@/` and relative import resolves within the package** — checked mechanically.
- **Every copy is byte-identical to its source.**
- External packages: `react`, `react-dom`, `lucide-react`, `clsx`.

```bash
npm install
npm test
```

---

## The one thing to understand first

Saving a query is three questions, and the whole feature is the difference between two of them:

| | |
|---|---|
| **`savedAs`** | the query on screen **is** one of your saves. Derived from the query, so it appears and disappears as you edit. |
| **`origin`** | the query on screen **came from** one of your saves. Carried by id, because once edited it matches nothing and could not be derived at all. |

**Update** is what sits between them — offered only once a query has drifted from its origin. While
it still matches, `savedAs` covers it and there is nothing to update.

Identity is the **query**, never the name. The question the button answers is "have I kept this one",
not "is there something called this" — so two saves of the same query under different names both
count as saved.

---

## What's here

Paths mirror the original repo, so the `@/` alias resolves unchanged.

### The feature

| Path | Lines | Role |
|---|---:|---|
| `src/utils/savedQueries.js` | 80 | **The rules**, as pure functions. Start here. |
| `src/hooks/useSavedQueries.js` | 99 | Binds those rules to React state |
| `src/components/SaveQueryPopover.jsx` | 151 | Naming, and the Update / Save as New choice |
| `src/components/MyQueriesDrawer.jsx` | 98 | The saved list, with search |
| `src/utils/savedQueries.test.js` | 151 | 16 tests — the specification |

### It sits on top of the query bar

Saving a query means saving what the bar produced, so the package carries enough of the bar to
compose and render a query. **If you are also integrating the query-bar package, these overlap** —
take one copy.

| Path | Why |
|---|---|
| `src/components/QueryBuilder.jsx` | `chipsToString`, and the seeded `SAVED_QUERIES` examples |
| `src/utils/pipes.js` | `composeQuery` and `withImpliedCount` |
| `src/utils/queryTree.js`, `src/utils/typedQuery.js` | QueryBuilder's own dependencies |
| `src/components/PipePopover.jsx` | The popover shell |
| `src/utils/logFields.js`, `src/data/*` | Mock records — **seed data, replace it** |
| `src/index.css` | Full stylesheet. This surface's classes: search `.sq-`, `.logs-query-note` |

---

## Wiring it

```jsx
const {
  saved, saveable, composedButUnrun,
  savedAs, origin, updatable, note,
  save, update, apply, remove,
} = useSavedQueries({
  queryMode,                       // 'builder' | 'raw'
  appliedChips, appliedPipes,      // what the results reflect
  effectiveChips, effectivePipes,  // what the bar currently spells
  livePipes,
  appliedQuery,                    // the composed query string
  stringify: chipsToString,
  examples: SAVED_QUERIES,
  onToast: setToast,
  onApply: (q) => { /* write your own query state, then it runs */ },
})
```

`stringify` is injected rather than imported because it belongs to the query builder, which sits
downstream — injecting it keeps the dependency pointing one way. `onApply` is yours for the same
reason: the hook owns the saves, not the bar.

### Persistence is not included

`saved` is React state and is **lost on reload**. That is the deliberate scope of the prototype, not
an oversight — wiring it to an endpoint or to `localStorage` is the first thing to add. The shapes
are plain objects:

```js
{ id, savedAt, updatedAt?, name, description, chips, pipes }
```

Saving keeps **chips and pipes, not the query string**. Reapplying should put the builder back
exactly as it was; a string would have to be reparsed, and anything the parser cannot express would
come back as free text instead of the filters the user actually saved.

### Four rules worth keeping

1. **Save is disabled until the query has been run.** Enabled by a typed-but-unrun query, saving
   would store something the user never saw results for. The two ways to have nothing to save get
   different advice: an empty bar wants a filter, a composed-but-unrun one wants Run.
2. **Raw mode cannot be saved.** There are no chips to store.
3. **Applying a saved query runs it.** A saved query is a destination, not a draft — landing on the
   builder with filters loaded but the old results still showing is the one state nobody wants.
4. **Emptying the bar ends the lineage.** Nothing is left that descended from anything. Any lesser
   edit keeps it.

### Where the seeded examples appear

`SAVED_QUERIES` in `QueryBuilder.jsx` is **seed data to replace**. It feeds two places and not a
third:

- the query builder's suggestion overlay — yes
- the note under the bar, so an applied example can say what it is for — yes
- the My Queries panel — **no**, deliberately. That panel lists only the user's own saves and shows
  a proper empty state instead, because deleting a worked example out of a prototype leaves nothing
  to put back.

---

## Acceptance criteria

The tests were written *before* the logic was lifted out of the page, so they assert the behaviour
that shipped rather than the behaviour of the refactor.

| Suite | Tests | Covers |
|---|---:|---|
| `src/utils/savedQueries.test.js` | 16 | Identity by query not name, the two empty states, lineage and when Update appears, the note's precedence, and the write helpers |

One case worth reading before you touch `keyOf`: **a group-by with no aggregation**. Without
`withImpliedCount` it serializes to nothing, and every grouped query would collide with every other
one. There is a test for exactly that.

---

Packaged from the save-query extraction. Where this README and the code disagree, the code is right.
