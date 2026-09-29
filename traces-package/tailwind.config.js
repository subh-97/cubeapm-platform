/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  // StatusDot / StatusBadge build their class dynamically (`bg-status-${status}`),
  // which Tailwind's content scanner cannot see. Safelisting guarantees the
  // documented status utilities are always generated.
  safelist: [
    { pattern: /^(bg|text|border)-status-(healthy|warning|critical|info|neutral)$/ },
  ],
  theme: {
    extend: {
      colors: {
        // Every color reads its RGB channels from a CSS variable defined in
        // index.css, so utility classes (bg-panel, text-text-primary, and even
        // opacity modifiers like bg-healthy/10) follow the active theme. The
        // channel vars are re-pointed under :root[data-theme="light"].
        // Surfaces
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)',
        card: 'rgb(var(--c-card) / <alpha-value>)',
        panel: 'rgb(var(--c-panel) / <alpha-value>)',
        'panel-2': 'rgb(var(--c-panel-2) / <alpha-value>)',
        raised: 'rgb(var(--c-raised) / <alpha-value>)',

        // Borders
        'border-subtle': 'rgb(var(--c-border-subtle) / <alpha-value>)',
        'border-panel': 'rgb(var(--c-border-panel) / <alpha-value>)',
        'border-strong': 'rgb(var(--c-border-strong) / <alpha-value>)',

        // Text
        'text-primary': 'rgb(var(--c-text-primary) / <alpha-value>)',
        'text-secondary': 'rgb(var(--c-text-secondary) / <alpha-value>)',
        'text-muted': 'rgb(var(--c-text-muted) / <alpha-value>)',

        // Brand
        brand: 'rgb(var(--c-brand) / <alpha-value>)',
        'brand-muted': 'rgb(var(--c-brand-muted) / <alpha-value>)',

        // Semantic status
        healthy: 'rgb(var(--c-healthy) / <alpha-value>)',
        warning: 'rgb(var(--c-warning) / <alpha-value>)',
        critical: 'rgb(var(--c-critical) / <alpha-value>)',
        info: 'rgb(var(--c-info) / <alpha-value>)',
        neutral: 'rgb(var(--c-neutral) / <alpha-value>)',

        // Status group — enables `bg-status-*` / `text-status-*` utilities
        // consumed by shared StatusDot / StatusBadge (dynamic class names, so
        // also safelisted below). Theme-aware, opacity-capable.
        status: {
          healthy: 'rgb(var(--c-healthy) / <alpha-value>)',
          warning: 'rgb(var(--c-warning) / <alpha-value>)',
          critical: 'rgb(var(--c-critical) / <alpha-value>)',
          info: 'rgb(var(--c-info) / <alpha-value>)',
          neutral: 'rgb(var(--c-neutral) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Rubik', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        sm: '6px',
        md: '9px',
        lg: '10px',
        card: '12px',
      },
      fontSize: {
        'kpi-value': ['30px', { lineHeight: '1.1', fontWeight: '600' }],
        'summary-pill': ['25px', { lineHeight: '1.1', fontWeight: '700' }],
        'chart-value': ['20px', { lineHeight: '1.2', fontWeight: '700' }],
        'page-title': ['15px', { lineHeight: '1.3', fontWeight: '600' }],
        'drawer-title': ['14px', { lineHeight: '1.3', fontWeight: '600' }],
        'panel-header': ['13.5px', { lineHeight: '1.4', fontWeight: '600' }],
        'body': ['12.5px', { lineHeight: '1.45', fontWeight: '400' }],
        'caption': ['11px', { lineHeight: '1.3', fontWeight: '400' }],
      },
      width: {
        'nav-expanded': '222px',
        'nav-collapsed': '66px',
      },
      spacing: {
        'nav-expanded': '222px',
        'nav-collapsed': '66px',
      },
    },
  },
  plugins: [],
}
