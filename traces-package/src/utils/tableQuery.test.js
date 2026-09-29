// The pod filter language: two fields, unions, AND/OR, and the errors people
// actually type their way into.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePodQuery, matchesPod, highlightsFor, segmentQuery, placeholderFor,
  tagHighlightsFor, tagTerms,
  POD_FIELDS, POD_NODE_FIELDS, SERVICE_FIELDS,
} from './tableQuery.js'

const pod = (name, namespace) => ({ name, namespace })
const PODS = [
  pod('payment-service-7d8b9c-4vk2q', 'default'),
  pod('redis-0', 'default'),
  pod('coredns-66bc5c9577-zkrnm', 'kube-system'),
  pod('kube-proxy-784j7', 'kube-system'),
]

const run = (q) => {
  const r = parsePodQuery(q)
  assert.equal(r.ok, true, `expected "${q}" to parse, got: ${r.error}`)
  return PODS.filter(p => matchesPod(r.node, p)).map(p => p.name)
}
const fails = (q) => {
  const r = parsePodQuery(q)
  assert.equal(r.ok, false, `expected "${q}" to fail`)
  return r.error
}

// ---------- Nothing ----------

test('an empty query is not a filter', () => {
  assert.deepEqual(run(''), PODS.map(p => p.name))
  assert.deepEqual(run('   '), PODS.map(p => p.name))
  assert.equal(parsePodQuery('').node, null)
})

// ---------- Free text ----------

test('bare text searches both fields', () => {
  assert.deepEqual(run('redis'), ['redis-0'])
  // matches on namespace, not name
  assert.deepEqual(run('kube-system'), ['coredns-66bc5c9577-zkrnm', 'kube-proxy-784j7'])
})

test('matching is case-insensitive and substring', () => {
  assert.deepEqual(run('REDIS'), ['redis-0'])
  assert.deepEqual(run('pay'), ['payment-service-7d8b9c-4vk2q'])
})

// ---------- Fields ----------

test('a field term searches only that field', () => {
  // "kube" appears in a pod name and in a namespace; the field decides which
  assert.deepEqual(run('pod:kube'), ['kube-proxy-784j7'])
  assert.deepEqual(run('namespace:kube'), ['coredns-66bc5c9577-zkrnm', 'kube-proxy-784j7'])
})

test('field names are case-insensitive', () => {
  assert.deepEqual(run('POD:redis'), ['redis-0'])
})

test('a wildcard matches any non-empty value', () => {
  assert.deepEqual(run('pod:*').length, 4)
  assert.deepEqual(run('namespace:*').length, 4)
})

// ---------- Unions ----------

test('a union matches any of its values', () => {
  assert.deepEqual(run('pod:(redis OR coredns)'), ['redis-0', 'coredns-66bc5c9577-zkrnm'])
})

test('a union does not need the OR spelled out', () => {
  assert.deepEqual(run('pod:(redis coredns)'), ['redis-0', 'coredns-66bc5c9577-zkrnm'])
})

// ---------- Operators ----------

test('adjacent terms are ANDed', () => {
  assert.deepEqual(run('pod:redis namespace:default'), ['redis-0'])
  assert.deepEqual(run('pod:redis namespace:kube-system'), [])
})

test('AND and OR do what they say', () => {
  assert.deepEqual(run('pod:redis AND namespace:default'), ['redis-0'])
  assert.deepEqual(run('pod:redis OR pod:coredns'), ['redis-0', 'coredns-66bc5c9577-zkrnm'])
})

test('AND binds tighter than OR', () => {
  // redis (in default) OR anything in kube-system
  const out = run('pod:redis AND namespace:default OR namespace:kube-system')
  assert.deepEqual(out, ['redis-0', 'coredns-66bc5c9577-zkrnm', 'kube-proxy-784j7'])
  // Read the other way it would be redis AND (default OR kube-system) = just redis
  assert.notDeepEqual(out, ['redis-0'])
})

// ---------- Errors ----------

test('errors say what to do about them', () => {
  assert.match(fails('pod:'), /add a value, or pod:\* for any/)
  assert.match(fails('pod:(redis'), /Unclosed "\(" — add the matching "\)"/)
  assert.match(fails('pod:()'), /Empty list/)
  assert.match(fails('cpu:high'), /Unknown field "cpu"\. Search pod or namespace\./)
  assert.match(fails('pod:redis AND'), /needs something on both sides/)
  assert.match(fails('OR pod:redis'), /needs something on both sides/)
  assert.match(fails(':redis'), /needs a field name before it/)
  assert.match(fails('redis)'), /Unmatched "\)"/)
})

test('brackets outside a field value are explained, not silently accepted', () => {
  assert.match(fails('(pod:redis OR pod:coredns)'), /group the values of one field/)
})

// ---------- Highlighting ----------

test('a field term highlights only in its own column', () => {
  const { node } = parsePodQuery('pod:kube')
  assert.deepEqual(highlightsFor(node), { pod: ['kube'], namespace: [] })
})

test('free text highlights in both columns', () => {
  const { node } = parsePodQuery('redis')
  assert.deepEqual(highlightsFor(node), { pod: ['redis'], namespace: ['redis'] })
})

test('a union contributes every value, longest first', () => {
  const { node } = parsePodQuery('pod:(redis OR coredns)')
  assert.deepEqual(highlightsFor(node).pod, ['coredns', 'redis'])
})

test('a wildcard has no text to highlight', () => {
  const { node } = parsePodQuery('pod:*')
  assert.deepEqual(highlightsFor(node), { pod: [], namespace: [] })
})

test('duplicates collapse across clauses', () => {
  const { node } = parsePodQuery('pod:redis OR pod:redis')
  assert.deepEqual(highlightsFor(node).pod, ['redis'])
})

test('a field set is names paired with the row property each reads', () => {
  assert.deepEqual(POD_FIELDS.map(f => f.name), ['pod', 'namespace'])
  // the pod column reads the row's `name`, which is why they are not the same
  assert.equal(POD_FIELDS.find(f => f.name === 'pod').key, 'name')
  assert.deepEqual(POD_NODE_FIELDS.map(f => f.name), ['pod', 'namespace', 'node'])
})

// ---------- A different field set ----------

test('the same language works over a third field', () => {
  const rows = [
    { name: 'redis-0', namespace: 'default', node: 'ip-10-0-142-133' },
    { name: 'kube-proxy-784j7', namespace: 'kube-system', node: 'ip-10-0-143-40' },
  ]
  const q = (text) => {
    const r = parsePodQuery(text, POD_NODE_FIELDS)
    assert.equal(r.ok, true, r.error)
    return rows.filter(x => matchesPod(r.node, x, POD_NODE_FIELDS)).map(x => x.name)
  }
  assert.deepEqual(q('node:143-40'), ['kube-proxy-784j7'])
  assert.deepEqual(q('node:*').length, 2)
  assert.deepEqual(q('142-133'), ['redis-0'])          // free text reaches node too
})

test('a field outside the set is unknown, and the message lists the set', () => {
  assert.match(parsePodQuery('node:x').error, /Unknown field "node"\. Search pod or namespace\./)
  assert.equal(parsePodQuery('node:x', POD_NODE_FIELDS).ok, true)
  assert.match(
    parsePodQuery('cpu:x', POD_NODE_FIELDS).error,
    /Unknown field "cpu"\. Search pod, namespace or node\./,
  )
})

test('segments and highlights follow the field set too', () => {
  assert.equal(segmentQuery('node:x').some(s => s.type === 'field'), false)
  assert.equal(segmentQuery('node:x', POD_NODE_FIELDS)[0].type, 'field')

  const { node } = parsePodQuery('node:abc', POD_NODE_FIELDS)
  assert.deepEqual(highlightsFor(node, POD_NODE_FIELDS), { pod: [], namespace: [], node: ['abc'] })
})

// ---------- Display segments ----------

test('segments cover every character of the input', () => {
  const inputs = ['pod:redis AND namespace:(a OR b)', '  pod:*  ', 'plain text', '', 'pod:']
  for (const s of inputs) {
    assert.equal(segmentQuery(s).map(x => x.text).join(''), s, `round-trip failed for ${JSON.stringify(s)}`)
  }
})

test('a field is coloured only once its colon is typed', () => {
  assert.deepEqual(segmentQuery('pod').map(s => s.type), ['plain'])
  assert.deepEqual(segmentQuery('pod:'), [{ text: 'pod:', type: 'field' }])
})

test('only known field names colour', () => {
  // Adjacent same-type runs merge, so this is one plain span — the point is
  // that nothing in it is typed as a field.
  assert.equal(segmentQuery('cpu:').some(s => s.type === 'field'), false)
  assert.deepEqual(segmentQuery('cpu:'), [{ text: 'cpu:', type: 'plain' }])
})

test('brackets and operators get their own types', () => {
  const types = Object.fromEntries(segmentQuery('pod:(a OR b) AND namespace:c').map(s => [s.text.trim(), s.type]))
  assert.equal(types['pod:'], 'field')
  assert.equal(types['('], 'paren')
  assert.equal(types[')'], 'paren')
  assert.equal(types['OR'], 'op')
  assert.equal(types['AND'], 'op')
  assert.equal(types['namespace:'], 'field')
})

test('lowercase and/or still colour as operators', () => {
  assert.equal(segmentQuery('a or b').find(s => s.text === 'or')?.type, 'op')
})

test('spellings a user might reasonably type all parse', () => {
  // Nothing stops someone capitalising the field or spacing the colon out.
  for (const q of ['pod: kube', 'pod:kube', 'Pod: kube', 'POD:  kube']) {
    assert.deepEqual(run(q), ['kube-proxy-784j7'], `"${q}" should find the kube-proxy pod`)
  }
  assert.equal(segmentQuery('pod: kube')[0].type, 'field')
})

// ---------- The placeholder ----------

test('the placeholder names every searchable column', () => {
  assert.equal(placeholderFor(POD_FIELDS), 'Search pod or namespace ( eg. pod:abc AND pod.tag:value )')
  assert.equal(
    placeholderFor(POD_NODE_FIELDS),
    'Search pod, namespace or node ( eg. pod:abc AND pod.tag:value )',
  )
})

test('the form the placeholder advertises actually parses', () => {
  // A placeholder is a promise, and this one is generated — so the promise is
  // kept by pulling the worked example back out of it and running it, rather
  // than by copying the text here where it could drift.
  for (const fields of [POD_FIELDS, POD_NODE_FIELDS, SERVICE_FIELDS]) {
    const example = placeholderFor(fields).match(/eg\. (.+) \)$/)[1]
    const parsed = parsePodQuery(example, fields)
    assert.equal(parsed.ok, true, `"${example}" should parse: ${parsed.error}`)
    assert.equal(segmentQuery(example, fields)[0].type, 'field')
  }
})

// ---------- Error spans ----------

test('an error points at the characters it is about', () => {
  const at = (q) => parsePodQuery(q).span
  assert.deepEqual(at('cpu:high'), [0, 3])          // the unknown field name
  assert.deepEqual(at('pod:(redis'), [4, 5])        // the bracket left open
  assert.deepEqual(at('redis)'), [5, 6])            // the stray bracket
  assert.deepEqual(at('pod:redis AND'), [10, 13])   // the operator missing a side
  assert.deepEqual(at('pod:()'), [4, 6])            // the whole empty list
  assert.deepEqual(at('pod:'), [0, 4])              // the clause missing its value
  assert.deepEqual(at(':redis'), [0, 1])
})

test('an error says whether the query ran out or went wrong', () => {
  const inc = (q) => parsePodQuery(q).incomplete
  // The text stops mid-clause: the next keystroke could finish it, so the field
  // holds its tongue while the caret is still there.
  assert.equal(inc('pod:'), true)
  assert.equal(inc('pod:redis AND'), true)
  assert.equal(inc('pod:redis OR'), true)
  assert.equal(inc('pod:(redis'), true)
  // Already wrong, and typing more on the end will not repair it.
  assert.equal(inc('cpu:high'), false)
  assert.equal(inc('redis)'), false)
  assert.equal(inc('pod:()'), false)
  assert.equal(inc('pod: )'), false)
  assert.equal(inc(':redis'), false)
  assert.equal(inc('(pod:redis)'), false)
  // and a query that parses has nothing to be either
  assert.equal(inc('pod:redis'), false)
})

test('every error has something to underline', () => {
  // The field draws no squiggle without a span, so an error that arrives
  // without one would fail silently in the one place it matters.
  for (const q of ['pod:', 'pod:(a', 'pod:()', 'cpu:x', ':a', 'a)', '(a)', 'a AND', 'a OR', 'AND a', 'pod: )']) {
    const r = parsePodQuery(q)
    assert.equal(r.ok, false, `expected "${q}" to fail`)
    assert.ok(r.span && r.span[1] > r.span[0], `"${q}" has nothing to underline`)
    assert.ok(r.span[1] <= q.length, `"${q}" underlines past the end of the text`)
  }
})

test('a span cuts the segments without changing the text', () => {
  const q = 'pod:(redis'
  const segs = segmentQuery(q, POD_FIELDS, parsePodQuery(q).span)
  assert.equal(segs.map(s => s.text).join(''), q)
  assert.deepEqual(segs.filter(s => s.bad).map(s => s.text), ['('])
})

test('a span can cut inside a single segment', () => {
  // "pod:" colours as one field segment; marking only its colon has to split it
  assert.deepEqual(segmentQuery('pod:', POD_FIELDS, [3, 4]), [
    { text: 'pod', type: 'field' },
    { text: ':', type: 'field', bad: true },
  ])
})

// ---------- Tags ----------
// A column can carry tags, searched through the column that owns them:
// `service.team:alpha`. The prefix is what makes them unambiguous — two
// columns can both carry a `team`.

const svc = (name, tags) => ({ name, tags })
const SERVICES = [
  svc('payment-service', { team: 'alpha', tier: 'critical' }),
  svc('order-service', { team: 'alpha', tier: 'standard' }),
  svc('search-service', { team: 'beta' }),
  svc('legacy-service', {}),
]

const svcRun = (q) => {
  const r = parsePodQuery(q, SERVICE_FIELDS)
  assert.equal(r.ok, true, `expected "${q}" to parse, got: ${r.error}`)
  return SERVICES.filter(s => matchesPod(r.node, s, SERVICE_FIELDS)).map(s => s.name)
}
const svcFails = (q) => {
  const r = parsePodQuery(q, SERVICE_FIELDS)
  assert.equal(r.ok, false, `expected "${q}" to fail`)
  return r
}

test('a tag is searched through the column that owns it', () => {
  assert.deepEqual(svcRun('service.team:alpha'), ['payment-service', 'order-service'])
  assert.deepEqual(svcRun('service.tier:critical'), ['payment-service'])
})

test('tag terms combine like any other', () => {
  assert.deepEqual(svcRun('service.team:alpha AND service.tier:standard'), ['order-service'])
  assert.deepEqual(svcRun('service.team:(alpha OR beta)'),
    ['payment-service', 'order-service', 'search-service'])
  assert.deepEqual(svcRun('service.tier:critical OR service.team:beta'),
    ['payment-service', 'search-service'])
})

test('tag:* asks whether the tag is there at all', () => {
  assert.deepEqual(svcRun('service.tier:*'), ['payment-service', 'order-service'])
  assert.deepEqual(svcRun('service.team:*'),
    ['payment-service', 'order-service', 'search-service'])
})

test('a column term and a tag term on the same column are different questions', () => {
  // "alpha" is a team, not part of any service name
  assert.deepEqual(svcRun('service:alpha'), [])
  assert.deepEqual(svcRun('service.team:alpha'), ['payment-service', 'order-service'])
})

// The tags are on screen in that column, so a word the user can see has to be
// findable by typing it.
test('free text reads tags as well as the column value', () => {
  assert.deepEqual(svcRun('beta'), ['search-service'])
  assert.deepEqual(svcRun('payment'), ['payment-service'])
})

test('a tag reference tokenises as one thing, dots and all', () => {
  const nested = [{ name: 'a', tags: { 'k8s.app': 'web' } }]
  const r = parsePodQuery('service.k8s.app:web', SERVICE_FIELDS)
  assert.equal(r.ok, true, r.error)
  // split on the FIRST dot: the field is `service`, the tag is `k8s.app`
  assert.deepEqual(r.node, { kind: 'field', field: 'service', tag: 'k8s.app', value: 'web' })
  assert.equal(matchesPod(r.node, nested[0], SERVICE_FIELDS), true)
})

test('a column with no tags says so, rather than "unknown field"', () => {
  assert.deepEqual(svcRun('service.'), [])          // no colon: free text
  assert.match(svcFails('service.:alpha').error, /name the tag/i)
  const r = parsePodQuery('namespace.team:x', POD_FIELDS)
  assert.equal(r.ok, false)
  assert.match(r.error, /no tags/i)
})

test('an unknown field still points at the tag syntax where there is one', () => {
  assert.match(svcFails('nope:x').error, /service\.tag:value/)
})

test('tag terms highlight in the tag, not in the column value', () => {
  const { node } = parsePodQuery('service.team:alpha', SERVICE_FIELDS)
  assert.deepEqual(highlightsFor(node, SERVICE_FIELDS), { service: [] })
  assert.deepEqual(tagTerms(tagHighlightsFor(node, SERVICE_FIELDS), 'service', 'team'), ['alpha'])
  assert.deepEqual(tagTerms(tagHighlightsFor(node, SERVICE_FIELDS), 'service', 'tier'), [])
})

test('free text highlights in every tag, since any of them could have matched', () => {
  const { node } = parsePodQuery('alpha', SERVICE_FIELDS)
  assert.deepEqual(highlightsFor(node, SERVICE_FIELDS), { service: ['alpha'] })
  const hits = tagHighlightsFor(node, SERVICE_FIELDS)
  assert.deepEqual(tagTerms(hits, 'service', 'team'), ['alpha'])
  assert.deepEqual(tagTerms(hits, 'service', 'anything-at-all'), ['alpha'])
})

test('a tag reference colours as one token', () => {
  assert.deepEqual(segmentQuery('service.team:alpha', SERVICE_FIELDS), [
    { text: 'service.team:', type: 'field' },
    { text: 'alpha', type: 'plain' },
  ])
})

test('the single-column placeholder spends its example on the tag form', () => {
  assert.match(placeholderFor(SERVICE_FIELDS), /service\.tag:value/)
})
