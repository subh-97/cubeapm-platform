# CubeAPM — UX Review & Recommendations

*Compiled 2026-07-08. Companion to `CubeAPM_Current_State_Platform_Architecture_UX.md` (the factual "as-is" inventory) and `Observability_UX_Competitor_Benchmark.md` (Datadog/New Relic/Grafana/Honeycomb research). This doc is the evaluative layer: what's working, what isn't, why, and what to do about it — prioritized, with the three target redesign screens (Home/no-service, Home→service overview, Logs) called out specifically.*

---

## 1. Top-line assessment

CubeAPM's underlying product is legitimately strong — native OpenTelemetry ingestion, genuinely useful correlated views (Infra Correlation on the APM overview, "Check Logs" cross-link from a trace), and a broad, coherent feature set for its size. The UX problems are not "the product is confusing" so much as **the interface doesn't yet do the work of telling a stressed engineer where to look first.** Every screen assumes the user already knows what they're looking for and roughly where to find it. That matches almost exactly what CubeAPM's own G2 reviewers said ("good UX but the UI can be improved... needs a designer touch") and it's a very fixable class of problem — it's about prioritization, hierarchy, and default states, not a ground-up rebuild.

## 2. Cross-cutting issues (found across multiple screens)

### 2.1 No accessible/labeled navigation
The entire left rail — 14 sections — is icon-only with **no text label, no tooltip on hover, and no `aria-label`/`title` attribute** (confirmed via both visual hover-testing and accessibility-tree inspection). A first-week user has no way to learn the IA except clicking through every icon blind. This fails the most basic discoverability heuristic (Nielsen's "recognition rather than recall") and is also a plain accessibility gap for screen-reader users.
**Fix:** add persistent (or at minimum on-hover) text labels, or an expand/collapse rail like Datadog's and New Relic's, defaulting to labeled for first-time sessions.

### 2.2 Inconsistent filter placement across sections
Filters live in at least three structurally different places depending on which section you're in: a **left faceted-filter rail** (Logs, Traces, Errors), a **left category tree** (Infra), and **top-of-page dropdown clusters** (APM Overview: Service on the left, Category/Host/Version on the right). This directly contradicts the single most important lesson from the competitor research: Datadog's own design-system philosophy states plainly that filtering, time-range scoping, and graph inspection must work identically everywhere, because users build muscle memory and expect to reuse it. Right now, muscle memory built on Logs doesn't transfer to APM.
**Fix:** pick one filter pattern (a collapsible left rail is the most scalable for CubeAPM's data density) and apply it to every data-exploration screen, including APM Overview.

### 2.3 "Query already there, but nothing happens until you click Search"
Reproduced on both Logs and Traces: the histogram populates on page load, but the results table stays empty until the user manually clicks Search — despite a default `*` query already sitting in the box. There's no visual signal (no "press Search to run," no auto-run) explaining why the table looks blank. A new user's most likely read of this is "the tool is broken" or "there's no data," not "I need to click a button that already looks satisfied."
**Fix:** either auto-run the default query on page load (simplest fix, matches user expectation set by the histogram already having loaded), or add a one-time inline hint ("Press Search or ⏎ to run this query") until the user has run a search at least once.

### 2.4 No conditional/threshold-based color coding on KPI numbers
On the APM Overview, all four big-number stat cards (RPM, p90, Avg Latency, Error %) render in the same flat green regardless of whether the underlying value is actually healthy. In our trace, a service with 230ms p90 latency and 0.08% errors displayed in identical styling to one with 12ms latency and 0% errors. Color in a monitoring tool is a primary signal — using it decoratively rather than semantically wastes the highest-bandwidth channel available on the screen.
**Fix:** thresholds per metric (configurable per-service or system-default) that shift number color/background from green → amber → red, exactly as already correctly implemented in the SLO grid and the Home Health strip — the pattern already exists elsewhere in the product, it just isn't applied consistently.

### 2.5 Home screen's default view doesn't answer "is anything wrong"
This is the most important finding, and the one the redesign brief already anticipated. Home currently defaults to the **Detail** tab: a flat, alphabetically-sorted table with no severity grouping. The far more useful **Health** view (a color-coded status-heatmap strip per service) exists but is one un-labeled click away and isn't the default. Compare this to New Relic's "All Entities" — explicitly designed as a health-at-a-glance landing view — or Datadog's sidebar surfacing "recently accessed" + Watchdog anomalies right at the top. CubeAPM has the right building block (Health view) already built; it's just not in the position of highest leverage.
**Fix:** detailed in Section 3 below.

### 2.6 Weak or missing empty states
RUM's landing screen is a blank canvas with a single "Select Service" box and zero explanatory content — no illustration, no "here's what you'll see once you pick a service," no suggested starting point. Compare to Grafana's or Honeycomb's practice of showing a sample/demo view or an explicit "get started" card in empty states. An empty state is a free onboarding opportunity that's currently being spent on nothing.
**Fix:** every empty state should answer three questions in place: what goes here, why it's empty right now, and what action fills it.

### 2.7 Settings feels like a different, unfinished product
The Settings screen (Profile/Teams/Preferences/Change Password) uses plain unstyled form rows with no card containers or spacing rhythm, next to a bare red Logout button — a visual style completely disconnected from the density and polish of Traces, SLOs, or the trace waterfall. This is exactly the kind of drift a documented design system (Datadog's DRUIDS, Grafana's Saga) is built to prevent: one shared token/component set applied everywhere, including the "boring" admin screens, not just the flagship data views.

## 3. Screen-specific recommendations

### 3.1 Home — no service selected ("is anything wrong right now?")

**Current:** flat alphabetical table, Detail tab as default, severity only visible as a thin bar under Error Rate %.

**Recommended direction:**
- Make a **health-first summary the default view**, not a third tab discovered by accident. Borrow directly from New Relic's All-Entities pattern: a top strip of aggregate counts ("7 services · 1 degraded · 0 down") before any per-row detail, so the very first thing rendered is a yes/no answer.
- Re-sort the default table (or default Health view) **by severity, not alphabetically** — worst-behaving service first. Alphabetical order is appropriate as a secondary/explicit sort option, never the default on a health-triage screen.
- Keep the existing Health-strip visualization (it's a genuinely good pattern, comparable in spirit to Datadog's Watchdog anomaly surfacing) but promote it to be the primary/default tab, with Detail (the flat metrics table) and Service Graph as secondary views for when a user already knows what they're drilling into.
- Add a single persistent "N unhealthy" badge on whichever tab isn't currently active, so switching tabs doesn't lose the signal.

### 3.2 Home → single service selected, performance overview

**Current:** four flat-green KPI cards, an empty Latency Drilldown panel, three separate trend charts, Slow Requests, Infra Correlation — all correct content, presented with no visual hierarchy or conditional emphasis.

**Recommended direction:**
- Apply threshold-based coloring to the four KPI cards (Section 2.4) so the overview screen itself communicates health before the user reads a single number.
- Add a small inline delta/comparison ("vs. previous hour") to each KPI card — every competitor benchmark studied (Datadog, New Relic) treats "is this getting better or worse" as core information, not an advanced feature.
- Visually promote **Infrastructure Correlation** — currently styled identically to every other plain table in the product, despite being one of CubeAPM's more distinctive analytical features (app symptom ↔ host correlation in one view, without needing a separate infra dashboard). This is the closest thing CubeAPM has today to a "signature feature" in the Honeycomb-BubbleUp sense — worth deliberately designing rather than leaving as a default table.
- Unify the filter pattern here with Logs/Traces (Section 2.2) rather than the current two-cluster top-dropdown layout.

### 3.3 Logs

**Current:** left facet rail + top query bar + histogram + table, but requires a manual Search click even with a pre-filled default query.

**Recommended direction:**
- Auto-run the default query on load (Section 2.3) so the histogram and table populate together — removes the single biggest "is this broken?" moment in the product for new users.
- Keep the histogram-above-table layout (this part is genuinely solid and matches both Datadog's and Grafana Explore's log-search conventions) but consider a persistent legend for the level-color coding (info/warn/error) rather than relying on the small counts list to the right, which is easy to miss at smaller viewport widths.
- The inline "Stream" tag block under each row (env, k8s.namespace.name, log.level, service, etc.) is dense and effective for power users, but could benefit from a "Fields" column-selection default that surfaces the 2–3 most diagnostic tags per row rather than all of them — reduce visual noise for a first-time reader while keeping the full detail available on click (progressive disclosure, same principle Honeycomb applies to keep BubbleUp's output scannable).
- Give "Top Patterns" (log clustering) more visual prominence — it's a strong differentiator relative to a plain grep-style log viewer and is currently a same-weight button next to "Fields," easy to overlook.

## 4. What to explicitly borrow from each competitor (recap, applied to CubeAPM)

- **From Datadog:** one consistent interaction grammar for filtering/time-range/drill-in, enforced by a real internal design system (component library + written contribution rules), not ad-hoc per-team decisions — this is the actual root cause of CubeAPM's Section 2.2 inconsistency.
- **From New Relic:** the "All Entities" health-first home view, and the dual entry-point model (visual builder + raw query) — CubeAPM's Explore screen already has the bones of this (Quick/Advanced/Code tabs); it just needs the same duality applied to Logs' query experience.
- **From Grafana:** the "Saga" design-system principles (Universal, Accessible, Flexible, Coherent, Defined, Distinct) are a ready-made charter CubeAPM could adopt near-verbatim for whatever design system comes out of this engagement — and Grafana's own biggest weakness (blank-canvas dashboards requiring the user to already know what "good" looks like) is a warning against over-indexing on customization for CubeAPM's default views.
- **From Honeycomb:** invest asymmetrically in one flagship investigative feature rather than spreading polish evenly. Infrastructure Correlation (Section 3.2) is CubeAPM's best current candidate for this treatment.

## 5. Priority roadmap

**Quick wins (low effort, high impact, no new components needed):**
1. Auto-run default Logs/Traces query on load.
2. Add text labels/tooltips to the left icon rail.
3. Re-sort Home's default table by severity instead of alphabetically.
4. Apply existing threshold-color logic (already built for SLOs/Health) to APM Overview's KPI cards.

**Structural (need a small design-system foundation first):**
5. Unify filter placement/pattern across APM, Logs, Traces, Errors, Infra.
6. Promote Health view to Home's default tab, with an aggregate status strip.
7. Design real empty states (RUM and any other blank-canvas screens) with explanatory content and a clear next action.
8. Bring Settings/Admin visual style in line with the rest of the product using shared tokens/components.

**Signature investment (needs dedicated design exploration):**
9. Elevate Infrastructure Correlation into a distinctive, purpose-built visualization rather than a generic table — CubeAPM's answer to Honeycomb's BubbleUp.

## Sources / method

Findings are based on direct, hands-on navigation of `https://playground.cubeapm.com/` (sandbox data) on 2026-07-08, cross-referenced with `Observability_UX_Competitor_Benchmark.md` (Datadog DRUIDS/nav redesign blog posts, New Relic UI redesign blog + docs, Grafana Saga design system + Nilson Gaspar case study, Honeycomb BubbleUp design process) and general usability heuristics (Nielsen Norman Group's 10 usability heuristics, particularly recognition-over-recall, consistency and standards, visibility of system status, and error prevention).
