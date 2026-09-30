# CubeAPM Home + Service Overview Artifact — Internal Design Critique

*Reviewing `cubeapm-redesign/cubeapm_home_artifact.html` against the three governing documents — `CubeAPM_Design_Direction_Tokens.md`, `newrelic-ux-teardown.md`, `cubeapm-ux-teardown.md` — and `CubeAPM_vs_NewRelic_UX_Benchmark.md`'s recommendations. This is a source-level critique (code + logic), not a rendered-screenshot review, since screenshot capture isn't available in this session; findings are grounded in reading the actual HTML/CSS/JS and executing it in a headless harness.*

## 1. Verdict up front

The artifact executes cleanly (verified via a full interaction-path harness — nav collapse, service switching, all home tabs, RED table/graph toggle, filter dropdowns, settings drawer in every context, search open/type/keyboard-nav, profile popover — nothing throws) and faithfully implements every priority-1 fix from the benchmark doc: severity-first sort, threshold-colored KPIs, an aggregate summary strip, a visible service-context surface, and an onboarding hub built from existing offerings rather than a new nav item. It also went beyond the minimum fix set in two directions — a global search/command-palette (a real New Relic gap the benchmark flagged) and a full settings drawer (not called for anywhere in the three docs). One of those two additions is well-justified; the other is scope growth that should be weighed against the 2-day deadline, especially since half its content is currently unreachable through the UI (see §3.1).

## 2. Fidelity to the Design Direction Tokens doc

| Token | Spec'd value | Artifact value | Assessment |
|---|---|---|---|
| `bg.canvas` | `#0B0E14` | `#151820` (`--canvas`) | Lighter than spec'd — a deliberate-looking choice (canvas is now a mid-tone gutter, with a *darker* card `#080B11` nested inside it), inverting the doc's darkest-is-background assumption. Visually reasonable, but it's a real deviation from the locked spec, not just a rounding difference. |
| `bg.surface` | `#12151F` | `#080B11` (`--card`) | See above — the hierarchy direction flipped (surface is now darker than canvas, not lighter). |
| `bg.surface-raised` | `#1A1E2B` | `#1E2431` (`--raised`) | Close match, fine. |
| `border.subtle` / `border.default` | `#232838` / `#2E3448` | `#232B3B` / `#2A3346` + a new `#39445C` (`--border-strong`) | Close match, plus one net-new border tier not in the spec — reasonable addition, not harmful. |
| `text.*` | `#F1F3F9` / `#9CA6BF` / `#616B85` | Matches exactly (muted is `#616C86`, 1 digit off — negligible) | Good — text tokens preserved precisely. |
| `brand.primary` | `#3B82F6` | Matches exactly | Good. |
| Semantic status colors | `#22C55E` / `#F59E0B` / `#EF4444` / `#60A5FA` / `#616B85` | Matches exactly, used consistently for status dots, badges, KPI card borders, health strip | This is the doc's single most important rule ("every KPI/table cell/badge must resolve through this palette based on a threshold — never hardcoded") and it's implemented correctly and consistently everywhere except one spot (§3.2). |
| Radius scale | `sm 4px / md 8px / lg 12px` | `sm 6px / md 9px / lg 10px / card 12px` | Values shifted up and a 4th tier added. Directionally same spirit (soft modern radii) but not the exact spec — should be ratified as an intentional update or corrected. |
| Chart series palette | `#3B82F6, #A78BFA, #F472B6, #34D399, #FBBF24` (5 colors, chosen to avoid confusable red/green pairing) | RED graph uses `['#3B82F6','#34D399','#F59E0B','#A78BFA']` | **This is a real problem, not a style nitpick.** `#F59E0B` is the *warning* status color, reused here as a plain series-identity color for "whichever endpoint happens to be third in the array." In a multi-line comparison chart, a line can now be amber purely because of array order, not because that endpoint is actually breaching a warning threshold — exactly the identity/severity color collision the tokens doc's Core UX Rule #3 was written to prevent. Swap in the spec'd `#F472B6` (unused) instead of `#F59E0B` for series identity, and reserve `#F59E0B` for cases where it actually signals a warning-severity value. |
| Accent violet `#8B5CF6` | Not in the original tokens doc at all | Used for the onboarding panel background gradient and sparkle icon | Net-new hue introduced mid-build. Used sparingly and doesn't collide with anything, but it's an unratified palette expansion — flag it for the design-system doc (task #25) rather than let it silently become "the" accent without a decision. |
| Numerals in JetBrains Mono | Spec reserved mono for trace/span IDs and code only | KPI card headline values (`.kpi-card .val`) now render in JetBrains Mono | Plausible upgrade (tabular alignment reads well for stacked metric columns) but it's a drift from what the doc actually specified — should be called out and folded back into the tokens doc explicitly rather than left as an implicit change only visible by reading the CSS. |

**Net read:** the semantic status-color rule — the one that mattered most — was honored faithfully. Everything else drifted in small, mostly-defensible ways that should be reconciled back into the tokens doc (task #25) rather than left as silent divergence, since that doc is what's supposed to seed the eventual style guide.

## 3. Functional/logic issues found in code review

### 3.1 Settings is unreachable on Home (real bug)

The settings gear button in the header only renders when `!isHome` (line 758), but `settingsTabsForContext()` and `settingsBodyHTML()` both contain a fully-built `'home'` branch — auto-refresh interval, default time range, services-per-page, webhook URL, notify-on rules, suppression window. None of it is reachable through the UI. Either surface the gear icon on Home too, or remove the dead branch — right now it's finished code with no door into it.

### 3.2 Avg Latency KPI card reuses the p90 series and its threshold label

`renderKpiCards()` builds the "Avg Latency" card's sparkline from `paymentServiceSeries.latencyP90` — the same dataset as the adjacent p90 card, just recolored — and labels its footer "Threshold 150ms," which is actually `THRESHOLDS.latencyP90Ms.warn`. The data model has no independent avg-latency threshold, so this card is presenting the p90 card's data as if it were distinct, and implying a threshold that doesn't exist in the underlying logic. Low visual impact (viewers won't easily spot two near-identical sparklines with different colors), but it's a data-integrity issue worth a one-line fix — either generate a real avg-latency series or drop the misleading threshold caption.

### 3.3 Residual fixed width on the search bar

`.search-wrap` sets `width:520px` at the base level. The `max-width:720px` responsive breakpoint clears `max-width` and sets `flex-basis:100%` but never resets `width` — on a viewport narrower than 520px the search bar will overflow rather than shrink to fit. Low severity for a primarily-desktop artifact, but the mobile breakpoint clearly intends to support narrow viewports elsewhere (nav collapses, main padding shrinks), so this one rule is inconsistent with that intent.

### 3.4 Dead code from the mid-build layout change

`.svc-chip` CSS and the `toggleSwitcher()` / `switcher-pop` functions are unused — service switching moved from a header dropdown chip to the persistent left sidebar at some point in the build, and the earlier chip implementation wasn't removed. All references are null-checked so nothing breaks, but this should be deleted before the file becomes the base for a Claude Code / component-library handoff, so a future reader doesn't mistake it for a working feature that's just not wired up yet.

## 4. UX decision fidelity — did the redesign actually fix what the docs said to fix?

| Finding from the teardowns/benchmark | Status in this artifact |
|---|---|
| Home defaults to alphabetical, not severity | **Fixed.** `services.sort()` is explicitly severity-first, comment references the original finding directly. |
| No aggregate "X services, Y unhealthy" summary | **Fixed.** `renderSummaryStrip()` adds it above the fold. |
| KPI cards always render green regardless of value | **Fixed**, correctly threshold-driven via `statusForLatency`/`statusForErrorRate` — except the Avg Latency card's mislabeled threshold (§3.2). |
| 14 unlabeled rail icons | **Fixed, and extended.** Labels added, plus the rail is now grouped (Workspace / Analyze / Manage) with a collapse-to-icon-only + hover-expand affordance — closer to New Relic's hybrid nav pattern without importing its tile-catalog sprawl, exactly the "adopt the transferable idea, skip the sprawl" call from the benchmark doc. |
| No visible service-context concept (benchmark's "make New Relic's entity idea visible") | **Fixed, and taken further than originally proposed.** Instead of a header chip, the entire service list persists in a left sidebar throughout the Service Overview view — arguably more discoverable than my original proposal, at the cost of some horizontal space (mitigated by the 1080px responsive collapse to a single column elsewhere). |
| No onboarding/maturity hub, and New Relic's Recommendations page was the benchmark's top transferable idea | **Fixed as specified** — a dismissible Home panel with Basic/Core/Full-platform tiers pointing at SLOs/Alerts/Synthetic/Logs, using existing offerings, no new nav item. |
| Endpoint-level detail (RED tab) was one of the few things praised in the CubeAPM teardown itself | **Preserved and enhanced** — table view plus a new 4-metric multi-line graph view comparing endpoints directly (subject to the color-collision issue in §2). |
| No global search / command palette (a documented New Relic strength CubeAPM lacks) | **Added.** Not on the benchmark doc's explicit priority-1-through-4 list, but directly traceable to a named gap in the benchmark's feature-parity section. Reasonable addition, though it added meaningful net-new surface (search index, portal rendering, keyboard nav) beyond the minimum fix set — worth being deliberate about given the 2-day clock. |
| Settings drawer | **Not called for anywhere in the three docs.** This is scope the build added independently, and it's the largest net-new addition relative to the original plan. It's well-built, but half of it is currently unreachable (§3.1), and it's fair to ask whether that build time would have been better spent finishing out Logs' manual-Search-click bug fix or hardening what was already scoped. |
| Logs' manual-Search-click bug, SLO threshold-miscalibration flag | **Correctly out of scope** for a Home/Service-Overview artifact — these belong to the Logs and SLOs pages, which haven't been built yet. Flagging here only so they don't get lost before the founder demo — they're still open items. |

## 5. Usability, hierarchy, consistency spot-check

The empty-state standard the benchmark called out as inconsistent platform-wide (Dashboards' silent blank list vs. RUM's bare input vs. Admin's plain-text message) is handled well here: every non-Overview service sub-tab (External/DB/Errors/Traces/Runtime) shows the same one-icon, one-sentence, honestly-scoped placeholder ("Reserved for the next redesign pass — mirrors the existing X sub-tab"), which is exactly the kind of consistent minimum floor the original review asked for. The incident banner on the Service Overview page is a good addition not explicitly requested anywhere — it surfaces the root-cause note (`svc.note` from the demo data) as a first-class, color-coded element rather than leaving it buried in a tooltip, which directly serves the "is anything wrong right now" goal the founder originally described. The RED tab's table→graph view toggle is a nice progressive-disclosure pattern consistent with Explore's Quick→Advanced→Code staging noted as a CubeAPM strength in its own teardown.

One hierarchy concern: the settings drawer's per-context tab set (`Apdex | Thresholds | Alerts` for Overview and most service sub-tabs, `Display | Thresholds` for RED, `General | Notifications` for Home) is a reasonable design, but since Settings only renders content for tabs that are reachable, and several service sub-tabs (External/DB/Errors/Traces/Runtime) are themselves just placeholders, a user could open Settings for a tab whose actual content doesn't exist yet — a small mismatch between "this feature has settings" and "this feature has a feature."

## 6. Accessibility spot-check (directional, not a full audit)

Positive: `aria-label` present on icon-only buttons (drawer close, settings gear, help, avatar, nav collapse), disabled rail items correctly omit `tabindex` so keyboard users don't tab into dead ends, and `:focus-visible` has an explicit outline rule plus a `prefers-reduced-motion` override — none of that was asked for explicitly but it directly addresses the accessibility gaps both teardowns flagged (icon-only controls with no text alternative, unlabeled interactive elements). Gap: the status dots and health-strip blocks still communicate severity through color alone with no text/pattern backup, the same category of gap flagged against both New Relic and the original CubeAPM Home table — worth a small fix (e.g., a title attribute with the literal status word) before this goes further.

## 7. Prioritized punch list

1. ~~Fix Settings-unreachable-on-Home (§3.1)~~ — **intentionally not fixed.** Confirmed with Subh: the settings gear is deliberately scoped to the page the user is currently on, so Settings is meant to stay hidden on Home. The `'home'` branch in `settingsBodyHTML()` is left in place for when Home eventually gets its own settings surface, not treated as a bug.
2. **Fixed.** RED graph's series-identity colors no longer include the warning-severity hex — swapped `#F59E0B` for the spec'd-but-unused `#F472B6`, so a line's color can no longer be mistaken for a severity signal.
3. **Fixed.** Avg Latency KPI card now has its own generated series (`paymentServiceSeries.latencyAvg`, scaled to the same avg/p90 ratio as the static values) instead of reusing the p90 card's data, and its caption now honestly states it's colored via the p90 threshold rather than implying a fake independent one.
4. **Fixed.** `.svc-chip` CSS, `toggleSwitcher()`, and all `switcher-pop` references (in `closePops` and the document click handler) removed — verified via grep (zero remaining matches) and a full interaction-path re-run.
5. **Fixed.** `CubeAPM_Design_Direction_Tokens.md` updated in place: the canvas/surface hierarchy inversion, the 6/9/10/12 radius scale, and JetBrains-Mono-for-KPI-numerals are now documented as ratified amendments with a stated rationale, and a new hard rule was added against reusing semantic status colors in the chart series-identity palette (directly citing the bug just fixed in #2, so it doesn't recur).
6. **Fixed.** Added `title="Status: <value>"` to every color-only status signifier — Home's Detail table dots (already had a text badge, added the title for consistency), Health tab dots and history blocks (previously had no text backup at all), the service-view sidebar dots, and the search-panel result dots.
7. **Still open, by design** — Logs' manual-Search-click bug and the SLO threshold-miscalibration flag remain out of this artifact's scope (they belong to pages not yet built). Carrying them forward onto the phased-proposal doc (task #24) so they aren't lost before the founder sees the plan.

All fixes were re-verified by re-running the syntax check and the full interaction-path harness (nav collapse, service switching, all home tabs, RED table/graph toggle, filters, settings drawer per context, search open/type/keyboard-nav) after the edits — everything still executes without throwing.
