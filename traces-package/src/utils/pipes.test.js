// Runnable with: node src/utils/pipes.test.js
// Fixtures are the exact strings the CubeAPM playground Explore Builder
// generates for the same input — this file is the contract between our UI
// state and the CubeAPM query grammar.

import assert from 'node:assert/strict'
import {
  serializePipe,
  serializePipes,
  composeQuery,
  validatePipe,
  namesInScopeBefore,
  parsePipeStage,
  parsePipes,
} from './pipes.js'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

// ---------- Stats serialization ----------

test('stats: orphan group-by (no functions) serializes to empty', () => {
  const pipe = { kind: 'stats', groupBy: ['service'], functions: [] }
  assert.equal(serializePipe(pipe), '')
})

test('stats: bare count()', () => {
  const pipe = { kind: 'stats', groupBy: [], functions: [{ fn: 'count', field: '' }] }
  assert.equal(serializePipe(pipe), 'stats count()')
})

test('stats: bare quantile keeps trailing comma when field empty', () => {
  const pipe = { kind: 'stats', groupBy: [], functions: [{ fn: 'quantile', p: 0.9, field: '' }] }
  assert.equal(serializePipe(pipe), 'stats quantile(0.9, )')
})

test('stats: quantile with field', () => {
  const pipe = { kind: 'stats', groupBy: [], functions: [{ fn: 'quantile', p: 0.99, field: 'duration_ms' }] }
  assert.equal(serializePipe(pipe), 'stats quantile(0.99, duration_ms)')
})

test('stats: group-by service + quantile-with-as + count (playground fixture)', () => {
  const pipe = {
    kind: 'stats',
    groupBy: ['service'],
    functions: [
      { fn: 'quantile', p: 0.9, field: '', as: 'p90_lat' },
      { fn: 'count', field: '' },
    ],
  }
  assert.equal(
    serializePipe(pipe),
    'stats by ("service") quantile(0.9, ) as "p90_lat", count()'
  )
})

test('stats: group by multiple fields', () => {
  const pipe = {
    kind: 'stats',
    groupBy: ['service', 'env'],
    functions: [{ fn: 'count', field: '' }],
  }
  assert.equal(serializePipe(pipe), 'stats by ("service", "env") count()')
})

test('stats: count with a field arg', () => {
  const pipe = { kind: 'stats', groupBy: [], functions: [{ fn: 'count', field: 'trace_id' }] }
  assert.equal(serializePipe(pipe), 'stats count(trace_id)')
})

test('stats: function with if clause', () => {
  const pipe = {
    kind: 'stats',
    groupBy: [],
    functions: [{ fn: 'count', field: '', if: 'log.level:=error', as: 'err_count' }],
  }
  assert.equal(
    serializePipe(pipe),
    'stats count() if (log.level:=error) as "err_count"'
  )
})

test('stats: avg + sum grouped by env', () => {
  const pipe = {
    kind: 'stats',
    groupBy: ['env'],
    functions: [
      { fn: 'avg', field: 'duration_ms', as: 'avg_dur' },
      { fn: 'sum', field: 'duration_ms', as: 'total_dur' },
    ],
  }
  assert.equal(
    serializePipe(pipe),
    'stats by ("env") avg(duration_ms) as "avg_dur", sum(duration_ms) as "total_dur"'
  )
})

// ---------- Math serialization ----------

test('math: simple expression with as', () => {
  const pipe = { kind: 'math', expression: 'errors / requests * 100', as: 'error_pct' }
  assert.equal(serializePipe(pipe), 'math errors / requests * 100 as error_pct')
})

test('math: expression without as', () => {
  const pipe = { kind: 'math', expression: 'a + b', as: '' }
  assert.equal(serializePipe(pipe), 'math a + b')
})

test('math: as with special chars gets quoted', () => {
  const pipe = { kind: 'math', expression: 'a', as: 'a name' }
  assert.equal(serializePipe(pipe), 'math a as "a name"')
})

test('math: empty pipe yields bare "math"', () => {
  assert.equal(serializePipe({ kind: 'math', expression: '', as: '' }), 'math')
})

// ---------- Sort / Limit ----------

test('sort: single field default desc', () => {
  assert.equal(serializePipe({ kind: 'sort', field: 'duration_ms', dir: 'desc' }), 'sort ("duration_ms") desc')
})

test('sort: single field asc omits keyword', () => {
  assert.equal(serializePipe({ kind: 'sort', field: 'duration_ms', dir: 'asc' }), 'sort ("duration_ms")')
})

test('limit: default 100', () => {
  assert.equal(serializePipe({ kind: 'limit', n: 100 }), 'limit 100')
})

test('limit: fractional n floored, min 1', () => {
  assert.equal(serializePipe({ kind: 'limit', n: 10.7 }), 'limit 10')
  assert.equal(serializePipe({ kind: 'limit', n: 0 }), 'limit 1')
})

// ---------- Chaining + composeQuery ----------

test('serializePipes: chains multiple pipes with " | "', () => {
  const pipes = [
    { kind: 'stats', groupBy: ['service'], functions: [{ fn: 'count', field: '' }] },
    { kind: 'sort', field: 'count', dir: 'desc' },
    { kind: 'limit', n: 10 },
  ]
  assert.equal(
    serializePipes(pipes),
    'stats by ("service") count() | sort ("count") desc | limit 10'
  )
})

test('composeQuery: no conditions + pipes prepends *', () => {
  const pipes = [{ kind: 'stats', groupBy: [], functions: [{ fn: 'count', field: '' }] }]
  assert.equal(composeQuery('', pipes), '* | stats count()')
})

test('composeQuery: conditions + pipes', () => {
  const pipes = [{ kind: 'stats', groupBy: [], functions: [{ fn: 'count', field: '' }] }]
  assert.equal(
    composeQuery('{service="payment"}', pipes),
    '{service="payment"} | stats count()'
  )
})

test('composeQuery: no pipes returns conditions unchanged', () => {
  assert.equal(composeQuery('{service="payment"}', []), '{service="payment"}')
})

test('composeQuery: nothing yields empty string', () => {
  assert.equal(composeQuery('', []), '')
})

// ---------- Validation ----------

test('validate: stats needs at least one function', () => {
  const errs = validatePipe({ kind: 'stats', groupBy: [], functions: [] })
  assert.ok(errs.some(e => /at least one/i.test(e.msg)))
})

test('validate: unknown function reported', () => {
  const errs = validatePipe({ kind: 'stats', groupBy: [], functions: [{ fn: 'zap', field: '' }] })
  assert.ok(errs.some(e => /Unknown function/i.test(e.msg)))
})

test('validate: avg without field flagged', () => {
  const errs = validatePipe(
    { kind: 'stats', groupBy: [], functions: [{ fn: 'avg', field: '' }] },
    { numericFields: new Set(['duration_ms']) }
  )
  assert.ok(errs.some(e => /avg needs a field/i.test(e.msg)))
})

test('validate: avg with non-numeric field flagged', () => {
  const errs = validatePipe(
    { kind: 'stats', groupBy: [], functions: [{ fn: 'avg', field: 'service' }] },
    { numericFields: new Set(['duration_ms']) }
  )
  assert.ok(errs.some(e => /numeric field/i.test(e.msg)))
})

test('validate: quantile p out of range', () => {
  const errs = validatePipe(
    { kind: 'stats', groupBy: [], functions: [{ fn: 'quantile', p: 2, field: 'duration_ms' }] },
    { numericFields: new Set(['duration_ms']) }
  )
  assert.ok(errs.some(e => /between 0 and 1/i.test(e.msg)))
})

test('validate: count is always ok without a field', () => {
  const errs = validatePipe({ kind: 'stats', groupBy: [], functions: [{ fn: 'count', field: '' }] })
  assert.equal(errs.length, 0)
})

test('validate: invalid as identifier flagged', () => {
  const errs = validatePipe({ kind: 'stats', groupBy: [], functions: [{ fn: 'count', field: '', as: '1bad' }] })
  assert.ok(errs.some(e => /letter or underscore/i.test(e.msg)))
})

test('validate: duplicate as names flagged', () => {
  const errs = validatePipe(
    {
      kind: 'stats', groupBy: [],
      functions: [
        { fn: 'count', field: '', as: 'x' },
        { fn: 'sum', field: 'dur', as: 'x' },
      ],
    },
    { numericFields: new Set(['dur']) }
  )
  assert.ok(errs.some(e => /Duplicate name/i.test(e.msg)))
})

test('validate: math requires expression', () => {
  const errs = validatePipe({ kind: 'math', expression: '', as: '' })
  assert.ok(errs.some(e => /required/i.test(e.msg)))
})

test('validate: unbalanced parens in math', () => {
  const errs = validatePipe({ kind: 'math', expression: '(a + b', as: '' })
  assert.ok(errs.some(e => /parentheses/i.test(e.msg)))
})

test('validate: sort needs field', () => {
  const errs = validatePipe({ kind: 'sort', field: '', dir: 'desc' })
  assert.ok(errs.some(e => /sort by/i.test(e.msg)))
})

test('validate: limit must be positive', () => {
  const errs = validatePipe({ kind: 'limit', n: 0 })
  assert.ok(errs.some(e => /positive/i.test(e.msg)))
})

// ---------- Scope helpers ----------

test('namesInScopeBefore: collects preceding stats and math aliases', () => {
  const pipes = [
    { kind: 'stats', groupBy: [], functions: [{ fn: 'count', field: '', as: 'errors' }, { fn: 'count', field: '', as: 'requests' }] },
    { kind: 'math', expression: 'errors / requests * 100', as: 'error_pct' },
    { kind: 'math', expression: 'error_pct + 1', as: 'incremented' },
  ]
  assert.deepEqual(namesInScopeBefore(pipes, 0), [])
  assert.deepEqual(namesInScopeBefore(pipes, 1), ['errors', 'requests'])
  assert.deepEqual(namesInScopeBefore(pipes, 2), ['errors', 'requests', 'error_pct'])
})

// ---------- Runner ----------


// ---------- Parsing ----------
// The contract: anything the builder can emit parses back to a pipe that
// serializes identically. If a serializer changes without the parser, this
// fails rather than silently dropping part of a pasted query.

const ROUND_TRIP = [
  'stats count()',
  'stats count_uniq(service)',
  'stats by ("service") count()',
  'stats by ("service", "env") count(), avg(duration_ms)',
  'stats quantile(0.9, duration_ms)',
  'stats by ("env") quantile(0.95, duration_ms) as "p95", count()',
  'stats avg(duration_ms) if (log.level:error) as "slow errors"',
  'math a / b as ratio',
  'math a / b',
  'math (errors / total) * 100 as "error rate"',
  'sort ("duration_ms") desc',
  'sort ("duration_ms")',
  'limit 100',
  'limit 25',
  'keep (a, b)',
  'unpack_json',
]

for (const q of ROUND_TRIP) {
  test(`round-trips: ${q}`, () => {
    assert.equal(serializePipe(parsePipeStage(q)), q)
  })
}

test('parse: group-by and functions land on the right fields', () => {
  const p = parsePipeStage('stats by ("service", "env") quantile(0.9, duration_ms) as "p90"')
  assert.equal(p.kind, 'stats')
  assert.deepEqual(p.groupBy, ['service', 'env'])
  assert.equal(p.functions.length, 1)
  assert.equal(p.functions[0].fn, 'quantile')
  assert.equal(p.functions[0].p, 0.9)
  assert.equal(p.functions[0].field, 'duration_ms')
  assert.equal(p.functions[0].as, 'p90')
})

test('parse: an if clause is captured whole, commas and all', () => {
  const p = parsePipeStage('stats count() if (service:a AND log.level:error) as "x", avg(duration_ms)')
  assert.equal(p.functions.length, 2)
  assert.equal(p.functions[0].if, 'service:a AND log.level:error')
  assert.equal(p.functions[1].fn, 'avg')
})

test('parse: sort defaults to asc when no direction is given', () => {
  assert.equal(parsePipeStage('sort ("duration_ms")').dir, 'asc')
  assert.equal(parsePipeStage('sort ("duration_ms") desc').dir, 'desc')
})

test('parse: a stage with no builder control is carried verbatim', () => {
  const p = parsePipeStage('rename (a, b)')
  assert.equal(p.kind, 'raw')
  assert.equal(serializePipe(p), 'rename (a, b)')
})

test('parse: malformed stages report why', () => {
  assert.throws(() => parsePipeStage('stats bogus('), /Unknown aggregation "bogus"/)
  assert.throws(() => parsePipeStage('stats'), /at least one aggregation/)
  assert.throws(() => parsePipeStage('limit abc'), /needs a number/)
  assert.throws(() => parsePipeStage('frobnicate x'), /Unknown pipe "frobnicate"/)
})

test('parsePipes: reports a malformed stage without throwing', () => {
  const r = parsePipes(['stats count()', 'limit abc'])
  assert.equal(r.ok, false)
  assert.match(r.error, /needs a number/)
  assert.equal(r.fatal, undefined)
})

test('parsePipes: a repeated singleton stage is fatal', () => {
  const r = parsePipes(['stats count()', 'stats avg(duration_ms)'])
  assert.equal(r.ok, false)
  assert.equal(r.fatal, true)
  assert.match(r.error, /more than one "stats"/)
})

test('parsePipes: repeated math is fine — math is genuinely multi', () => {
  const r = parsePipes(['math a as x', 'math b as y'])
  assert.equal(r.ok, true)
  assert.equal(r.pipes.length, 2)
})

test('parsePipes: names the stages it had to carry verbatim', () => {
  const r = parsePipes(['stats count()', 'keep (a)', 'unpack_json'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.unsupported, ['keep', 'unpack_json'])
  assert.equal(serializePipes(r.pipes), 'stats count() | keep (a) | unpack_json')
})

let passed = 0, failed = 0
for (const { name, fn } of tests) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`      ${e.message.split('\n').join('\n      ')}`)
    failed++
  }
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
