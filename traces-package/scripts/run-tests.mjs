// Test runner. Finds every src/**/*.test.js, bundles it with esbuild (so tests
// can use the @/ alias and import JSX modules), then runs each bundle in node.
// esbuild comes in via vite, so there's no extra dependency to install.

import { build } from 'esbuild'
import { readdirSync, statSync, mkdtempSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))

function findTests(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) findTests(full, out)
    else if (entry.endsWith('.test.js')) out.push(full)
  }
  return out
}

const tests = findTests(join(root, 'src')).sort()
if (tests.length === 0) {
  console.error('No *.test.js files found under src/.')
  process.exit(1)
}

const outDir = mkdtempSync(join(tmpdir(), 'cubeapm-tests-'))
let failed = 0

for (const file of tests) {
  const name = relative(root, file)
  const outfile = join(outDir, name.replace(/[\\/]/g, '_') + '.mjs')
  console.log(`\n▶ ${name}`)
  try {
    await build({
      entryPoints: [file],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      alias: { '@': join(root, 'src') },
      loader: { '.js': 'jsx' },
      // Automatic runtime, so a component under test compiles without each
      // module importing React itself - the app's JSX is written that way.
      jsx: 'automatic',
      logLevel: 'error',
    })
    execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
  } catch {
    failed++
  }
}

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed.`)
  process.exit(1)
}
console.log('\nAll test files passed.')
