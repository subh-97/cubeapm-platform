# CubeAPM vs. New Relic — UX Architecture Benchmark & Middle-Path Recommendation

*Synthesized from `newrelic-ux-teardown.md` (57 sections crawled) and `cubeapm-ux-teardown.md` (21 sections crawled), both built on the same fixed teardown template so their findings are directly comparable. Goal: identify what each platform has that the other doesn't, judge which architecture is actually easier to use, and propose a middle path CubeAPM can build using offerings it already has.*

## 1. Side-by-side Benchmarking Data Sheet

| Metric | New Relic | CubeAPM |
|---|---|---|
| Total top-level offerings | ~40 (13 pinned + ~27 long-tail) | 14 |
| Total distinct pages/sections crawled | 57 | 21 |
| Max nav depth (home → deepest page) | 4 clicks | 3 clicks |
| Primary nav pattern | Hybrid: persistent sidebar (13 pinned) + ⌘K command palette + separate tile-grid catalog for the long tail | Single 14-icon left rail, no labels, no command palette, no breadcrumb |
| Offerings with a clear single-hub dependency | 6 of 13 pinned items share one entity-explorer engine | 0 of 14 — no shared hub component |
| Avg. steps-to-value (rough) | ~2.7 steps | ~1.6 steps |
| Consistent affordance system? | Mostly yes — hover-highlighted rows are a real convention; broken once (Kubernetes dashboard drill-in) | Partially — sortable-column arrows are consistent; filter paradigm and manual-Search requirement are both inconsistent across similar offerings |
| Notable accessibility gaps | 1 pattern flagged (silently-hanging loading states) | 3 patterns flagged (icon-only status glyphs, unlabeled chart color transitions, an orphaned unlabeled text element) |

**First read of the numbers:** CubeAPM's raw numbers look *better* — fewer clicks to value, a smaller surface area, a lot less to gate/hide. But those numbers are flattering CubeAPM for the wrong reason: it has less because it *offers* less, and its per-offering internal consistency is measurably worse (3 accessibility gaps vs. 1, "partially consistent" affordances vs. "mostly consistent"). Fewer offerings didn't buy CubeAPM more polish — the polish problem exists independently of scope. That distinction drives most of what follows.

## 2. Offering-by-Offering Feature Parity

### Present on both, comparable maturity

| Capability | New Relic | CubeAPM | Note |
|---|---|---|---|
| APM / per-service performance | `/nr1-core` entity explorer | APM (Overview/RED/Detail/External/DB/Errors/Traces/Runtime) | CubeAPM's APM is actually *more* feature-dense per click — New Relic spreads similar detail across scrolling within one entity page, CubeAPM stages it into 8 sub-tabs |
| Logs | Dedicated query UI | Dedicated query UI (facet sidebar) | CubeAPM's facet-based filtering is arguably more discoverable than New Relic's NRQL-first approach for non-power-users |
| Traces | Dedicated tracing UI | Dedicated tracing UI + waterfall | Comparable; CubeAPM's "Check Logs" cross-link from a trace is a genuine parity/edge case win — a specific, well-executed pattern |
| Infrastructure | `/nr1-core`, filtered to hosts | Dedicated Infrastructure page, category-tree sidebar | CubeAPM's inline progress-bar table cells are a nicer per-host visual than anything documented in New Relic's equivalent |
| Alerts | Policy/condition list | Grouped rule list | New Relic's structure (policy → conditions → incidents) is a level deeper and more expressive than CubeAPM's flat group → rules → firing count |
| Dashboards | Dashboard hub | Dashboard list/editor | Comparable in concept; CubeAPM's is thinner (this crawl found a completely blank list with zero empty-state guidance) |
| Ad-hoc query/explore | Data Explorer (NRQL-first) | Explore (Quick/Advanced/Code, form-first by default) | **CubeAPM's default UX here is actually better** — leading with a visual form and staging raw code behind "Advanced/Code" is friendlier to newer users than New Relic's raw-NRQL-first approach |
| Errors | Errors Inbox (cross-service aggregation) | Error Tracking (grouped by endpoint+exception) | Comparable grouping strategy; New Relic aggregates across the whole platform by default, CubeAPM's grouping is service/endpoint-scoped from the start |

### Present on New Relic, missing (or only partially present) on CubeAPM

- **Onboarding/maturity hub** (New Relic's "Recommendations" — Basic/Core/Full-platform-user checklist). CubeAPM has nothing equivalent anywhere in its 14 offerings; there's no guided "what should I set up next" surface at all.
- **Command palette / global search** (⌘K on New Relic). CubeAPM has no global search of any kind — every navigation is a cold start from the icon rail.
- **Cost intelligence** (New Relic's Cloud Cost Intelligence, even though plan-gated). CubeAPM has no cost-correlation feature anywhere in this crawl.
- **AI/LLM monitoring** (New Relic's AI Monitoring, Model Performance). Not present in CubeAPM's 14 offerings — a plausible category gap if CubeAPM's customers start shipping LLM-backed services.
- **Security scanning** (New Relic's IAST, Security RX). Not present in CubeAPM.
- **Workload grouping** (New Relic's Workloads — custom cross-entity groupings for a team/project). CubeAPM has no equivalent; its closest analogue (Home's flat service table) can't be customized or grouped.
- **Change tracking / deployment markers** (New Relic's "Change Tracking" offering). Notably, CubeAPM's own APM RPM chart shows an unexplained color transition mid-chart that looks exactly like an undocumented deployment marker — CubeAPM may already be *generating* this signal without *surfacing* it as a labeled feature.
- **Multi-cloud provider explorers** (AWS/Azure/GCP as first-class entities). CubeAPM's Infrastructure page has an AWS/GCP/K8s category tree, but it wasn't confirmed to be as fleshed-out as New Relic's dedicated per-provider explorers.
- **Org-level Teams / role-based access surfaces.** New Relic has a dedicated Teams offering; CubeAPM's closest equivalent (Settings → Teams tab) wasn't deeply examined but sits inside the visually-unstyled Settings page.

### Present on CubeAPM, missing (or handled differently) on New Relic

- **SLO error-budget matrix as a first-class, always-visible offering.** New Relic has "Service Levels" as one of many long-tail tiles; CubeAPM gives SLOs a dedicated rail icon with a dense 7-day burn-down matrix — arguably a more prominent treatment of a concept New Relic buries in its long tail.
- **Synthetic Monitors as a pinned, simple grouped list.** Both platforms have synthetic monitoring, but CubeAPM's is one click from the rail; New Relic's sits in All Capabilities.
- **A single, consistent per-service filter param carried across every page via the URL.** This is a genuine CubeAPM strength with no clearly documented New Relic equivalent — New Relic's entity explorer requires re-selecting/re-filtering per offering more often.
- **Infrastructure Correlation directly inside the APM Overview tab** (host-level CPU/Memory/latency joined with app-layer symptoms, one scroll away from the KPI cards). New Relic's cost/infra correlation lives in a separate, plan-gated Cloud Cost Intelligence tile — CubeAPM already ships something adjacent to this for free, just underexplained visually.

## 3. Information Architecture — Which Is More User-Friendly?

**New Relic's architecture is more scalable but harder to learn from a cold start.** Its real strength — one shared entity concept threading through APM/Infrastructure/Kubernetes/Browser/Mobile/Databases — means that once a user understands "an entity is a thing with golden signals," navigating to any of those six offerings requires no new mental model. But that strength is undermined by IA sprawl: 40+ offerings split across a pinned sidebar and a separate All-Capabilities tile catalog, three different gating mechanics presented with three different messages (upsell CTA / hard "not eligible" / silent redirect), and a "View More" control that didn't cleanly reveal what's behind it even under direct testing. A new user's first 10 minutes in New Relic is a "which of these 40 tiles do I actually need" problem before it's ever a "how do I read this chart" problem.

**CubeAPM's architecture is easier to learn in the first five minutes and harder to trust once you're using it daily.** 14 flat icons, no long tail to get lost in, no gating to decode — the entire IA fits on one screen and a new user can reasonably click through all of it in a few minutes. But every offering re-teaches its own filter pattern (checkbox facets vs. dropdown clusters vs. category tree vs. nothing at all), a bug that makes Logs and Traces *look broken* on first use (populated histogram, empty table, no explanation), KPI cards that never change color regardless of actual severity, and an SLO page that can't distinguish "this is actively getting worse" from "this has been wrong for a week and nobody noticed." These are the kind of problems that erode trust specifically in engineers who are staring at this tool *during an incident* — the exact audience CubeAPM is built for.

**Verdict:** neither is unambiguously better. New Relic wins on architectural coherence at the data layer and on offering breadth; CubeAPM wins on initial learnability and on-page density-per-click. New Relic's failure mode is overwhelm and inconsistent gating; CubeAPM's failure mode is a set of small, sharp reliability/trust cuts that compound specifically in the moments (an incident, a first-time evaluation) where trust matters most.

## 4. The Middle Path — What CubeAPM Should Build, Using What It Already Has

The goal isn't "become New Relic" (that reintroduces New Relic's sprawl problem) or "stay minimal" (that keeps CubeAPM's trust-eroding rough edges). The middle path is: **keep CubeAPM's flat, learnable 14-offering IA, but bring New Relic's two genuinely transferable ideas — a unifying data concept and a guided onboarding surface — into it without adding new top-level nav items.**

### 4.1 Adopt New Relic's "entity" idea, without adding a new offering

CubeAPM doesn't need a 15th icon to get this. The service identifier already threads through Home, APM, Logs, and Traces via the URL — that's 80% of New Relic's "entity" concept already working, just invisibly. Making it *visible* means: a consistent "Service: search-service" chip/breadcrumb rendered identically at the top of every page that's currently scoped to a service (Home row click → APM → Logs → Traces → Infrastructure), so a user always knows what they're looking at and can switch it from any page, the same way New Relic's entity context persists. This uses zero new offerings — it's a shared header component pulled out of what's already implicit in the URL params.

### 4.2 Adopt New Relic's Recommendations page — as a Home tab, not a new offering

New Relic's single best-designed screen is a maturity-tiered onboarding checklist (Basic → Core → Full-platform-user). CubeAPM already has Home's three-tab structure (Detail/Health/Service Graph) — a fourth tab, or a collapsible panel on first login, showing "Basic setup: instrument your first service (done), Core: set an SLO (not done), set an alert rule (2 of 7 services done), Full platform: connect a synthetic monitor" would directly reuse CubeAPM's own existing offerings (APM, SLOs, Alerts, Synthetic Monitors) as the checklist's destinations. This solves CubeAPM's biggest structural gap (no onboarding hub) without adding IA surface area, and it directly counters the "no guidance" pattern seen repeatedly in this crawl (Dashboards' blank list, RUM's bare input, Admin's silent empty state) by giving new users one obvious place to start instead of 14 undifferentiated icons.

### 4.3 Fix the reliability cuts before adding anything new

None of these require new offerings, only fixing what exists:
- Make Logs and Traces behave like Errors — auto-run the default query on load instead of requiring a manual Search click. This is the single highest-leverage fix in the entire teardown: it's reproducible, it's confusing on first contact, and it's inconsistent with a pattern (Errors) that already works correctly in the same product.
- Wire APM's four KPI cards to the same threshold logic already computed for Home's Health-tab status strip and SLOs' budget coloring — the color logic clearly exists somewhere in CubeAPM's system (Health and SLOs both render red/orange/green), it's just not reaching the Overview tab's big numbers.
- Give the SLO matrix a "flat for N days" flag distinguishing chronic threshold miscalibration from an active, worsening burn — this is a labeling/computation addition to an existing page, not a new offering.
- Replace Dashboards' silent blank state and RUM's bare input with the same one-sentence-plus-CTA pattern New Relic uses on Workloads ("Create workloads to group your data... Create your first workload") — CubeAPM's own writing style already does this reasonably well elsewhere (Home, Explore); it just needs to be applied to the two screens that currently say nothing at all.

### 4.4 What NOT to import from New Relic

Do not replicate the All-Capabilities tile-catalog pattern or the three-tiered gating system (upsell/restricted/waitlist) — those exist to manage New Relic's *sprawl*, and CubeAPM doesn't have that problem yet. Do not add a 15th+ icon for cost intelligence, AI monitoring, or security scanning speculatively; those are real category gaps but should wait until there's a concrete customer/product reason to add them, since CubeAPM's flat-rail IA is exactly the kind of structure that degrades fastest once it crosses roughly 15-18 items without some form of grouping (New Relic crossed that line and needed a second-level catalog as a result).

## 5. Priority Ranking for the Redesign

1. **Fix the Logs/Traces manual-Search bug and wire threshold-based KPI coloring** — both are pure bug-fixes to existing offerings, zero new IA, highest trust payoff, directly demonstrable in a Home/Services-Overview artifact.
2. **Add the service-context header/chip that persists across Home → APM → Logs → Traces** — the visible version of New Relic's entity concept, built from data CubeAPM already threads through the URL.
3. **Add a lightweight onboarding/maturity panel to Home** — CubeAPM's version of Recommendations, pointing at APM/SLOs/Alerts/Synthetic Monitors, no new top-level nav item required.
4. **Standardize empty-state copy** (Dashboards, RUM, Admin) to the one-sentence-plus-single-CTA pattern already used well elsewhere in the product.
5. **Only after 1-4:** evaluate whether category gaps (cost intelligence, AI monitoring, security) are worth a new offering, and if so, decide then whether CubeAPM needs its first secondary-nav layer to avoid re-creating New Relic's sprawl.

## Sources

- `newrelic-ux-teardown.md` (this Cube APM folder) — full New Relic crawl, 57 sections
- `cubeapm-ux-teardown.md` (this Cube APM folder) — full CubeAPM crawl, 21 sections
