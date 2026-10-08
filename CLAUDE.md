# CubeAPM Platform — Claude Code Context

## What this is
CubeAPM is an open-source application performance monitoring (APM) platform. This repo is the **redesigned frontend** — a ground-up rebuild of the UI layer, keeping the same backend/API. The redesign was driven by a comprehensive UX teardown of both CubeAPM and New Relic, and a detailed benchmark analysis.

## Tech stack
- **Vite + React 18 + Tailwind CSS 3**
- **React Router 6** for client-side routing
- **Recharts** for time series charts (install with `npm install`)
- **Lucide React** for icons (24x24, stroke-based, always paired with text labels)
- **clsx** for conditional classnames
- Path alias: `@/` → `src/`

## Getting started
```bash
npm install
npm run dev   # runs on localhost:3000
```

## Architecture

### App shell
`AppShell.jsx` is a flex row: fixed-width sidebar + flex-1 main area. Main has a transparent header on the canvas gutter, and one large surface card (`bg-card`, `rounded-card`) that everything lives inside. This "one floating card" pattern is the core layout — don't introduce a second card-on-canvas pattern.

### Routing
All routes are children of `<AppShell />` via `<Outlet />`:
- `/` → HomePage (services dashboard)
- `/traces` → TracesPage
- `/logs` → LogsPage  
- `/metrics` → MetricsPage
- `/alerts` → AlertsPage
- `/settings` → SettingsPage

The sidebar starts with Home, then follows the production app's list: APM & Services (a service's APM page), Logs, Infra, Browser, Traces, MTraces, Profiles, Errors, Mobile, Dash, Explore, SLO, Alerts, Monitors. Items not built yet (Browser, MTraces, Profiles, Mobile, Dash, SLO, Alerts, Monitors) are stubbed with `opacity-.42` and no click handler.

### Data layer
Mock data in `src/data/`, generated as a function of the selected time range rather than stored flat. `src/utils/timeRange.js` models the range (`{kind:'preset'}` or `{kind:'absolute'}`, owned by `App`); `src/data/timeWindow.js` turns it into a window and samples one shared incident profile for every series, aggregate and level mix. Last 1 hour reproduces the published figures exactly; wider ranges dilute the incident, and p90 falls off a cliff where a mean would fade. See `docs/decisions/time-range-windowing.md`. Every service has RED metrics (Rate, Error, Duration) computed through status resolution functions. Replace with real API calls when integrating with the CubeAPM backend.

## Design system — non-negotiable rules

### 1. Status colors are NEVER hardcoded
Every status dot, badge, KPI value, health block, and graph node resolves color through `statusForLatency()`, `statusForErrorRate()`, or `worstStatus()` in `src/utils/status.js`. Never write a raw hex for a status color — always go through the status functions.

### 2. Status colors must NEVER appear in chart series palettes
A line's color in a multi-series chart identifies *which thing it is*, not *how severe it is*. Use the chart palette (blues, purples, teals) for series identity. Red/amber/green are reserved exclusively for severity.

### 3. Services sort by severity, not alphabetically
The Home page service list and any service selector must sort critical → warning → healthy. Alphabetical sorting was the #1 UX finding — it buries incidents.

### 4. No icon-only controls without labels
Every icon-bearing interactive element must have a visible text label or `title`/`aria-label`. The current CubeAPM has 14 unlabeled sidebar icons — this was the #2 UX finding.

### 5. Auto-load data, never "click Search to see anything"
Logs and Traces pages must auto-run the default query on mount. The current CubeAPM shows a blank screen with a Search button — this is the #3 UX finding.

### 6. Comparison context on every metric
"612ms" alone is meaningless. Always show the delta vs. previous period where the data supports it. This is the "smarter, not prettier" principle.

## Color tokens (dark mode — the only mode built so far)

### Surfaces
| Token | Hex | Tailwind class |
|---|---|---|
| Canvas (gutter) | `#151820` | `bg-canvas` |
| Card (surface) | `#080B11` | `bg-card` |
| Panel | `#171C28` | `bg-panel` |
| Panel hover | `#1B2130` | `bg-panel-2` |
| Raised (popovers) | `#1E2431` | `bg-raised` |

Note: canvas is MID-TONE, card is DARKER — intentionally inverted for floating-card effect.

### Borders
| Subtle | `#232B3B` | `border-border-subtle` |
| Panel | `#2A3346` | `border-border-panel` |  
| Strong | `#39445C` | `border-border-strong` |

### Text
| Primary | `#F1F3F9` | `text-text-primary` |
| Secondary | `#9CA6BF` | `text-text-secondary` |
| Muted | `#616C86` | `text-text-muted` |

### Brand
| Brand | `#3B82F6` | `text-brand` / `bg-brand` |
| Brand muted | `#182A4E` | `bg-brand-muted` |

### Semantic status
| Healthy | `#22C55E` | `.status-healthy` / `bg-status-healthy` |
| Warning | `#F59E0B` | `.status-warning` / `bg-status-warning` |
| Critical | `#EF4444` | `.status-critical` / `bg-status-critical` |
| Info | `#60A5FA` | `.status-info` / `bg-status-info` |

## Typography
- **UI text:** Inter, 13px/1.45 body default
- **Numerals/code:** JetBrains Mono — KPI values, trace IDs, table numerics
- `font-variant-numeric: tabular-nums` set globally

## Component patterns

### Shared components (in `src/components/shared/`)
- **Panel** — card with header row, used for every data section
- **DataTable** — sortable, right-aligned numerics, status-colored cells
- **TabBar** — compact pill tabs, one pattern everywhere
- **KpiCard** — label + status chip + mono value + sparkline + threshold
- **StatusDot** / **StatusBadge** — always resolve through status utils
- **IncidentBanner** — left-border severity accent, surfaces root cause prominently
- **EmptyState** — icon + title + description + action

### Layout components (in `src/components/layout/`)
- **AppShell** — flex row layout wrapper
- **Sidebar** — grouped nav (Workspace/Analyze), collapse/expand
- **Header** — page title, search, time range, controls
- **Logo** — inline SVG brand assets (icon + wordmark)

## Key research findings driving this design
1. Current CubeAPM sorts services alphabetically → incidents get buried
2. All KPI cards render the same green → no severity signal
3. 14 sidebar icons with no text labels → high cognitive load
4. Logs/Traces show blank screen until user clicks Search → data exists but isn't surfaced
5. No incident banner → root cause is hidden in nested views
6. Infrastructure Correlation is CubeAPM's most unique feature but rendered as a generic table
7. No comparison context on metrics → "612ms" means nothing without "↑4.4× vs last hour"

## Files NOT to edit without understanding context
- `src/utils/status.js` — status resolution logic, load-bearing for the entire UI
- `tailwind.config.js` — all design tokens live here, matched to the style guide
- `src/data/` — mock data, intentionally includes one critical service (payment-service) to demonstrate severity-driven sorting and incident banners
- `src/data/timeWindow.js` — the incident profile and window aggregation every other data module is calibrated against

## Reference docs (in `docs/reference/`)
- `docs/reference/CubeAPM_Style_Guide.md` — full token reference
- `docs/reference/CubeAPM_vs_NewRelic_UX_Benchmark.md` — competitive analysis driving the redesign
- `docs/reference/CubeAPM_UX_Review_and_Recommendations.md` — complete UX findings
- `docs/reference/CubeAPM_Artifact_Design_Critique.md` — internal design review of the prototype

## Design decisions (in `docs/decisions/`)
Decisions worth not re-deriving. Read the relevant one before reworking that area.
- `docs/decisions/facet-interaction-datadog.md` — split-row facet control; facet admission tests value shape, not a cardinality ratio
- `docs/decisions/query-builder-phase8.md` — what has shipped on the Logs query builder, and the one piece that hasn't (URL state sync)
- `docs/decisions/time-range-windowing.md` — how the time range drives the data: one incident profile, the one-hour calibration, and why a percentile behaves differently from a mean as the window widens
- `docs/decisions/errors-page.md` — the `/errors` page: filter series then group, the errors variant of the query builder, the URL dialects it reads, and how it hands off to Traces and the service page

`docs/HANDOFF.md` describes where the project stands overall.

## Working agreements
- **Don't commit or push to `main`.** Stop after making changes and describe them; the user handles committing, opening PRs, and merging. Work on a branch and open a PR when asked to commit.
