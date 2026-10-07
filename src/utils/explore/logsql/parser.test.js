// The LogsQL parser, from the evaluator's side of the fence.
//
// This is not a grammar suite — it pins the handful of AST facts evaluate.js is
// written against, so a change to either one shows up here rather than as a
// silently empty chart: what a filter node is called, how a stats entry names
// itself, and that the pipes survive the filter in front of them.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseLogsql, LogsqlError } from '@/utils/explore/logsql'

const pipes = (q) => parseLogsql(q).pipes.map(p => p.name)
const names = (q) => parseLogsql(q).pipes.find(p => p.name === 'stats').entries.map(e => e.name)

test('a stats entry names itself after its alias, else after the call as written', () => {
  assert.deepEqual(names('* | stats count()'), ['count(*)'])
  assert.deepEqual(names('* | stats quantile(0.9, duration)'), ['quantile(0.9, duration)'])
  assert.deepEqual(names('* | stats count_uniq(trace_id) as "traces"'), ['traces'])
  // The source spelling of an argument is kept, quotes and all.
  assert.deepEqual(names('* | stats avg("current-db-size-bytes")'), ['avg("current-db-size-bytes")'])
  // An `if (…)` is part of the call, so two counts with different conditions
  // are two series rather than one that overwrites the other.
  assert.deepEqual(names('* | stats count() if (log.level:="error"), count()'),
    ['count(*) if (log.level:="error")', 'count(*)'])
})

test('the filter nodes the evaluator switches on', () => {
  assert.equal(parseLogsql('* | stats count()').filter.type, 'all')
  assert.equal(parseLogsql('{"service"="order"} | stats count()').filter.type, 'stream')
  assert.equal(parseLogsql('NOT log.level:="info" | stats count()').filter.type, 'not')
  assert.equal(parseLogsql('a:="1" OR b:="2" | stats count()').filter.type, 'or')
  assert.equal(parseLogsql('a:="1" b:="2" | stats count()').filter.type, 'and')
  const term = parseLogsql('duration:>100ms | stats count()').filter
  assert.deepEqual(term, { type: 'term', field: 'duration', op: 'gt', value: '100ms' })
})

test('a `_time:` filter is parsed away — the server supplies the window', () => {
  assert.equal(parseLogsql('_time:1h | stats count()').filter.type, 'time')
  assert.deepEqual(pipes('_time:[2024-01-01,2024-01-02] x | stats count()'), ['stats'])
})

test('an unclosed `_time:` range stops at the pipe instead of eating the query', () => {
  // Our own Logs page writes this, and builders.js carries it over verbatim.
  // Swallowing the `|` made api.js report a stats pipe that is right there as
  // missing.
  assert.deepEqual(pipes('_time:[a,b) error | stats count()'), ['stats'])
  assert.deepEqual(pipes('_time:[a,b) error | stats count() | math c * 2 as d'), ['stats', 'math'])
})

test('an empty query and an unknown pipe carry the server wording', () => {
  assert.throws(() => parseLogsql('   '), LogsqlError)
  assert.throws(() => parseLogsql('* | nosuchpipe'), (err) => {
    assert.ok(err instanceof LogsqlError)
    assert.match(err.message, /unexpected pipe "nosuchpipe"/)
    return true
  })
})
