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

// ---------- Every builder spelling reads back ----------
// The other direction, from chips. The builder's query text is how a query
// travels (recents, Copy, a pasted query, the Errors page URL), and each of
// those reads it back here, so every spelling chipsToString writes has to come
// back as the chip it came from: the same op and the same value. The values are
// the awkward ones, each of which would end, open or escape something if it
// were written bare.

const leaf = (field, op, value, connector) => (
  connector ? { field, op, value, connector } : { field, op, value }
)

const AWKWARD_VALUES = [
  'timed out',                                          // a space
  'Could not get a resource from the pool',
  'say "hi" \\o/',                                      // quotes and a backslash
  'C:\\temp\\new',                                      // backslashes, a colon
  "it's",
  '"status":500',                                       // opens with a quote...
  '"a',                                                 // ...that never closes
  'a|b',                                                // a pipe
  'x | limit 5',
  '[WARN',                                              // unbalanced brackets
  'done]',
  '[WARN] pool (3/8), {retry}',                         // every bracket, a comma
  'GET redis.session:* timed out',                      // a wildcard, then a space
  'POST /v1/payments/:id/capture',
  'redis.clients.jedis.exceptions.JedisPoolException',  // dotted
  'naïve café 日本語 🚀',                                 // unicode
  '* x',                                                // operator characters up front
  '=x',
]

const VALUE_OPS = ['eq', 'neq', 'contains', 'prefix', 'phrase', 'regex', 'nregex']

function readsBack(chips) {
  const text = chipsToString(chips)
  const back = tryParseConditions(text)
  assert.equal(back.ok, true, `"${text}" did not parse: ${back.error}`)
  assert.deepEqual(back.chips, chips, `"${text}" read back as something else`)
  // And it is all conditions, whole, when pipes follow it.
  assert.deepEqual(splitQuery(`${text} | limit 5`).conditions, text, `"${text}" lost its pipe boundary`)
  assert.deepEqual(splitQuery(`${text} | limit 5`).pipes, ['limit 5'], `"${text}" lost its pipes`)
  return text
}

for (const v of AWKWARD_VALUES) {
  test(`builder spelling: every op reads back with ${JSON.stringify(v)}`, () => {
    for (const op of VALUE_OPS) readsBack([leaf('exception.type', op, v)])
    readsBack([leaf('http.route', 'in', [v, 'GET /v1/search'])])
    readsBack([leaf('http.route', 'not_in', [v])])
    // Promoted into the {} block.
    readsBack([leaf('service', 'eq', v)])
    readsBack([leaf('service', 'in', [v, 'order-service'])])
    // All of them in one query, so each term has to end where it should with
    // another after it, inside a group and out.
    const [first, ...rest] = VALUE_OPS
    readsBack([
      leaf('_msg', first, v),
      ...rest.map((op, i) => leaf('_msg', op, v, i % 2 ? 'OR' : 'AND')),
      { kind: 'group', connector: 'AND', children: [leaf('_msg', 'contains', v), leaf('http.route', 'prefix', v, 'OR')] },
    ])
  })
}

test('builder spelling: a word that reads bare comes back as a word', () => {
  for (const v of ['java.lang.RuntimeException', 'http://x/y?z=1', 'a\\b', '[WARN', 'done]', 'ünïcödé', '!x']) {
    readsBack([leaf('_msg', 'word', v)])
  }
})

test('builder spelling: the no-value ops, and starts-with or contains on nothing', () => {
  readsBack([leaf('log.exception.type', 'exists', '')])
  readsBack([leaf('log.exception.type', 'empty', '')])
  assert.equal(readsBack([leaf('_msg', 'prefix', '')]), '_msg:""*')
  assert.equal(readsBack([leaf('_msg', 'contains', '')]), '_msg:**')
})

test('builder spelling: a word it has to quote is written, and read, as the phrase', () => {
  // Not a loss in the parser: `f:"a b"` is the one spelling of both, and LogsQL
  // reads a quoted word as a phrase, the same tokens in order.
  const text = chipsToString([leaf('span_name', 'word', 'GET /v1/search')])
  assert.deepEqual(parseConditions(text), [leaf('span_name', 'phrase', 'GET /v1/search')])
})

test('parse: quoted contains and starts-with, the LogsQL spelling for a value with a space', () => {
  assert.deepEqual(parseConditions('_msg:*"timed out"*'), [leaf('_msg', 'contains', 'timed out')])
  assert.deepEqual(parseConditions('_msg:"Could not"*'), [leaf('_msg', 'prefix', 'Could not')])
  assert.deepEqual(parseConditions("_msg:*'timed out'*"), [leaf('_msg', 'contains', 'timed out')])
})

test('parse: a | inside a quoted contains is part of the value, not the pipes', () => {
  // The bug: this read back as a contains on `"a`, and the rest went unread.
  assert.deepEqual(parseConditions('f:*"a|b"*'), [leaf('f', 'contains', 'a|b')])
  assert.deepEqual(splitQuery('f:*"a|b"* | limit 5'), { conditions: 'f:*"a|b"*', pipeText: 'limit 5', pipes: ['limit 5'] })
})

test('parse: a bare contains that opens with a quote still reads bare', () => {
  assert.deepEqual(parseConditions('f:*"status":500*'), [leaf('f', 'contains', '"status":500')])
  assert.deepEqual(parseConditions('f:*"a"*'), [leaf('f', 'contains', '"a"')])
  assert.deepEqual(parseConditions('f:*"a*'), [leaf('f', 'contains', '"a')])
})

test('parse: when a later quote closes a bare contains, the query is read again with it bare', () => {
  // `"a* OR g:` looks like a whole quoted contains until ` x"` fails to parse.
  const chips = [leaf('f', 'contains', '"a'), leaf('g', 'phrase', '* x', 'OR')]
  assert.deepEqual(parseConditions('f:*"a* OR g:"* x"'), chips)
  readsBack(chips)
})

test('parse: a quoted contains may open with a quote, which is what keeps it apart from two bare ones', () => {
  // Bare, `f:*"a* AND g:*x"*` is two contains, on `"a` and on `x"`, and also,
  // character for character, one on `a* AND g:*x`; the parser takes the second.
  // Quoting the value that opens with a quote leaves only the first reading.
  assert.deepEqual(parseConditions('f:*"a* AND g:*x"*'), [leaf('f', 'contains', 'a* AND g:*x')])
  assert.deepEqual(parseConditions('f:*"\\"a"* AND g:*x"*'), [leaf('f', 'contains', '"a'), leaf('g', 'contains', 'x"', 'AND')])
  assert.deepEqual(parseConditions('_msg:*"\\"status\\":500"*'), [leaf('_msg', 'contains', '"status":500')])
  assert.deepEqual(parseConditions(`f:*"'a"*`), [leaf('f', 'contains', "'a")])
})

test('split: a quote inside a bare value opens nothing', () => {
  assert.deepEqual(splitQuery("f:*it's* | limit 5").pipes, ['limit 5'])
  // The bug: the scan opened a quote at `a"b` and closed it at g's opening one,
  // so the `|` inside g's value split the query.
  assert.deepEqual(splitQuery('f:*a"b* AND g:"x|y"'), { conditions: 'f:*a"b* AND g:"x|y"', pipeText: '', pipes: [] })
})

test('split: a bracket inside a bare value nests nothing', () => {
  assert.deepEqual(splitQuery('f:*[WARN* | limit 5').pipes, ['limit 5'])
  assert.deepEqual(splitQuery('f:*done]* | limit 5').pipes, ['limit 5'])
})

test('split: text the parser cannot read still splits on the character scan', () => {
  assert.deepEqual(splitQuery('* | stats count()'), { conditions: '*', pipeText: 'stats count()', pipes: ['stats count()'] })
  assert.deepEqual(splitQuery('_time:[a, b) | limit 5').pipes, ['limit 5'])
})

// ---------- Errors ----------

test('error: unterminated quote', () => {
  const r = tryParseConditions('path:~"^/api')
  assert.equal(r.ok, false)
  assert.match(r.error, /Unterminated/i)
})

test('error: an unterminated quote is reported wherever it opens', () => {
  for (const q of ['_msg:"Could not', '_msg:"Could not*', 'f:="a b', 'service in ("a", "b', '{env="prod'])
    assert.match(tryParseConditions(q).error ?? '', /Unterminated/i, q)
})

test('error: a mistake after a quoted contains holding a | is the error, not a pipe', () => {
  // The bug: re-reading `"a|b"` bare stopped at its `|`, so `f:*"a` came back
  // as the whole query and the stray `)` went into a pipe `b"* )`.
  const r = tryParseConditions('f:*"a|b"* )')
  assert.equal(r.ok, false)
  assert.match(r.error, /Unmatched/i)
  assert.equal(splitQuery('f:*"a|b"* )').conditions, 'f:*"a|b"* )')
})

test('error: a mistake at the end of a long query is found without re-reading it once per contains', () => {
  // The bug: each quoted contains before the stray `)` cost a re-read of the
  // whole text, so the time grew with the square of the length: 2.7s here.
  const text = `${'_msg:*"timed out"* AND '.repeat(4000)})`
  const t0 = performance.now()
  const r = tryParseConditions(text)
  const ms = performance.now() - t0
  assert.ok(ms < 500, `took ${Math.round(ms)}ms`)
  assert.equal(r.ok, false)
  assert.match(r.error, /Unmatched/i)
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
