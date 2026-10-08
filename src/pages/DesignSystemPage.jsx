import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { clsx } from 'clsx'
import {
  Palette, Boxes, Search, Bell, RefreshCw, HelpCircle, Settings, Inbox,
  ArrowLeft, Check, Sun, Moon,
} from 'lucide-react'
import { LogoIcon, LogoWordmark } from '@/components/layout/Logo'
import { resolveTheme } from '@/hooks/useTheme'
import KpiCard from '@/components/shared/KpiCard'
import StatusDot from '@/components/shared/StatusDot'
import StatusBadge from '@/components/shared/StatusBadge'
import Panel from '@/components/shared/Panel'
import DataTable from '@/components/shared/DataTable'
import TabBar from '@/components/shared/TabBar'
import IncidentBanner from '@/components/shared/IncidentBanner'
import EmptyState from '@/components/shared/EmptyState'
import Sparkline from '@/components/charts/Sparkline'

/* ============================================================================
   Reference data — mirrors the three-tier token cascade defined in index.css.
   ========================================================================== */

const PRIMITIVES = [
  {
    group: 'Neutral ramp · slate',
    desc: 'A blue-tinted grayscale. Every surface, border and text color is drawn from here.',
    tokens: [
      ['--slate-950', '#080B11'], ['--slate-925', '#14161E'], ['--slate-900', '#151820'],
      ['--slate-880', '#171C28'], ['--slate-870', '#1A2130'], ['--slate-860', '#1B2130'],
      ['--slate-840', '#1E2431'], ['--slate-800', '#232B3B'], ['--slate-750', '#2A3346'],
      ['--slate-700', '#39445C'], ['--slate-600', '#616C86'], ['--slate-400', '#9CA6BF'],
      ['--slate-100', '#F1F3F9'],
    ],
  },
  {
    group: 'Blue · brand',
    desc: 'Primary action, focus and active-state hue plus its tints.',
    tokens: [
      ['--blue-200', '#CFE0FF'], ['--blue-400', '#60A5FA'], ['--blue-450', '#4F8FF7'],
      ['--blue-500', '#3B82F6'], ['--blue-600', '#2563EB'], ['--blue-950', '#182A4E'],
    ],
  },
  {
    group: 'Violet · accent',
    desc: 'Onboarding and walkthrough moments only — never severity.',
    tokens: [['--violet-500', '#8B5CF6'], ['--violet-950', '#2D1B69']],
  },
  {
    group: 'Status hues',
    desc: 'Reserved exclusively for severity. Each pairs a base hue with an on-tint foreground.',
    tokens: [
      ['--green-500', '#22C55E'], ['--green-300', '#6EE7A5'], ['--amber-500', '#F59E0B'],
      ['--amber-300', '#FFD079'], ['--red-500', '#EF4444'], ['--red-300', '#FF9C9C'],
    ],
  },
]

const SEMANTIC = [
  ['--canvas', '--slate-900', 'App gutter / page background — deliberately mid-tone'],
  ['--card', '--slate-950', 'The single floating surface card (darker than canvas)'],
  ['--panel', '--slate-880', 'Inset panels, inputs, chips'],
  ['--panel-2', '--slate-860', 'Row hover, pressed panel'],
  ['--raised', '--slate-840', 'Popovers, dropdowns, drawers, toast'],
  ['--border-subtle', '--slate-800', 'Hairline dividers inside a panel'],
  ['--border-panel', '--slate-750', 'Panel & control borders'],
  ['--border-strong', '--slate-700', 'Hover / emphasized borders'],
  ['--text-primary', '--slate-100', 'Headings, values, primary copy'],
  ['--text-secondary', '--slate-400', 'Labels, secondary copy'],
  ['--text-muted', '--slate-600', 'Captions, placeholders, meta'],
  ['--brand', '--blue-500', 'Primary actions, focus, active accent'],
  ['--brand-muted', '--blue-950', 'Active nav / tab / row background'],
  ['--accent', '--violet-500', 'Onboarding & walkthrough accent'],
  ['--accent-muted', '--violet-950', 'Accent surface'],
  ['--healthy', '--green-500', 'Severity: healthy (never for identity)'],
  ['--warning', '--amber-500', 'Severity: warning'],
  ['--critical', '--red-500', 'Severity: critical'],
  ['--info', '--blue-400', 'Informational, neutral notices'],
  ['--neutral', '--slate-600', 'No-data / disabled severity'],
]

const COMPONENT_TOKENS = [
  ['--brand-hover', '--blue-450', 'Primary button / link hover'],
  ['--brand-active', '--blue-600', 'Primary button pressed'],
  ['--brand-on-muted', '--blue-200', 'Text / icon sitting on a --brand-muted surface'],
  ['--card-border', '--slate-870', 'Hairline on every card, chart and panel surface'],
  ['--card-shadow', '0 4px 20px · --slate-925', 'Floating-card elevation'],
  ['--critical-fg', '--red-300', 'Text / icon on a critical tint'],
  ['--warning-fg', '--amber-300', 'Text / icon on a warning tint'],
  ['--healthy-fg', '--green-300', 'Text / icon on a healthy tint'],
  ['--critical-tint', 'rgba(239,68,68,.15)', 'Badge / banner critical fill'],
  ['--warning-tint', 'rgba(245,158,11,.15)', 'Badge / banner warning fill'],
  ['--healthy-tint', 'rgba(34,197,94,.14)', 'Badge healthy fill'],
  ['--info-tint', 'rgba(96,165,250,.12)', 'Info surface fill'],
  ['--focus-ring', '0 0 0 3px rgba(59,130,246,.14)', 'Text input / select focus ring'],
]

// Dark vs light values for the key tokens — shown side by side so both
// palettes are legible regardless of the theme you're currently viewing.
const THEME_DELTAS = [
  ['--canvas', '#151820', '#F5F7FB'],
  ['--card', '#080B11', '#FFFFFF'],
  ['--panel', '#171C28', '#F2F4F9'],
  ['--raised', '#1E2431', '#FFFFFF'],
  ['--border-panel', '#2A3346', '#DBE1EC'],
  ['--text-primary', '#F1F3F9', '#10182B'],
  ['--text-secondary', '#9CA6BF', '#4A5468'],
  ['--text-muted', '#616C86', '#6B7488'],
  ['--brand', '#3B82F6', '#2563EB'],
  ['--brand-muted', '#182A4E', '#E5EDFD'],
  ['--brand-on-muted', '#CFE0FF', '#1D4ED8'],
  ['--card-border', '#1A2130', '#E2E7F0'],
  ['--critical', '#EF4444', '#DC2626'],
  ['--critical-fg', '#FF9C9C', '#B42318'],
  ['--warning', '#F59E0B', '#D97706'],
  ['--healthy', '#22C55E', '#16A34A'],
]

const PRINCIPLES = [
  ['01', 'Status color is never hardcoded', 'Every status dot, badge, KPI value and graph node resolves through statusForLatency(), statusForErrorRate() or worstStatus(). No raw hex for severity — ever.'],
  ['02', 'Severity colors never enter chart palettes', 'A line’s color says which series it is, not how bad it is. Identity uses blues, purples and teals; red / amber / green are reserved for severity alone.'],
  ['03', 'Sort by severity, not alphabetically', 'Home and every service selector sort critical → warning → healthy. Alphabetical order buries incidents — the #1 UX finding.'],
  ['04', 'No icon-only controls without labels', 'Every interactive icon carries a visible label, title or aria-label. Unlabeled icons were the #2 finding.'],
  ['05', 'Auto-load data, never a blank Search screen', 'Logs and Traces run their default query on mount. A blank screen behind a Search button was the #3 finding.'],
  ['06', 'Comparison context on every metric', '“612ms” alone is meaningless. Pair every value with its delta versus the previous period. Smarter, not prettier.'],
]

const ATOMIC = [
  ['Tokens', 'Foundation', 'Three-tier CSS custom properties mirrored by the Tailwind theme — the vocabulary every atom is built from.', '--brand · --card-border · --critical-tint · radius · type scale'],
  ['Atoms', 'Indivisible', 'The smallest units — one element, one job.', 'StatusDot · Badge · Chip · Button · Input · Avatar · Sparkline'],
  ['Molecules', 'Small groups', 'A handful of atoms bound into a reusable unit.', 'KpiCard · StatusBadge · TabBar · SearchField · IncidentBanner'],
  ['Organisms', 'Sections', 'Standalone, composed regions of the interface.', 'DataTable · Panel · Sidebar · Header · SettingsDrawer · Toast'],
  ['Templates', 'Layout', 'Page skeletons — arrangement without real data.', 'AppShell (sidebar + one floating card) · Logs / Infra split layouts'],
  ['Pages', 'Instances', 'Templates filled with live service data.', 'HomePage · ServiceOverview · LogsView · InfraView'],
]

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'principles', label: 'Design principles' },
  { id: 'atomic', label: 'Atomic design' },
  { header: 'Tokens' },
  { id: 'tokens', label: 'Architecture' },
  { id: 'primitives', label: 'Primitive', sub: true },
  { id: 'semantic', label: 'Semantic', sub: true },
  { id: 'component-tokens', label: 'Component', sub: true },
  { id: 'theming', label: 'Theming', sub: true },
  { header: 'Foundations' },
  { id: 'color', label: 'Color' },
  { id: 'typography', label: 'Typography' },
  { id: 'spacing', label: 'Spacing & radius' },
  { id: 'elevation', label: 'Elevation' },
  { header: 'Component library' },
  { id: 'c-buttons', label: 'Buttons' },
  { id: 'c-status', label: 'Status & badges' },
  { id: 'c-metrics', label: 'Metric cards' },
  { id: 'c-data', label: 'Tables & panels' },
  { id: 'c-feedback', label: 'Feedback' },
  { id: 'c-forms', label: 'Forms' },
  { id: 'c-overlays', label: 'Overlays' },
  { id: 'c-nav', label: 'Navigation' },
]

const SPARK_UP = [{ v: 6 }, { v: 8 }, { v: 7 }, { v: 12 }, { v: 15 }, { v: 14 }, { v: 22 }, { v: 30 }]
const SPARK_FLAT = [{ v: 11 }, { v: 12 }, { v: 10 }, { v: 13 }, { v: 12 }, { v: 14 }, { v: 13 }, { v: 15 }]
const SPARK_CALM = [{ v: 9 }, { v: 8 }, { v: 9 }, { v: 8 }, { v: 10 }, { v: 9 }, { v: 8 }, { v: 9 }]

const SVC_COLUMNS = [
  { key: 'name', label: 'Service', sortable: false, render: (v, row) => (
    <span className="ds-inline-dot"><span className={`status-dot ${row.status}`} /><span className="mono">{v}</span></span>
  ) },
  { key: 'rpm', label: 'Rate', align: 'right' },
  { key: 'err', label: 'Errors', align: 'right', render: (v, row) => (
    <span className={row.status === 'critical' ? 'val-critical' : row.status === 'warning' ? 'val-warning' : ''}>{v}%</span>
  ) },
  { key: 'p90', label: 'p90', align: 'right' },
]
const SVC_DATA = [
  { id: 'order', name: 'order-service', status: 'critical', rpm: '1.2k/min', err: '6.80', p90: '2.40s' },
  { id: 'payment', name: 'payment-service', status: 'warning', rpm: '840/min', err: '1.40', p90: '180ms' },
  { id: 'cart', name: 'cart-service', status: 'healthy', rpm: '610/min', err: '0.10', p90: '92ms' },
]

/* ============================================================================
   Small building blocks
   ========================================================================== */

function Section({ id, kicker, title, lead, children }) {
  return (
    <section id={id} className="ds-section">
      {kicker && <div className="ds-kicker">{kicker}</div>}
      <h2 className="ds-h2">{title}</h2>
      {lead && <p className="ds-lead">{lead}</p>}
      {children}
    </section>
  )
}

function Spec({ title, note, wide, children }) {
  return (
    <div className={clsx('ds-spec', wide && 'ds-spec--wide')}>
      <div className="ds-spec-head">
        <span className="ds-spec-title">{title}</span>
        {note && <span className="ds-spec-note">{note}</span>}
      </div>
      <div className="ds-spec-body">{children}</div>
    </div>
  )
}

function Swatch({ token, value, text }) {
  return (
    <div className="ds-swatch">
      <div className="ds-swatch-chip" style={{ background: `var(${token})` }} />
      <code className="ds-token">{token}</code>
      <span className="ds-swatch-val">{value}</span>
      {text && <span className="ds-swatch-text">{text}</span>}
    </div>
  )
}

function TokenTable({ rows, refLabel = 'References' }) {
  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr><th>Token</th><th>{refLabel}</th><th>Preview</th><th>Usage</th></tr>
        </thead>
        <tbody>
          {rows.map(([token, ref, usage]) => (
            <tr key={token}>
              <td><code className="ds-token">{token}</code></td>
              <td><code className="ds-token ds-token--ref">{ref}</code></td>
              <td><span className="ds-table-chip" style={{ background: `var(${token})` }} /></td>
              <td className="ds-table-usage">{usage}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ============================================================================
   Page
   ========================================================================== */

export default function DesignSystemPage({ theme, setTheme }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState('overview')
  const [compactTab, setCompactTab] = useState('detail')
  const [activeId, setActiveId] = useState('overview')
  const resolved = resolveTheme(theme)

  useEffect(() => {
    document.title = 'CubeAPM · Design System'
    const ids = SECTIONS.filter(s => s.id).map(s => s.id)
    const obs = new IntersectionObserver(
      entries => entries.forEach(e => { if (e.isIntersecting) setActiveId(e.target.id) }),
      { rootMargin: '-40% 0px -55% 0px' }
    )
    ids.forEach(id => { const el = document.getElementById(id); if (el) obs.observe(el) })
    return () => obs.disconnect()
  }, [])

  return (
    <div className="ds-root">
      {/* ---- Top bar ---- */}
      <header className="ds-topbar">
        <div className="ds-brand">
          <LogoIcon size={26} />
          <LogoWordmark height={17} className="ds-wordmark" />
          <span className="ds-brand-sep" />
          <span className="ds-brand-title">Design System</span>
          <span className="ds-version">v1.1 · light + dark</span>
        </div>
        <div className="ds-topbar-actions">
          <button
            className="ds-theme-toggle"
            onClick={() => setTheme?.(resolved === 'light' ? 'dark' : 'light')}
            title={`Switch to ${resolved === 'light' ? 'dark' : 'light'} theme`}
            aria-label={`Switch to ${resolved === 'light' ? 'dark' : 'light'} theme`}
          >
            {resolved === 'light' ? <Moon size={14} /> : <Sun size={14} />}
            {resolved === 'light' ? 'Dark' : 'Light'}
          </button>
          <button className="ds-back" onClick={() => navigate('/home')}>
            <ArrowLeft size={14} /> Back to app
          </button>
        </div>
      </header>

      <div className="ds-layout">
        {/* ---- Side nav ---- */}
        <nav className="ds-nav" aria-label="Design system sections">
          {SECTIONS.map((s, i) =>
            s.header ? (
              <div key={`h-${i}`} className="ds-nav-group">{s.header}</div>
            ) : (
              <a
                key={s.id}
                href={`#${s.id}`}
                className={clsx('ds-navlink', s.sub && 'ds-navlink--sub', activeId === s.id && 'active')}
              >
                {s.label}
              </a>
            )
          )}
        </nav>

        {/* ---- Content ---- */}
        <main className="ds-main">
          {/* OVERVIEW */}
          <Section
            id="overview"
            kicker="CubeAPM Platform"
            title="A design system for reading severity at a glance"
            lead="This is the living reference for the redesigned CubeAPM frontend. It is organized in two parts: the guidelines and token architecture that govern every decision, and a component library showing each building block and its variants — rendered live from the same code that ships in the product."
          >
            <div className="ds-stat-row">
              <div className="ds-stat"><div className="ds-stat-n">3</div><div className="ds-stat-l">Token tiers</div></div>
              <div className="ds-stat"><div className="ds-stat-n">6</div><div className="ds-stat-l">Non-negotiable rules</div></div>
              <div className="ds-stat"><div className="ds-stat-n">1</div><div className="ds-stat-l">Theme · dark</div></div>
              <div className="ds-stat"><div className="ds-stat-n">Inter-op</div><div className="ds-stat-l">CSS vars + Tailwind</div></div>
            </div>
            <div className="ds-callout">
              <Palette size={16} />
              <div>
                <strong>How theming works.</strong> Colors, type, spacing and radius live as CSS custom properties in a
                three-tier cascade (primitive → semantic → component). The Tailwind theme mirrors the semantic layer so
                utility classes and hand-written CSS resolve to the exact same values. Change a primitive once and it
                propagates everywhere.
              </div>
            </div>
          </Section>

          {/* PRINCIPLES */}
          <Section
            id="principles"
            kicker="Guidelines"
            title="Six non-negotiable rules"
            lead="Every one of these traces directly to a finding from the UX teardown of CubeAPM and New Relic. They are enforced in code, not left to discretion."
          >
            <div className="ds-principle-grid">
              {PRINCIPLES.map(([n, t, b]) => (
                <div key={n} className="ds-principle">
                  <div className="ds-principle-n">{n}</div>
                  <div className="ds-principle-t">{t}</div>
                  <div className="ds-principle-b">{b}</div>
                </div>
              ))}
            </div>
          </Section>

          {/* ATOMIC */}
          <Section
            id="atomic"
            kicker="Methodology"
            title="Atomic design"
            lead="The interface is composed bottom-up. Tokens feed atoms, atoms compose into molecules and organisms, and templates arrange them into the pages users actually see."
          >
            <div className="ds-atomic">
              {ATOMIC.map(([lvl, tag, d, ex], i) => (
                <div key={lvl} className="ds-atomic-row">
                  <div className="ds-atomic-index">{i + 1}</div>
                  <div className="ds-atomic-head">
                    <span className="ds-atomic-lvl">{lvl}</span>
                    <span className="ds-atomic-tag">{tag}</span>
                  </div>
                  <div className="ds-atomic-d">{d}</div>
                  <div className="ds-atomic-ex mono">{ex}</div>
                </div>
              ))}
            </div>
          </Section>

          {/* TOKEN ARCHITECTURE */}
          <Section
            id="tokens"
            kicker="Tokens"
            title="Three-tier token architecture"
            lead="No component ever names a raw value. Each tier references the one beneath it, so intent stays legible and a single edit ripples predictably through the whole platform."
          >
            <div className="ds-tier-flow">
              <div className="ds-tier ds-tier--1">
                <div className="ds-tier-badge">Layer 1</div>
                <div className="ds-tier-name">Primitive</div>
                <div className="ds-tier-desc">Raw, context-free values. The only place a hex or px is written.</div>
                <code className="ds-token">--blue-500: #3B82F6</code>
              </div>
              <div className="ds-tier-arrow">→</div>
              <div className="ds-tier ds-tier--2">
                <div className="ds-tier-badge">Layer 2</div>
                <div className="ds-tier-name">Semantic</div>
                <div className="ds-tier-desc">Role-based aliases the platform consumes. Says what, not which.</div>
                <code className="ds-token">--brand: var(--blue-500)</code>
              </div>
              <div className="ds-tier-arrow">→</div>
              <div className="ds-tier ds-tier--3">
                <div className="ds-tier-badge">Layer 3</div>
                <div className="ds-tier-name">Component</div>
                <div className="ds-tier-desc">Element-specific decisions built on the semantic layer.</div>
                <code className="ds-token">--btn-hover: var(--brand-hover)</code>
              </div>
            </div>
          </Section>

          <Section id="primitives" kicker="Tokens · Layer 1" title="Primitive tokens"
            lead="The raw palette. These are named by hue and lightness, never by purpose.">
            {PRIMITIVES.map(p => (
              <div key={p.group} className="ds-ramp-block">
                <div className="ds-ramp-head"><span className="ds-ramp-name">{p.group}</span><span className="ds-ramp-desc">{p.desc}</span></div>
                <div className="ds-swatch-grid">
                  {p.tokens.map(([token, value]) => <Swatch key={token} token={token} value={value} />)}
                </div>
              </div>
            ))}
          </Section>

          <Section id="semantic" kicker="Tokens · Layer 2" title="Semantic tokens"
            lead="What the platform actually references. Each maps to exactly one primitive.">
            <TokenTable rows={SEMANTIC} refLabel="Primitive" />
          </Section>

          <Section id="component-tokens" kicker="Tokens · Layer 3" title="Component tokens"
            lead="Interaction states and composite decisions. Migrating the platform's previously hardcoded literals here means a button hover or a card hairline is now defined once.">
            <TokenTable rows={COMPONENT_TOKENS} refLabel="Resolves to" />
          </Section>

          {/* THEMING */}
          <Section id="theming" kicker="Tokens · Theming" title="Light & dark from one system"
            lead="Two themes, zero component rewrites. Because no component names a raw value, a theme is nothing more than a second set of semantic + component token values. Use the toggle in the top bar to preview this whole page in either theme.">
            <div className="ds-tier-flow" style={{ marginBottom: 18 }}>
              <div className="ds-tier">
                <div className="ds-tier-badge">Mechanism</div>
                <div className="ds-tier-name">One attribute</div>
                <div className="ds-tier-desc">A resolved theme is written to <code className="ds-token">html[data-theme]</code>. CSS re-points the tokens under <code className="ds-token">:root[data-theme="light"]</code>.</div>
              </div>
              <div className="ds-tier">
                <div className="ds-tier-badge">Layers touched</div>
                <div className="ds-tier-name">Semantic + Component</div>
                <div className="ds-tier-desc">Primitives stay fixed. Only the meaning-of and decision-on layers flip — surfaces, text, borders, brand tints and status foregrounds.</div>
              </div>
              <div className="ds-tier">
                <div className="ds-tier-badge">Preference</div>
                <div className="ds-tier-name">Light · Dark · Auto</div>
                <div className="ds-tier-desc">Persisted to local storage; <code className="ds-token">auto</code> follows the OS. Default is dark, applied before first paint so there's no flash.</div>
              </div>
            </div>
            <div className="ds-callout">
              <Palette size={16} />
              <div>
                <strong>The floating-card relationship inverts, on purpose.</strong> In dark, the canvas is mid-tone and the card sits <em>darker</em>. In light, the card is white and the canvas sits <em>darker</em> — either way the single surface card reads as raised. Status hues also step one shade deeper in light so values stay legible on white.
              </div>
            </div>
            <div className="ds-theme-grid">
              <div className="ds-theme-row ds-theme-row--head">
                <span className="ds-theme-head">Token</span>
                <span className="ds-theme-head">Dark</span>
                <span className="ds-theme-head">Light</span>
              </div>
              {THEME_DELTAS.map(([token, dark, light]) => (
                <div key={token} className="ds-theme-row">
                  <div className="ds-theme-cell"><code className="ds-token">{token}</code></div>
                  <div className="ds-theme-cell"><span className="ds-theme-chip" style={{ background: dark }} /><span className="ds-theme-hex">{dark}</span></div>
                  <div className="ds-theme-cell"><span className="ds-theme-chip" style={{ background: light }} /><span className="ds-theme-hex">{light}</span></div>
                </div>
              ))}
            </div>
          </Section>

          {/* COLOR */}
          <Section id="color" kicker="Foundations" title="Color"
            lead="Surfaces are intentionally inverted — the canvas gutter is mid-tone and the card sits darker, which lets the single surface card read as floating.">
            <div className="ds-swatch-grid ds-swatch-grid--lg">
              <Swatch token="--canvas" value="Gutter" text="mid-tone" />
              <Swatch token="--card" value="Surface card" text="darkest" />
              <Swatch token="--panel" value="Panel" />
              <Swatch token="--panel-2" value="Hover" />
              <Swatch token="--raised" value="Raised / overlay" />
            </div>
            <div className="ds-swatch-grid ds-swatch-grid--lg">
              <Swatch token="--brand" value="Brand" />
              <Swatch token="--brand-muted" value="Brand muted" />
              <Swatch token="--accent" value="Accent" />
              <Swatch token="--healthy" value="Healthy" />
              <Swatch token="--warning" value="Warning" />
              <Swatch token="--critical" value="Critical" />
              <Swatch token="--info" value="Info" />
            </div>
            <div className="ds-callout ds-callout--warn">
              <Boxes size={16} />
              <div><strong>Reserved.</strong> Green, amber and red mean severity and nothing else. They never appear in a multi-series chart palette, where color must signal series identity instead.</div>
            </div>
          </Section>

          {/* TYPOGRAPHY */}
          <Section id="typography" kicker="Foundations" title="Typography"
            lead="Rubik for UI text; JetBrains Mono for anything numeric — KPI values, trace IDs, table numerics — with tabular figures enabled globally.">
            <div className="ds-type-list">
              <div className="ds-type-row"><span className="ds-type-meta">kpi-value · 30 / 600 · mono</span><span className="mono" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.1 }}>2.40s</span></div>
              <div className="ds-type-row"><span className="ds-type-meta">summary-pill · 25 / 700</span><span style={{ fontSize: 25, fontWeight: 700, lineHeight: 1.1 }}>7 services</span></div>
              <div className="ds-type-row"><span className="ds-type-meta">chart-value · 20 / 700</span><span style={{ fontSize: 20, fontWeight: 700 }}>5.7 rpm</span></div>
              <div className="ds-type-row"><span className="ds-type-meta">page-title · 15 / 600</span><span style={{ fontSize: 15, fontWeight: 600 }}>APM &amp; Services</span></div>
              <div className="ds-type-row"><span className="ds-type-meta">panel-header · 13.5 / 600</span><span style={{ fontSize: 13.5, fontWeight: 600 }}>Recent Traces</span></div>
              <div className="ds-type-row"><span className="ds-type-meta">body · 12.5 / 400</span><span style={{ fontSize: 12.5 }}>The service list always sorts by severity.</span></div>
              <div className="ds-type-row"><span className="ds-type-meta">caption · 11 / 400 · muted</span><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>↑ 4.4× vs last hour</span></div>
            </div>
            <div className="ds-font-pair">
              <div className="ds-font-card"><div className="ds-font-name">Rubik</div><div className="ds-font-sample">AaBbCc 0123 — interface</div></div>
              <div className="ds-font-card"><div className="ds-font-name mono">JetBrains Mono</div><div className="ds-font-sample mono">AaBbCc 0123 — 2.40s</div></div>
            </div>
          </Section>

          {/* SPACING & RADIUS */}
          <Section id="spacing" kicker="Foundations" title="Spacing & radius"
            lead="A 14px gutter frames the app; radii step 6 → 9 → 10 → 12px from controls up to the surface card.">
            <div className="ds-radius-row">
              {[['--radius-sm', '6px', 'Chips, inputs, buttons'], ['--radius-md', '9px', 'Panels, dropdowns'], ['--radius-lg', '10px', 'Cards, charts'], ['--radius-card', '12px', 'The surface card']].map(([tok, val, use]) => (
                <div key={tok} className="ds-radius-item">
                  <div className="ds-radius-demo" style={{ borderRadius: `var(${tok})` }} />
                  <code className="ds-token">{tok}</code>
                  <span className="ds-swatch-val">{val}</span>
                  <span className="ds-swatch-text">{use}</span>
                </div>
              ))}
            </div>
            <div className="ds-layout-tokens">
              <div className="ds-lt"><code className="ds-token">--nav-w</code><span>182px</span><span className="ds-swatch-text">Expanded sidebar</span></div>
              <div className="ds-lt"><code className="ds-token">--nav-w-collapsed</code><span>66px</span><span className="ds-swatch-text">Collapsed sidebar</span></div>
              <div className="ds-lt"><code className="ds-token">--gutter</code><span>14px</span><span className="ds-swatch-text">Canvas padding</span></div>
            </div>
          </Section>

          {/* ELEVATION */}
          <Section id="elevation" kicker="Foundations" title="Elevation"
            lead="Depth is carried by soft, near-black shadows. The higher the layer, the larger and softer the cast.">
            <div className="ds-elev-row">
              <div className="ds-elev-card" style={{ boxShadow: 'var(--card-shadow)' }}><span>Surface card</span><code className="ds-token">--card-shadow</code></div>
              <div className="ds-elev-card" style={{ boxShadow: '0 8px 28px rgba(0,0,0,.5)' }}><span>Dropdown</span><code className="ds-token">dd-panel</code></div>
              <div className="ds-elev-card" style={{ boxShadow: '0 16px 40px rgba(0,0,0,.55)' }}><span>Popover</span><code className="ds-token">.pop</code></div>
              <div className="ds-elev-card" style={{ boxShadow: '0 12px 40px rgba(0,0,0,.45)' }}><span>Toast</span><code className="ds-token">.toast-bar</code></div>
            </div>
          </Section>

          {/* ===================== COMPONENT LIBRARY ===================== */}

          {/* BUTTONS */}
          <Section id="c-buttons" kicker="Component library" title="Buttons"
            lead="One button family drives every action. The primary fill uses --brand with the --brand-hover / --brand-active interaction tokens; secondaries stay quiet on --panel.">
            <Spec title="Header buttons" note=".hbtn · .hbtn.active · .hbtn.icon · .hbtn.small">
              <div className="ds-row">
                <button className="hbtn"><RefreshCw size={14} /> Refresh</button>
                <button className="hbtn active">Last 1 hour</button>
                <button className="hbtn icon" title="Notifications" aria-label="Notifications"><Bell size={15} /></button>
                <button className="hbtn small">Live</button>
              </div>
            </Spec>
            <Spec title="Primary actions" note=".trace-run-btn · .drawer-done · .k8s-events-search-btn">
              <div className="ds-row">
                <button className="trace-run-btn">Run query</button>
                <button className="drawer-done">Done</button>
                <button className="k8s-events-search-btn"><Search size={13} /> Search events</button>
              </div>
            </Spec>
            <Spec title="Secondary & full-width" note=".drawer-save · .wt-btn.secondary · .login-submit">
              <div className="ds-row" style={{ alignItems: 'center' }}>
                <button className="drawer-save">Save</button>
                <button className="wt-btn secondary">Back</button>
                <div style={{ width: 200 }}><button className="login-submit">Sign in</button></div>
              </div>
            </Spec>
            <Spec title="Segmented toggle" note=".seg-toggle · .view-toggle">
              <div className="ds-row">
                <div className="seg-toggle">
                  <span className="seg active">Endpoint</span>
                  <span className="seg">Exception</span>
                </div>
              </div>
            </Spec>
          </Section>

          {/* STATUS & BADGES */}
          <Section id="c-status" kicker="Component library" title="Status & badges"
            lead="Severity indicators — the heart of the system. Every one resolves its color through the status utilities; none is hand-colored.">
            <Spec title="Status dot" note="StatusDot · sizes sm / md / lg">
              <div className="ds-row ds-row--gap">
                {['sm', 'md', 'lg'].map(size => (
                  <div key={size} className="ds-dot-set">
                    <StatusDot status="critical" size={size} />
                    <StatusDot status="warning" size={size} />
                    <StatusDot status="healthy" size={size} />
                    <StatusDot status="info" size={size} />
                    <StatusDot status="neutral" size={size} />
                    <span className="ds-swatch-text">{size}</span>
                  </div>
                ))}
              </div>
            </Spec>
            <Spec title="Table status dot" note=".status-dot.critical — with severity halo">
              <div className="ds-row ds-row--gap">
                <span className="ds-inline-dot"><span className="status-dot critical" /> critical</span>
                <span className="ds-inline-dot"><span className="status-dot warning" /> warning</span>
                <span className="ds-inline-dot"><span className="status-dot healthy" /> healthy</span>
              </div>
            </Spec>
            <Spec title="Status badge" note="StatusBadge · tint + outline + label">
              <div className="ds-row">
                <StatusBadge status="critical" />
                <StatusBadge status="warning" />
                <StatusBadge status="healthy" />
                <StatusBadge status="info" />
                <StatusBadge status="neutral" />
              </div>
            </Spec>
            <Spec title="Pill badges" note=".badge · .kpi-chip · .flag">
              <div className="ds-row ds-row--gap">
                <span className="badge critical">critical</span>
                <span className="badge warning">warning</span>
                <span className="badge healthy">healthy</span>
                <span className="kpi-chip critical">↑ Critical</span>
                <span className="kpi-chip warning">Warning</span>
                <span className="flag crit">Breached</span>
                <span className="flag ok">Within SLO</span>
              </div>
            </Spec>
          </Section>

          {/* METRIC CARDS */}
          <Section id="c-metrics" kicker="Component library" title="Metric cards"
            lead="KpiCard is the workhorse — label, severity chip, mono value, sparkline and threshold caption, all colored by resolved status. Summary pills give the fleet count at a glance.">
            <Spec title="KPI card" note="KpiCard · status drives value color, chip & sparkline" wide>
              <div className="ds-grid-3">
                <KpiCard label="p90 Latency" value="2.40" unit="s" status="critical" change={1} sparklineData={SPARK_UP} threshold="300ms" />
                <KpiCard label="Error Rate" value="1.40" unit="%" status="warning" change={1} sparklineData={SPARK_FLAT} threshold="1%" />
                <KpiCard label="Throughput" value="612" unit="/min" status="healthy" sparklineData={SPARK_CALM} threshold="baseline 590" />
              </div>
            </Spec>
            <Spec title="Summary pills" note=".summary-pill · total / critical / warning / healthy" wide>
              <div className="summary-strip" style={{ marginBottom: 0 }}>
                <div className="summary-pill total"><div><div className="num">7</div><div className="lbl">Services</div></div><div className="icon-wrap"><Boxes size={19} /></div></div>
                <div className="summary-pill critical"><div><div className="num">1</div><div className="lbl">Critical</div></div><div className="icon-wrap"><Bell size={19} /></div></div>
                <div className="summary-pill warning"><div><div className="num">2</div><div className="lbl">Warning</div></div><div className="icon-wrap"><Bell size={19} /></div></div>
                <div className="summary-pill healthy"><div><div className="num">4</div><div className="lbl">Healthy</div></div><div className="icon-wrap"><Check size={19} /></div></div>
              </div>
            </Spec>
            <Spec title="Sparkline" note="Sparkline · inline SVG, area + line">
              <div style={{ width: 160, height: 40 }}><Sparkline data={SPARK_UP} color="var(--critical)" /></div>
            </Spec>
          </Section>

          {/* TABLES & PANELS */}
          <Section id="c-data" kicker="Component library" title="Tables & panels"
            lead="Panel is the universal “card with a header row.” DataTable renders sortable, right-aligned numerics with status-colored cells.">
            <Spec title="Panel + data table" note="Panel › DataTable · click a header to sort" wide>
              <Panel title="Services" hint="sorted by severity">
                <DataTable columns={SVC_COLUMNS} data={SVC_DATA} />
              </Panel>
            </Spec>
            <Spec title="Tab bar" note="TabBar · .tabbar/.tab · one pattern everywhere">
              <TabBar
                tabs={[{ id: 'overview', label: 'Overview' }, { id: 'red', label: 'RED', count: 12 }, { id: 'traces', label: 'Traces' }, { id: 'logs', label: 'Logs' }]}
                active={tab}
                onChange={setTab}
              />
            </Spec>
            <Spec title="Compact tabs" note="TabBar · the same component, no count">
              <TabBar
                tabs={[{ id: 'detail', label: 'Detail' }, { id: 'health', label: 'Health' }, { id: 'graph', label: 'Service Graph' }]}
                active={compactTab}
                onChange={setCompactTab}
              />
            </Spec>
          </Section>

          {/* FEEDBACK */}
          <Section id="c-feedback" kicker="Component library" title="Feedback & empty states"
            lead="When something is wrong, the incident banner surfaces root cause as a first-class element instead of hiding it in a tooltip. Empty states always offer the next action.">
            <Spec title="Incident banner" note="IncidentBanner · left-border severity accent" wide>
              <div className="ds-stack">
                <IncidentBanner incident={{ severity: 'critical', title: 'order-service p90 latency 4.4× baseline', rootCause: 'Downstream mysql-primary connection pool exhausted', since: Date.now() - 2 * 3600 * 1000 }} />
                <IncidentBanner incident={{ severity: 'warning', title: 'payment-service error rate elevated', rootCause: 'Timeouts calling fraud-check upstream', since: Date.now() - 26 * 60 * 1000 }} />
              </div>
            </Spec>
            <Spec title="Empty state" note="EmptyState · icon + title + description + action" wide>
              <EmptyState
                icon={Inbox}
                title="No traces match your filter"
                description="Try widening the time range or clearing a facet to see recent activity."
                action={<button className="hbtn small">Clear filters</button>}
              />
            </Spec>
            <Spec title="Toast" note=".toast-bar · transient, auto-dismiss" wide>
              <div className="ds-toast-frame">
                <div className="toast-bar" style={{ position: 'static', transform: 'none', animation: 'none' }}>
                  <HelpCircle size={17} />
                  <span className="toast-msg">Help Center is not built yet. This was only a preview of the user journey.</span>
                  <button className="toast-close" aria-label="Dismiss"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
                </div>
              </div>
            </Spec>
          </Section>

          {/* FORMS */}
          <Section id="c-forms" kicker="Component library" title="Forms"
            lead="Inputs share one focus treatment — a --brand border and the --focus-ring glow. Controls sit on --panel to stay quiet until touched.">
            <Spec title="Text & search input" note=".search-wrap · .login-input-wrap">
              <div className="ds-stack" style={{ maxWidth: 360 }}>
                <div className="search-wrap" style={{ width: '100%', minWidth: 0 }}>
                  <Search size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  <input className="search-input" placeholder="Search services, hosts, traces…" />
                </div>
                <div className="login-input-wrap">
                  <Search size={14} />
                  <input placeholder="you@company.com" />
                </div>
              </div>
            </Spec>
            <Spec title="Select & number" note=".drawer-select · .drawer-input-wrap">
              <div className="ds-row" style={{ maxWidth: 420 }}>
                <select className="drawer-select" defaultValue="Last 1 hour">
                  <option>Last 15 minutes</option><option>Last 1 hour</option><option>Last 24 hours</option>
                </select>
                <div className="drawer-input-wrap"><input type="number" defaultValue={300} /><span className="drawer-suffix">ms</span></div>
              </div>
            </Spec>
            <Spec title="Checkbox row" note=".facet-opt · .login-first-time">
              <div className="ds-stack" style={{ maxWidth: 360 }}>
                <label className="facet-opt"><input type="checkbox" defaultChecked /> <span className="facet-opt-label">level:error</span> <span className="facet-opt-count">1.2k</span></label>
                <label className="login-first-time"><input type="checkbox" defaultChecked /> <span>Consider me as a first-time user</span></label>
              </div>
            </Spec>
          </Section>

          {/* OVERLAYS */}
          <Section id="c-overlays" kicker="Component library" title="Overlays"
            lead="Popovers, dropdowns and the walkthrough all sit on --raised with a soft shadow. The walkthrough spotlight cuts a hole in a dimming mask to anchor each step.">
            <Spec title="Dropdown panel" note=".dd-panel · .dd-item.active">
              <div className="dd-panel" style={{ width: 220 }}>
                <div className="dd-list">
                  <div className="dd-item active"><Check size={14} className="dd-item-check" /> production</div>
                  <div className="dd-item"><Check size={14} className="dd-item-check" /> staging</div>
                  <div className="dd-item"><Check size={14} className="dd-item-check" /> development</div>
                </div>
              </div>
            </Spec>
            <Spec title="Search result" note=".search-item · dot + name + category">
              <div className="dd-panel" style={{ width: 320 }}>
                <div className="search-section-label">Last viewed</div>
                <div className="search-item"><span className="search-item-dot critical" /><span className="search-item-name">order-service</span><span className="search-item-cat">Service</span></div>
                <div className="search-item hl"><span className="search-item-dot healthy" /><span className="search-item-name">cart-service</span><span className="search-item-cat">Service</span></div>
              </div>
            </Spec>
            <Spec title="Walkthrough tooltip" note=".wt-tooltip · spotlight coach-mark" wide>
              <div className="ds-wt-frame">
                <div className="wt-tooltip" style={{ position: 'static', width: 320, boxShadow: '0 24px 60px rgba(0,0,0,.5)' }}>
                  <div className="wt-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 10, height: 10 }}><path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z" /></svg>Step 3</div>
                  <div className="wt-title">Fleet health at a glance</div>
                  <div className="wt-desc">Total services, plus a live count of Critical, Warning, and Healthy. Colors are reserved strictly for severity across the platform.</div>
                  <div className="wt-progress">
                    <span className="wt-progress-dot done" /><span className="wt-progress-dot done" /><span className="wt-progress-dot active" /><span className="wt-progress-dot" /><span className="wt-progress-dot" /><span className="wt-progress-dot" />
                  </div>
                  <div className="wt-actions">
                    <button className="wt-skip">Skip tour</button>
                    <div className="wt-nav">
                      <button className="wt-btn secondary">Back</button>
                      <button className="wt-btn primary">Next <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg></button>
                    </div>
                  </div>
                </div>
              </div>
            </Spec>
          </Section>

          {/* NAVIGATION */}
          <Section id="c-nav" kicker="Component library" title="Navigation"
            lead="The sidebar item is the atom of navigation — an always-labeled icon with an active brand accent and a genuinely disabled state for not-yet-connected sources.">
            <Spec title="Sidebar item" note=".nav-item · default / active / disabled">
              <div className="ds-nav-frame">
                <div className="nav-item"><Boxes size={17} /><span className="nav-text">Services</span></div>
                <div className="nav-item active"><Search size={17} /><span className="nav-text">Traces</span></div>
                <div className="nav-item disabled"><Settings size={17} /><span className="nav-text">Service Graph</span></div>
              </div>
            </Spec>
            <Spec title="Avatar" note=".avatar · gradient monogram">
              <div className="ds-row"><button className="avatar">S</button></div>
            </Spec>
          </Section>

          <footer className="ds-footer">
            CubeAPM Design System · rendered live from <code className="ds-token">src/pages/DesignSystemPage.jsx</code> · dark theme
          </footer>
        </main>
      </div>
    </div>
  )
}
