# Facet interaction — Datadog-style split row

*Decision record. Carried over from Claude Code's local memory during the repo handoff; originally written 2026-08-31. Status at time of writing preserved below.*

**Status:** Complete. PR #25 merged; PR #24 (log record types) merged on top with two follow-up fixes.

## What was implemented

Replicated Datadog's facet-checkbox interaction exactly: the row is two controls. The **checkbox** toggles one value; the **rest of the row** narrows to that value alone — or, when it's already the only one left, hands everything back.

Each half announces itself on hover:
- Checkbox hover → **Toggle**
- Row-body hover (not sole) → **Only**
- Row-body hover (sole) → **All**

This label is the only thing separating a checklist from a radio group.

## How the filters state works now

The panel and query bar are one state: the chips. The panel derives its ticks from them. Ticked-by-default, because an empty query means `*`.

- **Unticking values** adds exclusion chips: `log.level != error AND log.level != warn`
- **"Only" clicks** write inclusions: `log.level := error OR log.level := warn`
- **Toggling afterwards** preserves whichever shape the field is already in, so extending an exclusion with a second untick reads as "one more thing ruled out", not a silent flip to an inclusion list

Exclusions on one field join with AND, never OR (a record has one `log.level`, so `!=error OR !=warn` would match everything).

## Evidence from the video

Examined the Datadog screen recording frame-by-frame with AVFoundation. Confirmed:
- All ticked → query empty ("Filter your logs")
- Unticking → `-status:(error OR warn)` — a negated OR
- "Only" → `status:error` — positive inclusion
- **The representation depends on the operation, not the result** — two frames both show 1-of-3 ticked but one reads as exclusion and the other as inclusion
- Hover the checkbox → "Toggle"; hover the row body → "Only"

The "All" signifier (hovering the sole-selected row) was confirmed across multiple frames at `t27.40`, `t28.20`, `t28.60` from the same video.

## Also in this branch

- **Facets derived from the rows** instead of a hand-written list. Three admission rules: enough room for a checkbox list, values short enough to read in a row, some actual narrowing power.
- **Hairline scrollbars, 9px → 2px**, platform-wide. At that width the bar is a position indicator, not a grab handle.
- **Filters panel scrolls with a fixed header** so *Reset All* stays reachable.

## Verified

- 11 new tests on facet helpers (AND-not-OR invariant, mode preservation, both read directions)
- All test suites pass (81 tests total)
- Seven state-transition sequences driven in the browser, chips and ticks both directions
- All three hover signifiers confirmed against computed style
- Production build clean

## Commits

1. `e203699` — Derive the logs facet list from the rows
2. `7010836` — Thin the scrollbars to a hairline, platform-wide
3. `d19ed9b` — Make the filters panel and the query bar one state
4. `d25ccce` — Rename the filters clear button to 'Reset All'

## Facet admission: why a cardinality ratio is the wrong rule

Learned while reviewing PR #24, which added four non-request record shapes (k8s events, DB spans, container logs, NR/Elastic spellings).

The original rule rejected a field with more than 40 distinct values. That catches a *dense* identifier (`trace_id`, 184 values over 184 rows) but never a *sparse* one — a field carried by four rows has at most four values. The panel grew to 81 groups, full of uuids and timestamps.

**The obvious fix — a distinct/populated ratio — is wrong, and measuring proved it.** On the seeded rows `object.metadata.uid` and `object.reason` both carry four distinct values across the four rows that have them. They are indistinguishable by any count. Any ratio strict enough to drop the uuids also drops SuccessfulCreate / BackOff, `db.operation`, `db.sql.table` — the facets the new record shapes exist to demonstrate.

**What works is a test on value *shape*:** uuids, hex runs (≥16), ISO instants, opaque tokens are identities at any cardinality. Numbers are the one case still needing a count, because `200` and `24000000` are both just digits — a status code repeats across rows, a duration doesn't (rejected above a 0.6 ratio, which keeps `http.status`).

Detail: the uuid test is on *composition* (enough hex once dashes come out), not the 8-4-4-4-12 layout — the seeded pod uids run a ten-character final group, and real telemetry carries malformed ids too.

Result: 81 → 66 groups. Pinned in `src/data/logFacets.test.js`.

**Why:** I told the user the ratio was the fix before measuring, and had to correct it. Measure the data before picking a threshold — especially when record shapes are heterogeneous and populations are small.

**How to apply:** when a heuristic separates "useful" from "junk", check whether the signal you're proposing actually distinguishes the two cases *in the real data*, not just in the motivating example.
