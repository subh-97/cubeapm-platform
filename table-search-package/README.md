# CubeAPM Table Search — integration package

Searching the rows of a table: fields, `AND`/`OR`, unions, and tags — in two variants that share
one field, one language and one implementation. What separates them is how many columns there are
to aim the language at.

Three things travel together:

| | |
|---|---|
| **Live prototype** | https://cubeapm-platform.vercel.app/ for the single-column variant; https://cubeapm-platform.vercel.app/infrastructure → Kubernetes → Pod for the multi-column one. Sign in with anything. |
| **Handoff document** | https://claude.ai/code/artifact/e32116ce-d267-4084-bdd2-9ed348b64dd9 |
| **This package** | the code, its tests, and its tokens |

---

## Verified before packaging

- **47 tests pass from inside this folder**, using only the files here.
- **Every `@/` and relative import resolves within the package** — checked mechanically.
- **Every copy is byte-identical to its source.** The one exception is `src/examples/`, written for
  this package and labelled as such.
- External packages: `react`, `react-dom`. **That is the whole list** — no icon library, no `clsx`.
  The magnifier, the clear ×, and the syntax colouring are all inline SVG and CSS.

```bash
npm install
npm test
```

---

## The one thing to understand first

**Pick the variant by how many columns the table can be searched on.** Both speak the same
language; the field set is the whole difference.

| | `TableSearch` | `TableQuerySearch` |
|---|---|---|
| Columns | one | two or more |
| Typical query | `redis`, or `pod.tier:cache` | `pod:redis AND namespace:default` |
| The column prefix | optional in practice | how you say which column you meant |
| API | `onApply`, `fields` | `onApply`, `fields` |

`TableSearch` **is** `TableQuerySearch` with a one-column field set — a preset, not a second
component. Keeping two copies of the colouring, the error timing and the parser is how two fields
that must agree stop agreeing.

It did not start that way. The single-column variant was plain text, on the reasoning that one
column has nothing to disambiguate and `pod:redis` in a table of pods says nothing `redis` does
not. That is still true of the column. It stopped being true of the row: a column carrying `app`,
`tier` and `team` is several things to search inside one column, and `pod.tier:cache` is not a
substring of anything.

So the rule is unchanged in spirit — **give a table the syntax when it has more than one thing to
search** — and tags are the second thing a single-column table can have.

Both variants share the `.svc-search` shell, so a table gains or loses the syntax without the field
changing shape.

---

## What's here

Paths mirror the original repo, so the `@/` alias resolves unchanged.

| Path | Lines | Role |
|---|---:|---|
| `src/utils/tableQuery.js` | 461 | **The language**: tokenizer, parser, matcher, colouring, placeholder. Start here. |
| `src/components/TableQuerySearch.jsx` | 126 | The field — the ink layer, the squiggle, the timing. The only implementation. |
| `src/components/TableSearch.jsx` | 22 | The single-column preset over it. Deliberately this short. |
| `src/utils/highlight.jsx` | 17 | `highlightTerms` — wraps matches in `<mark>`. Shared with the logs table. |
| `src/utils/tableQuery.test.js` | 408 | 47 tests — the specification |
| `src/examples/TableSearchDemo.jsx` | 116 | **Written for this package.** Both variants, tags included, over one small table. |
| `src/index.css` | 3660 | Full stylesheet — see the classes below |
| `tailwind.config.js` | | Design tokens, unchanged from the app |

### The classes this surface owns

| Prefix | What |
|---|---|
| `.svc-search`, `.svc-search-clear` | the shell both variants share, and its × |
| `.pod-search-wrap`, `.pod-search-field` | the query variant's wrapper |
| `.pod-search-ink`, `.pod-search-ink-wrap` | the colour layer under the input |
| `.pod-ink-field`, `-op`, `-paren`, `-plain`, `-bad` | the syntax colours, and the error squiggle |
| `.pod-search-error` | the sentence under the field |
| `.svc-tag`, `.svc-tag-k`, `.svc-tag-v` | a tag chip in a table cell: muted key, weighted value |
| `.svc-hit` | a highlighted match (shares its rule with the logs table's `.log-hit`) |
| `.svc-empty-row`, `.pod-empty-row` | "No data matches …" |
| `.panel-head.is-stacked`, `.panel-head-row` | title and hint on one row, field full-width beneath |

The `.pod-` prefix is historical — the query variant was built for the pod tables before it was
generalised. Renaming it is safe and touches only this stylesheet and these two components.

---

## Wiring it

Both variants wire up identically — swap the component and the field set.

```jsx
const [query, setQuery] = useState('')

const { node, ok } = parsePodQuery(query, FIELDS)
const shown = useMemo(() => (ok ? rows.filter(r => matchesPod(node, r, FIELDS)) : rows), [node, ok])
const hits  = useMemo(() => (ok ? highlightsFor(node, FIELDS) : {}), [node, ok])

<TableQuerySearch onApply={setQuery} fields={FIELDS} />   // or <TableSearch …/> for one column
...
<span>{highlightTerms(row.name,      hits.pod,       'svc-hit')}</span>
<span>{highlightTerms(row.namespace, hits.namespace, 'svc-hit')}</span>
```

### Rendering tags

Tags need a second highlight set, because a term aimed at one tag must mark that tag and nothing
else. `tagTerms` merges in the free-text terms, which could have matched any tag.

```jsx
const tagHits = useMemo(() => (ok ? tagHighlightsFor(node, FIELDS) : {}), [node, ok])
...
{Object.entries(row.labels ?? {}).map(([k, v]) => (
  <span key={k} className="svc-tag" title={`${k}: ${v} — search as pod.${k}:${v}`}>
    <span className="svc-tag-k">{k}</span>
    <span className="svc-tag-v">{highlightTerms(v, tagTerms(tagHits, 'pod', k), 'svc-hit')}</span>
  </span>
))}
```

The `title` is doing real work: it is the only place the syntax for *this* tag is spelled out, and
it puts it on the thing being described rather than in a legend somewhere else.

`ok` is belt-and-braces: the field only ever hands up a query that parsed. Keep the guard anyway —
it costs nothing and it means a caller who sets the query from a URL or a saved view cannot blank
the table with a bad string.

### The field set is the whole configuration

```js
const FIELDS = [
  // what the user types, the row property it reads, and — where the column
  // carries tags — the row property holding them
  { name: 'pod',       key: 'name', tags: 'labels' },
  { name: 'namespace', key: 'namespace' },
]
```

`name` and `key` differ more often than not — the pod column reads a row's `name`. Everything else
follows from this list: which fields parse, what an unknown-field error offers instead, which
columns free text searches, which columns accept a `field.tag:` reference, and the placeholder.
**Adding a searchable column, or making one's tags searchable, is one line here.**

`tags` names the property holding a plain `{ key: value }` object. There is no tag catalogue and no
validation of tag names: the parser cannot know which tags a row carries, and a query naming one
that does not exist simply matches nothing. That is the same answer a value that does not exist
gets, and it means a table gains searchable tags without anything having to enumerate them.

There is no `placeholder` prop, deliberately. It is generated — `Search pod, namespace or node
( eg. pod:abc AND pod.tag:value )` — so every table advertises the same form and adding a column
cannot leave a stale example behind. Where a column has tags the example spends its second half on
the tag form: the columns are named to its left already, but `field.tag:` is the part nobody
guesses. If you need a different phrasing, change `placeholderFor`, not the call sites.

---

## The language

```
payment                          every field and every tag, substring
pod:payment                      one field
namespace:*                      the field has any value
pod:(redis OR coredns)           a union — one field, several values
pod:redis AND namespace:default
pod:redis OR pod:coredns
```

`AND` binds tighter than `OR`, which is what every other query language does and therefore what
someone typing `a OR b AND c` expects. Field names and operators are case-insensitive; values are
matched as case-insensitive substrings.

### Tags

A column may carry tags, searched **through the column that owns them**:

```
pod.tier:cache                   the pod's tier tag is cache
pod.tier:*                       it carries a tier tag at all
pod.team:(payments OR platform)  either
pod.tier:backend AND namespace:default
```

`field.tag` rather than a bare `tag` for two reasons. A tag name is only unique inside its column —
two columns can both carry `team`, and the table cannot guess which was meant. And it keeps tags
from colliding with column names as either set grows: a `team` column and a `team` tag can coexist.

**The split is on the first dot.** Tag names commonly contain dots (`k8s.app`, `db.system`); no
column name does. So `pod.k8s.app:web` reads as the tag `k8s.app`, not as something nested.

**Free text reads tags as well as column values.** They are on screen in that column, and a word
someone can see that the search will not find reads as a broken box. The cost is that free text is
broader than it looks — `cache` matches a tag value as readily as a name — which is the trade the
prefix exists to let you escape.

**Highlighting follows the clause.** A term aimed at one tag marks that tag and nothing else, so
`pod.tier:cache` does not underline "cache" wherever it happens to sit in a pod name. Free text
marks both, because either could have matched. That is why there are two highlight functions.

Errors tell the three misses apart, because they send you to different places:

| Typed | Said |
|---|---|
| `nope:x` | Unknown field "nope". Search pod or namespace. Tags are searched as `pod.tag:value`. |
| `namespace.team:x` | "namespace" has no tags to search. |
| `pod.:x` | Nothing after "pod." — name the tag, as in `pod.team:alpha`. |

**This is deliberately not the logs query builder.** That one is a chip tree with pipes and an
operator catalogue; a two- or three-column table does not earn it. If a table ever needs ranges,
negation or `in (…)`, that is the signal to reach for the logs builder rather than to grow this.

---

## Six rules worth keeping

1. **Everything filters as you type.** No Enter, no search button. This is the redesign's rule 5 —
   never make someone click Search to see anything — and it applies to a query just as much as to
   a word.
2. **A query that does not parse is never applied.** The rows go on answering the last text that
   did. Half of `pod:(a OR` is malformed by definition; emptying the table under someone mid-clause
   punishes them for typing.
3. **Errors arrive in two strengths.** A squiggle marks the characters at fault — the exact token,
   not the line — after a pause in typing. The sentence explaining it waits longer.
4. **A query that merely ran out says nothing until you leave the field.** `pod:`, `pod:(redis`, a
   trailing `AND` — the person is deciding what to search for, not making a mistake. A query that
   is *wrong* (unknown field, stray `)`) explains itself straight away, because more typing on the
   end will not repair it. The parser reports which is which as `incomplete`; the component does
   not guess from the message text.
5. **The field itself never turns red.** Two bad characters do not make the whole search broken.
6. **Filtering only removes rows.** Severity order survives it — a search must never be the thing
   that quietly re-sorts a list. On Home this matters most: services are sorted critical-first at
   the data layer, and filtering preserves it.

---

## Acceptance criteria

| Suite | Tests | Covers |
|---|---:|---|
| `src/utils/tableQuery.test.js` | 47 | The language, its tags, its errors, the display segments, and the placeholder |

Five properties in there are contracts rather than examples, and are worth keeping if you rewrite
anything:

- **The segments concatenate back to the input, exactly.** The field draws its text twice — a
  coloured layer under a transparent input carrying the caret — and the two copies drift apart the
  moment that stops being true.
- **Every error has a span to underline.** An error without one would draw no squiggle: a silent
  failure in the one place it matters. Errors with nothing to point at fall back to the whole line.
- **`incomplete` splits ran-out from went-wrong**, which is what rule 4 above is built on.
- **The placeholder's worked example parses** — pulled back out of the generated placeholder and
  run, rather than copied into the test where it could go stale.
- **A column term and a tag term on the same column are different questions.** `service:alpha` and
  `service.team:alpha` must not return the same rows; the test asserts the first returns none. If a
  refactor ever makes a tag reference fall back to the column value, this is what catches it.

---

## Not built, on purpose

- **No suggestion overlay.** There was one; it was removed. The field is one line of text and the
  panel covered the rows being filtered, which cost more than it taught. The placeholder's worked
  example carries the syntax instead. If you bring a panel back, put it somewhere that does not
  obscure the result of what is being typed.
- **No debounce on the apply.** This filters arrays in memory, so per-keystroke is free. **Against a
  real API it is one request per character** — add a debounce there, and note it is a *different*
  debounce from the 500 ms one that delays the error message.
- **No persistence, no URL state.** The query lives in the parent's React state and is lost on
  reload. Sharing a filtered table by URL is the obvious next thing, and the query is already a
  plain string, so it is a serialisation away.
- **No server-side filtering.** `matchesPod` walks rows in memory. For tables of a few hundred rows
  that is right; past that, the parsed node is a tree that maps cleanly onto a backend filter.
- **No tag-name completion.** Typing `pod.` offers nothing, because the parser is given a field set
  and never sees the rows. The tag names are visible as chips in the column, which is where someone
  reads them — but if a table ever carries tags that are *not* all on screen, a completion source
  fed from the rows is the missing piece, and `resolveRef` is where it would hook in.

---

Packaged from `main` after the tag release. Where this README and the code disagree, the code is right.
