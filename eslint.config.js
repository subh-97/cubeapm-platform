import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// Flat config (ESLint 9). Three environments live in this repo:
//   1. src/**        — browser, React 18, JSX, ES modules
//   2. src/**/*.test.js — node (bundled by scripts/run-tests.mjs, then run in node)
//   3. scripts/**, *.config.js — node tooling
//
// Note on the `@/` alias: nothing here resolves import paths, so the alias needs
// no resolver config. If eslint-plugin-import is ever added, it will need
// `settings['import/resolver']` pointed at the same alias vite.config.js defines.

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'public/**',
      // Claude Code worktrees are full checkouts of this repo; linting them
      // would double every finding.
      '.claude/**',
      // Verbatim copies of src/ prepared for handoff. Linting them would double
      // every finding, and they are meant to match the originals byte for byte.
      'query-bar-package/**',
      'log-record-drawer-package/**',
      'save-query-package/**',
      'table-search-package/**',
      'traces-package/**',
    ],
  },

  js.configs.recommended,

  // ---------------------------------------------------------------- app code
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { react },
    settings: { react: { version: '18.3' } },
    rules: {
      // Core no-unused-vars does not treat `<Foo />` as a reference to `Foo`.
      // These two rules are the only reason eslint-plugin-react is here — the
      // rest of its recommended set (prop-types etc.) is deliberately off.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',

      // Unused imports and dead locals are worth seeing. `_`-prefixed args are
      // the escape hatch for signature-shaped params (event handlers, map
      // callbacks that only want the index).
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],

      // src/utils/aggregator.js already carries a disable directive for this,
      // which only means something if the rule is actually on.
      'no-new-func': 'error',

      // `try { navigator.clipboard.writeText(x) } catch {}` is deliberate —
      // a failed clipboard write has nothing to recover from.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // React Hooks rules apply to every file that can contain a hook.
  {
    ...reactHooks.configs['recommended-latest'],
    files: ['src/**/*.{js,jsx}'],
  },

  // Fast Refresh only constrains modules that actually export components.
  // Downgraded to a warning: the one file that trips it (QueryBuilder.jsx,
  // which exports helpers alongside its components) needs those helpers split
  // into their own module to satisfy it. That is a real refactor, not
  // something the lint setup should block on — so it stays visible as a
  // warning rather than failing the command.
  {
    ...reactRefresh.configs.vite,
    files: ['src/**/*.jsx'],
    rules: {
      ...reactRefresh.configs.vite.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },

  // ------------------------------------------------------------- test files
  // Bundled by scripts/run-tests.mjs and executed in node, not the browser.
  {
    files: ['src/**/*.test.js'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // --------------------------------------------------------- node tooling
  {
    files: ['scripts/**/*.{js,mjs}', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
]
