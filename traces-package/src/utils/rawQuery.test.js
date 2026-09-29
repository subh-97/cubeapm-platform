// Runnable with: node --experimental-strip-types src/utils/rawQuery.test.js
// (or via the npm script). The critical property under test is the round trip:
// chipsToString(parseConditions(x)) === x for anything the builder can emit.

import assert from 'node:assert/strict'
import { splitQuery, replacePipeSection, parseConditions, tryParseConditions, validatePipeText, suggestRaw } from './rawQuery.js'
import { chipsToString } from '../components/QueryBuilder.jsx'

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

// ---------- Splitting ----------

test('split: no pipes', () => {
  assert.deepEqual(splitQuery('service:payment'), { conditions: 'service:payment', pipeText: '', pipes: [] })
})

test('split: conditions + pipes', () => {
  const r = splitQuery('service:payment | stats count() | limit 10')
  assert.equal(r.conditions, 'service:payment')
  assert.deepEqual(r.pipes, ['stats count()', 'limit 10'])
})

test('split: pipe inside a regex literal is not a delimiter', () => {
  const r = splitQuery('path:~"a|b" | stats count()')
  assert.equal(r.conditions, 'path:~"a|b"')
  assert.deepEqual(r.pipes, ['stats count()'])
})

test('split: pipe inside parens is not a delimiter', () => {
  const r = splitQuery('service in ("a|b", "c") | limit 5')
  assert.equal(r.conditions, 'service in ("a|b", "c")')
  assert.deepEqual(r.pipes, ['limit 5'])
})

test('replacePipeSection: swaps the tail, keeps the head', () => {
  assert.equal(
    replacePipeSection('service:payment | stats count()', 'limit 10'),
    'service:payment | limit 10'
  )
})

test('replacePipeSection: bare conditions gain a pipe section', () => {
  assert.equal(replacePipeSection('service:payment', 'limit 10'), 'service:payment | limit 10')
})

test('replacePipeSection: empty conditions get the * match-all head', () => {
  assert.equal(replacePipeSection('', 'stats count()'), '* | stats count()')
})

test('replacePipeSection: empty pipes drop the separator', () => {
  assert.equal(replacePipeSection('service:payment | limit 10', ''), 'service:payment')
})

// ---------- Conditions parsing ----------

test('parse: empty and match-all yield no chips', () => {
  assert.deepEqual(parseConditions(''), [])
  assert.deepEqual(parseConditions('*'), [])
})

test('parse: word match', () => {
  assert.deepEqual(parseConditions('service:payment'), [{ field: 'service', op: 'word', value: 'payment' }])
})

test('parse: exact match', () => {
  assert.deepEqual(parseConditions('service:=payment'), [{ field: 'service', op: 'eq', value: 'payment' }])
})

test('parse: not equal', () => {
  assert.deepEqual(parseConditions('service!=payment'), [{ field: 'service', op: 'neq', value: 'payment' }])
})

test('parse: exists vs contains vs prefix', () => {
  assert.deepEqual(parseConditions('service:*'), [{ field: 'service', op: 'exists', value: '' }])
  assert.deepEqual(parseConditions('path:*pay*'), [{ field: 'path', op: 'contains', value: 'pay' }])
  assert.deepEqual(parseConditions('http.status:5*'), [{ field: 'http.status', op: 'prefix', value: '5' }])
})

test('parse: empty value', () => {
  assert.deepEqual(parseConditions('service:""'), [{ field: 'service', op: 'empty', value: '' }])
})

test('parse: phrase', () => {
  assert.deepEqual(parseConditions('_msg:"connection refused"'), [{ field: '_msg', op: 'phrase', value: 'connection refused' }])
})

test('parse: regex and negated regex', () => {
  assert.deepEqual(parseConditions('path:~"^/api"'), [{ field: 'path', op: 'regex', value: '^/api' }])
  assert.deepEqual(parseConditions('path!~"^/health"'), [{ field: 'path', op: 'nregex', value: '^/health' }])
})

test('parse: in / not_in lists', () => {
  assert.deepEqual(parseConditions('service in ("a", "b")'), [{ field: 'service', op: 'in', value: ['a', 'b'] }])
  assert.deepEqual(parseConditions('service not_in ("a", "b")'), [{ field: 'service', op: 'not_in', value: ['a', 'b'] }])
})

test('parse: implicit AND between terms', () => {
  const chips = parseConditions('service:payment log.level:error')
  assert.equal(chips.length, 2)
  assert.equal(chips[1].connector, 'AND')
})

test('parse: explicit OR connector', () => {
  const chips = parseConditions('log.level:=error OR log.level:=warn')
  assert.equal(chips.length, 2)
  assert.equal(chips[1].connector, 'OR')
})

test('parse: stream selector becomes chips', () => {
  const chips = parseConditions('{env="prod", service="payment"}')
  assert.deepEqual(chips[0], { field: 'env', op: 'eq', value: 'prod' })
  assert.equal(chips[1].field, 'service')
  assert.equal(chips[1].connector, 'AND')
})

test('parse: stream selector with in()', () => {
  const chips = parseConditions('{service in ("order", "payment")}')
  assert.deepEqual(chips[0], { field: 'service', op: 'in', value: ['order', 'payment'] })
})

test('parse: stream selector plus trailing conditions', () => {
  const chips = parseConditions('{env="prod"} log.level:=error')
  assert.equal(chips.length, 2)
  assert.equal(chips[0].op, 'eq')
  assert.equal(chips[1].field, 'log.level')
})

// ---------- Round trip ----------
// The real contract: anything the builder serializes must parse back to chips
// that re-serialize identically. Note `service` and `env` are stream-eligible,
// so chipsToString promotes them into a leading {} block — for those the
// property is normalization stability, not string identity.

const ROUND_TRIP = [
  'service:payment',
  'path:*pay*',
  'http.status:5*',
  '_msg:"connection refused"',
  'path:~"^/api"',
  'path!~"^/health"',
  'log.exception.type:*',
  'log.exception.type:""',
  '{env="prod"} log.level:=error',
  '{env="prod", service="payment"} log.level:=error',
  '{service in ("order", "payment")} log.level:=error',
  'log.level:=error OR log.level:=warn',
  'log.level:=error AND log.level:=warn',
  // Groups. `log.level`, `path` and `http.status` are not stream-eligible, so
  // nothing gets promoted into a leading {} block and the string is exact.
  '(log.level:=error OR log.level:=warn) AND path:*pay*',
  '(log.level:=error AND path:*pay*) OR (log.level:=warn AND path:*ord*)',
  '((log.level:=error OR log.level:=warn) AND path:*pay*) OR http.status:5*',
  'path:*pay* AND (log.level:=error OR log.level:=warn)',
]

for (const q of ROUND_TRIP) {
  test(`round trip: ${q}`, () => {
    assert.equal(chipsToString(parseConditions(q)), q)
  })
}

// Stream-eligible fields written in plain form normalize into the {} block,
// and that normalized form is then a fixed point.
const NORMALIZES = [
  ['service:=payment', '{service="payment"}'],
  ['service!=payment', '{service!="payment"}'],
  ['service in ("order", "payment")', '{service in ("order", "payment")}'],
  ['service not_in ("order", "payment")', '{service not_in ("order", "payment")}'],
]

for (const [input, normalized] of NORMALIZES) {
  test(`normalizes: ${input}`, () => {
    const once = chipsToString(parseConditions(input))
    assert.equal(once, normalized)
    // Idempotent: re-parsing the normalized form yields the same string.
    assert.equal(chipsToString(parseConditions(once)), once)
  })
}

// ---------- Errors ----------

test('error: unterminated quote', () => {
  const r = tryParseConditions('path:~"^/api')
  assert.equal(r.ok, false)
  assert.match(r.error, /Unterminated/i)
})

test('error: unclosed value list', () => {
  const r = tryParseConditions('service in ("a", "b"')
  assert.equal(r.ok, false)
  assert.match(r.error, /Unclosed value list/i)
})

test('error: unclosed stream selector', () => {
  const r = tryParseConditions('{env="prod"')
  assert.equal(r.ok, false)
  assert.match(r.error, /Unclosed stream selector/i)
})

test('error: missing operator', () => {
  const r = tryParseConditions('service')
  assert.equal(r.ok, false)
  assert.match(r.error, /Expected an operator/i)
})

test('error: missing value after colon', () => {
  const r = tryParseConditions('service:')
  assert.equal(r.ok, false)
  assert.match(r.error, /Missing value/i)
})

test('error: NOT is rejected with a pointer to the supported form', () => {
  const r = tryParseConditions('service:=a NOT service:=b')
  assert.equal(r.ok, false)
  assert.match(r.error, /not_in/i)
})

test('parse: a group becomes a group node', () => {
  const chips = parseConditions('(log.level:=error OR log.level:=warn) AND path:*pay*')
  assert.equal(chips.length, 2)
  assert.equal(chips[0].kind, 'group')
  assert.equal(chips[0].children.length, 2)
  assert.equal(chips[0].children[1].connector, 'OR')
  assert.equal(chips[1].connector, 'AND')
})

test('parse: a single-child group unwraps to a bare chip', () => {
  assert.deepEqual(parseConditions('(log.level:=error)'), [
    { field: 'log.level', op: 'eq', value: 'error' },
  ])
})

test('parse: groups nest', () => {
  const chips = parseConditions('((log.level:=error OR log.level:=warn) AND path:*pay*) OR http.status:5*')
  assert.equal(chips[0].kind, 'group')
  assert.equal(chips[0].children[0].kind, 'group')
  assert.equal(chips[0].children[0].children.length, 2)
  assert.equal(chips[1].connector, 'OR')
})

test('parse: in() parens are values, not groups', () => {
  const chips = parseConditions('log.level in ("error", "warn")')
  assert.deepEqual(chips, [{ field: 'log.level', op: 'in', value: ['error', 'warn'] }])
})

test('error: unclosed paren', () => {
  const r = tryParseConditions('(log.level:=error OR log.level:=warn')
  assert.equal(r.ok, false)
  assert.match(r.error, /Unclosed/i)
})

test('error: unmatched closing paren', () => {
  const r = tryParseConditions('log.level:=error)')
  assert.equal(r.ok, false)
  assert.match(r.error, /Unmatched/i)
})

test('error: empty group', () => {
  const r = tryParseConditions('() AND log.level:=error')
  assert.equal(r.ok, false)
  assert.match(r.error, /Empty group/i)
})

test('error: bad stream operator', () => {
  const r = tryParseConditions('{env:prod}')
  assert.equal(r.ok, false)
  assert.match(r.error, /Stream selector supports/i)
})

// ---------- Pipe validation ----------

test('validatePipeText: accepts known pipes', () => {
  assert.equal(validatePipeText(['stats count()', 'limit 10']), null)
})

test('validatePipeText: flags an unknown pipe', () => {
  assert.match(validatePipeText(['statz count()']), /Unknown pipe/i)
})

test('validatePipeText: flags a bare stats', () => {
  assert.match(validatePipeText(['stats']), /at least one aggregation/i)
})

test('validatePipeText: accepts raw-only pipes', () => {
  assert.equal(validatePipeText(['unpack_json', 'drop foo']), null)
})

// ---------- Suggestions ----------

test('suggest: empty input offers fields', () => {
  const r = suggestRaw('', 0)
  assert.ok(r.items.some(i => i.value === 'service'))
  assert.ok(r.items.some(i => i.value === '_msg'))
})

// The bug this pins: a flat cap over the concatenated list drops whatever sits
// last, so growing the field catalogue silently cost the raw editor its
// built-ins and its boolean keywords. Deliberately asserts nothing about how
// many fields come back - only that a bigger catalogue can never crowd out a
// category, which is the property that broke.
test('suggest: a large field catalogue cannot crowd out the other categories', () => {
  const empty = suggestRaw('', 0)
  for (const b of ['_msg', '_time', '_stream']) {
    assert.ok(empty.items.some(i => i.value === b), `built-in ${b} missing from an empty query`)
  }
  const after = suggestRaw('service:=payment ', 17)
  for (const k of ['AND', 'OR', '|']) {
    assert.ok(after.items.some(i => i.value === k), `keyword ${k} missing after a term`)
  }
  // The catalogue itself is still capped - the point is where the cap applies.
  assert.ok(empty.items.filter(i => i.kind === 'field').length <= 20)
})

test('suggest: partial field name filters', () => {
  const r = suggestRaw('serv', 4)
  assert.ok(r.items.every(i => /^serv/i.test(i.value)))
  assert.equal(r.from, 0)
  assert.equal(r.to, 4)
})

test('suggest: complete field name offers operators', () => {
  const r = suggestRaw('service', 7)
  assert.ok(r.items.some(i => i.value === ':='))
  assert.ok(r.items.every(i => i.replaceWith?.startsWith('service')))
})

test('suggest: after an operator offers values', () => {
  const r = suggestRaw('service:=', 9)
  assert.ok(r.items.length > 0)
  assert.ok(r.items.every(i => i.replaceWith?.startsWith('service:=')))
})

test('suggest: after a term offers boolean keywords and the pipe opener', () => {
  const r = suggestRaw('service:=payment ', 17)
  assert.ok(r.items.some(i => i.value === 'AND'))
  assert.ok(r.items.some(i => i.value === 'OR'))
  assert.ok(r.items.some(i => i.value === '|'))
})

test('suggest: after | offers pipe names', () => {
  const r = suggestRaw('service:=payment | ', 19)
  assert.ok(r.items.some(i => i.value === 'stats'))
  assert.ok(r.items.some(i => i.value === 'unpack_json'))
})

test('suggest: partial pipe name filters', () => {
  const r = suggestRaw('* | st', 6)
  assert.ok(r.items.some(i => i.value === 'stats'))
  assert.ok(r.items.every(i => /^st/i.test(i.value)))
})

test('suggest: inside stats offers aggregation functions', () => {
  const r = suggestRaw('* | stats ', 10)
  assert.ok(r.items.some(i => i.value === 'count('))
  assert.ok(r.items.some(i => i.value === 'quantile('))
  assert.ok(r.items.some(i => i.value === 'by ('))
})

test('suggest: inside stats by () offers fields', () => {
  const r = suggestRaw('* | stats by (', 14)
  assert.ok(r.items.some(i => i.value === 'service'))
})

test('suggest: sort offers direction keywords', () => {
  const r = suggestRaw('* | stats count() | sort ("x") ', 31)
  assert.ok(r.items.some(i => i.value === 'desc'))
})

test('suggest: limit offers preset counts', () => {
  const r = suggestRaw('* | limit ', 10)
  assert.ok(r.items.some(i => i.value === '100'))
})

// ---------- Runner ----------

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
