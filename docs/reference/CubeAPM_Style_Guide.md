# CubeAPM Redesign — Lightweight Style Guide (v1)

*Extracted directly from the working artifact (`cubeapm-redesign/cubeapm_home_artifact.html`) after the internal design critique and its fixes — this is the actual, running implementation, not a re-statement of intentions. Treat this as the seed for the Figma design system (task #27) and the reference for building every subsequent screen (Logs, Traces, SLOs, etc.) so they inherit the same primitives instead of re-inventing them. Supersedes `CubeAPM_Design_Direction_Tokens.md` wherever the two disagree — that doc has been amended in place to match, but this file is organized for quick lookup while building, not for narrating decisions.*

## 1. Color tokens

### Surfaces (dark mode — the only mode this artifact builds)

| Token | Hex | Use |
|---|---|---|
| `--canvas` | `#151820` | App background — the gutter behind the nav and around the main body card |
| `--card` | `#080B11` | The one large body "surface card," plus every nested panel/table/KPI card inside it |
| `--panel` | `#171C28` | Inputs, search bar, tab bar background, nav-item hover fill |
| `--panel-2` | `#1B2130` | Row hover, dropdown-item hover, active view-toggle state |
| `--raised` | `#1E2431` | Popovers, dropdown panels, the settings drawer's own surface, search-empty icon backgrounds |
| `--border-subtle` | `#232B3B` | Table row dividers, panel-internal separators |
| `--border-panel` | `#2A3346` | Card/panel outer borders, input borders |
| `--border-strong` | `#39445C` | Hover/active emphasis borders |

Note: canvas is a *mid-tone gutter*, and the card/panel tone nested inside it is *darker* — this hierarchy is intentionally inverted from a naive "canvas is darkest" assumption. Don't flatten it back without a deliberate decision.

### Text

| Token | Hex | Use |
|---|---|---|
| `--text-primary` | `#F1F3F9` | Headings, primary values, active states |
| `--text-secondary` | `#9CA6BF` | Labels, secondary metadata, hover states |
| `--text-muted` | `#616C86` | Placeholders, disabled, captions, hints |

### Brand & accent

| Token | Hex | Use |
|---|---|---|
| `--brand` | `#3B82F6` | Primary actions, active nav/tab indicator, focus ring |
| `--brand-muted` | `#182A4E` | Active-state background fill (nav items, tabs, sidebar rows, dropdown selection) |
| `--accent` | `#8B5CF6` | Onboarding panel only — sparingly used, not a general-purpose color |

### Semantic status (the single most load-bearing rule in this system)

| Token | Hex | Use |
|---|---|---|
| `--healthy` | `#22C55E` | Green |
| `--warning` | `#F59E0B` | Amber |
| `--critical` | `#EF4444` | Red |
| `--info` | `#60A5FA` | Neutral informational (used for the "total services" summary pill) |
| `--neutral` | `#616C86` | No data / not applicable |

**Hard rule:** every status dot, badge, KPI card border/value, health-strip block, and graph node resolves its color through `statusForLatency()` / `statusForErrorRate()` / `worstStatus()` — never a hardcoded color. This is the one rule that must never regress; it's the direct fix for the "all KPI cards render the same green" finding from both platform teardowns.

**Hard rule #2 (added after a real bug):** the semantic status colors above must never appear in a *chart series-identity* palette (see §5). A line's color in a multi-series chart identifies *which thing it is*, not *how severe it is* — mixing the two channels means a series can look "critical" purely because of array order.

## 2. Typography

- **UI text:** `Inter`, fallback `-apple-system, Segoe UI, sans-serif`. Body text is 13px/1.45.
- **Numerals & code:** `JetBrains Mono` — used for: trace/span IDs, KPI card headline values (`.kpi-card .val`), table cell numerics that benefit from tabular alignment (drilldown legend values, RED endpoint legend values), and the search result item name. `font-variant-numeric: tabular-nums` is set globally on `<body>` as a backstop.
- **Scale in actual use** (not a formal type-scale table, but what's in the CSS today):

| Size | Weight | Where |
|---|---|---|
| 30px | 600 | KPI card headline value |
| 25px | 700 | Summary-strip pill number |
| 20px | 700 | Chart-card value |
| 15px | 600 | Header page title |
| 14px | 600 | Drawer title, breadcrumb current-page |
| 13–13.5px | 500–600 | Panel headers, tab labels (active), pop-name |
| 12–12.5px | 400–500 | Table cells, filter labels, most body text |
| 10–11.5px | 400–700 | Captions, hints, badges, legend labels |

## 3. Spacing & radius

- Radius: `--radius-sm: 6px` (inputs, badges, nav items), `--radius-md: 9px` (cards, popovers), `--radius-lg: 10px` (panels, KPI cards, modals), `--radius-card: 12px` (the one outer surface card).
- Grid gaps in active use: `12–14px` between sibling cards (KPI grid, summary strip, charts row), `16px` internal card padding, `20px` margin-bottom between stacked panel sections.
- Nav width: `222px` expanded, `66px` collapsed (icon-only), with a `.16s` width transition and a hover-to-expand behavior while collapsed.

## 4. Layout primitives

**App shell:** `.app` is a flex row — `.nav` (fixed width) + `.main` (flex:1). `.main` contains `.header` (transparent, sits on the canvas) and one `.surface-card` (the single large rounded card everything else lives inside). This "one big card floating in a canvas gutter" pattern is the core layout idea — don't introduce a second competing card-on-canvas pattern elsewhere without a reason.

**Nav:** grouped into labeled sections (`NAV_GROUPS`: Workspace / Analyze / Manage) rather than one flat list. Each item is icon + text label (never icon-only without a label — direct fix for the "14 unlabeled icons" finding). Disabled items get `opacity:.42`, no hover state, and no `tabindex` (so keyboard users can't tab into a dead control).

**Header:** page icon+label (left) → flexible spacer → search (grows, capped width) → fixed-width right-side controls (refresh, time range, settings*, help, avatar). *Settings is deliberately hidden on Home — it's scoped to "the page the user is on," not a bug.

**Service Overview page:** breadcrumb (`.card-crumbs`) → tab strip + filter row (`.subtab-row`, sits inside the card) → a persistent left `.svc-sidebar` listing every service (this is what makes the current service "visible everywhere," the artifact's answer to New Relic's entity-context idea) → main scrollable content.

## 5. Components

**Buttons (`.hbtn`):** panel background, subtle border, icon-only variant just changes padding. `.active` state uses `--panel-2` + `--border-strong`. No filled/primary button style exists yet except `.time-apply` and `.search-empty-clear` (both solid `--brand`) — if a primary CTA button component is needed elsewhere, extend from those two, don't invent a third pattern.

**Inputs / search:** `.search-input` is panel-background, icon-prefixed, brand-colored focus ring (`box-shadow: 0 0 0 3px rgba(59,130,246,.14)`) — reuse this exact focus treatment on any new text input rather than the default browser outline.

**Dropdowns / portals (`.dd-panel`, time-range panel, search panel):** all portal-rendered to a fixed-position div outside the normal DOM flow, clamped to the viewport edge so they never overflow off-screen. This is the pattern to reuse for any future dropdown — don't build a new one as a normal in-flow absolutely-positioned child, the viewport-clamping logic is what makes these reliable at different screen widths.

**Tabs (`.tabbar` / `.tab`):** compact pill-style, `--panel` background track, active tab gets `--brand-muted` fill + bold weight. Used identically for Home's Detail/Health/Service Graph and the service page's Overview/RED/External/etc. — this consistency (one tab pattern, reused everywhere) is a direct implementation of the "one filter/interaction pattern reused across screens" core UX rule.

**Tables:** right-aligned numeric columns, left-aligned first column, `--border-subtle` row dividers, row hover = `--panel-2`, sortable headers get a `▾` arrow glyph. Status-carrying cells use `.val-critical` / `.val-warning` text color classes, never a raw hex.

**Status signifiers (`.status-dot`, `.health-block`, `.graph-node`, `.badge`, `.kpi-chip`):** every one of these now carries a `title="Status: <word>"` attribute alongside its color, so severity is never communicated by color alone. Carry this forward to any new status-bearing element.

**KPI cards (`.kpi-card`):** label + chip (status word, e.g. "↑ Critical") + headline value (mono, colored by status) + sparkline + a threshold caption. Each of the 4 cards must be backed by its own distinct data series — reusing another card's series (the Avg Latency bug that was fixed) is exactly what this pattern must not do again.

**Panels (`.panel`):** the general-purpose "card with a header row" container — used for tables, the drilldown, slow requests, infra correlation, RED tab. `.panel-head .hint` is the standard place for a one-line explanatory caption; use it instead of a separate tooltip component for simple context.

**Incident banner (`.incident-banner`):** left-border-accented, color keyed to severity, surfaces the demo data's root-cause note as a first-class element. This is the pattern to reuse any time a service/page needs to surface an active-problem explanation rather than burying it in a tooltip.

**Settings drawer:** slide-in from the right, per-context tab set (`settingsTabsForContext()` branches on `state.view`/`state.serviceSubTab`). If a new page gets its own settings, follow this same pattern — a new branch in that one function — rather than a bespoke settings UI per page.

**Search panel:** results grouped under a section label ("RESULTS" or "LAST VIEWED"), keyboard-navigable (arrow keys + Enter), with a real empty state (icon + message + a "Clear search" recovery action) rather than a blank list.

## 6. Iconography

Hand-drawn inline SVG icon set (`ICONS` object, `icon(name, cls)` helper) — 24x24 viewbox, `stroke="currentColor"`, `stroke-width="2"`, no external icon library dependency (deliberate, since this session had no CDN access — if a future build restores network access, swapping to `lucide-react` per the original tokens doc is fine, but keep the same visual weight/stroke style). Every icon-bearing control must ship with a visible text label or a `title`/`aria-label` — no icon-only controls without one.

## 7. Interaction & accessibility conventions

- `:focus-visible` gets an explicit `2px solid var(--brand)` outline globally — don't suppress focus outlines on custom controls.
- `@media (prefers-reduced-motion: reduce)` disables all transitions/animations — keep this rule if new animated components are added.
- Disabled interactive elements omit `tabindex` entirely rather than using `tabindex="-1"` inconsistently — keep using this approach.
- Charts render via Recharts (CDN) when available, and fall back to a hand-rolled inline SVG line/area chart (`svgFallback`) when the CDN can't load — build any new chart the same defensive way rather than assuming network access.

## 8. Known open items (not yet reconciled)

- `.search-wrap`'s fixed `520px` width doesn't fully collapse under the `720px` mobile breakpoint (low severity, flagged in the critique doc, not yet fixed).
- This guide covers Home + Service Overview only. Logs, Traces, SLOs, Alerts, and Synthetic Monitors haven't been built yet — when they are, extend this guide rather than starting a parallel one.
