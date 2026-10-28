// Every "Create Alert" in the app opens the rule editor (docs/alerts/DESIGN.md
// D13), and the mock alert drawer the Logs and Traces bars used to open is
// gone. Read from the pages' source, since what matters is which module each
// page reaches for; what each payload holds is pinned in editorPayloads.test.js.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = file => readFileSync(join(process.cwd(), 'src', file), 'utf8')

test('the mock alert drawer is gone, and nothing imports it', () => {
  assert.equal(existsSync(join(process.cwd(), 'src/components/explorer/AlertDrawer.jsx')), false)
  for (const page of ['pages/LogsView.jsx', 'pages/TracesView.jsx']) assert.doesNotMatch(src(page), /AlertDrawer/, page)
})

test('each page\'s Create Alert builds its payload where the editor reads it', () => {
  const uses = {
    'pages/LogsView.jsx': 'alertPayloadForQuery',
    'pages/TracesView.jsx': 'alertPayloadForQuery',
    'pages/ServiceOverview.jsx': 'alertPayloadForCard',
    'pages/InfraView.jsx': 'alertPayloadForHostCpu',
    'components/errors/ErrorDetailsDrawer.jsx': 'alertPayloadForError',
  }
  for (const [page, builder] of Object.entries(uses)) {
    const text = src(page)
    assert.match(text, new RegExp(`import \\{ ${builder} \\} from '@/utils/alerts/editorPayloads'`), page)
    assert.match(text, /view: 'alertEditor'/, `${page} opens the editor`)
  }
})

test('Explore\'s toolbar offers Create alert, built where the other entry points are', () => {
  assert.match(src('pages/ExploreView.jsx'), /import \{ alertPayloadForExplore \} from '@\/utils\/alerts\/editorPayloads'/)
  assert.match(src('pages/ExploreView.jsx'), /onOpenLink\(\{ view: 'alertEditor', \.\.\.alertPayloadForExplore\(editor, committed\) \}\)/)
  assert.match(src('components/explore/ResultsToolbar.jsx'), />\s*Create alert\s*</)
})
