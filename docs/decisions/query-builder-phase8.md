# Logs Query Builder — Phase 8 status

*Carried over from Claude Code's local memory during the repo handoff. The memory
was written 2026-08-13 and listed three outstanding items; this file records what
was verified against the code on 2026-09-30, because two of the three had since
landed.*

## Shipped

Phases 1–7: chip-based builder with CubeAPM-canonical syntax, OR connectors,
IN/NOT_IN multi-value, stream selector `{}` in serialization, categorized
operator picker, per-op value input polish, live query preview.

**Raw/Lucene query mode** — landed in `e8ed2c7`. The parser, serializer and
suggestion engine live in `src/utils/rawQuery.js`; `src/pages/LogsView.jsx` and
`src/pages/TracesView.jsx` consume it through `tryParseConditions`, `splitQuery`,
`replacePipeSection` and `validatePipeText`. Parseable expressions convert back
to chips; pipe sections stay raw and are passed through as-is.

**Error diagnostics** — the spec asked for eleven distinct user-facing messages.
`QueryError` in `src/utils/rawQuery.js` now raises roughly fourteen: unterminated
quoted string, unclosed value list, empty list entry, missing operator, missing
value, unclosed stream selector, unsupported stream-selector operator, unmatched
`)`, unclosed `(`, empty group, unsupported `NOT`, unexpected character, and a
generic fallback. `tryParseConditions` wraps them non-throwingly as
`{ ok, chips, error }`.

## Still outstanding

**URL state sync.** Chips and raw text should serialize into the URL so a query
is shareable and bookmarkable. Nothing in `src/` touches `useSearchParams`,
`searchParams` or `history.replaceState` yet — this has not been started.

Both directions are needed: write on query run, and hydrate the builder from the
URL on mount (which has to respect rule 5 in `CLAUDE.md` — the page auto-runs a
default query, so an incoming URL query must take precedence over that default
without double-fetching).

## Loose end spotted while verifying

`src/components/RawQueryInput.jsx` (187 lines) and
`src/components/QueryModeToggle.jsx` (29 lines) are not imported anywhere. Raw
mode was wired up through `LogsView` directly instead. Either adopt them or
delete them — do not assume they are live just because they exist.
