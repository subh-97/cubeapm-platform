// Explore CSV: the reference file format (results-area.md §5).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCsv, csvCell, csvFilename, downloadCsv } from './csv.js'

test('the worked example: sorted label columns, then value_<formula>, all quoted', () => {
  const csv = buildCsv([
    { metric: { service: 'shipment-service', span_kind: 'server' }, value: 12.483333333333333 },
    { metric: { span_kind: 'client', service: 'shipment-service' }, value: 3.1 },
  ], 'avg')
  assert.equal(csv, [
    '"service","span_kind","value_avg"',
    '"shipment-service","server","12.483333333333333"',
    '"shipment-service","client","3.1"',
  ].join('\n'))
})

test('columns are the sorted union of every row\'s keys; a missing label is empty', () => {
  const csv = buildCsv([
    { metric: { __name__: 'count(*)', service: 'order' }, value: 7 },
    { metric: { __name__: 'count(*)', 'log.level': 'error' }, value: 2 },
  ], 'sum')
  const [header, a, b] = csv.split('\n')
  assert.equal(header, '"__name__","log.level","service","value_sum"')
  assert.equal(a, '"count(*)","","order","7"')
  assert.equal(b, '"count(*)","error","","2"')
})

test('values go out raw: full precision, NaN as "NaN", never formatted', () => {
  const csv = buildCsv([
    { metric: { a: '1' }, value: 1234.5678 },
    { metric: { a: '2' }, value: NaN },
    { metric: { a: '3' } },
  ], 'last')
  assert.deepEqual(csv.split('\n').slice(1), ['"1","1234.5678"', '"2","NaN"', '"3",""'])
  assert.match(csv.split('\n')[0], /"value_last"$/)
})

test('a reduced range result exports its reduceValue', () => {
  const csv = buildCsv([{ metric: { s: 'x' }, values: [], reduceValue: 4 }], 'avg')
  assert.equal(csv.split('\n')[1], '"x","4"')
})

test('rows keep the order given (the API\'s value-descending order)', () => {
  const csv = buildCsv([{ metric: { s: 'b' }, value: 9 }, { metric: { s: 'a' }, value: 1 }], 'avg')
  assert.deepEqual(csv.split('\n').slice(1), ['"b","9"', '"a","1"'])
})

test('cells double inner quotes; null and undefined are empty', () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell(null), '""')
  assert.equal(csvCell(undefined), '""')
  assert.equal(csvCell(0), '"0"')
  const csv = buildCsv([{ metric: { msg: 'a,"b"' }, value: 1 }], 'avg')
  assert.equal(csv.split('\n')[1], '"a,""b""","1"')
})

test('nothing to export is an empty string, and downloading it is a no-op', () => {
  assert.equal(buildCsv([], 'avg'), '')
  assert.equal(buildCsv(null, 'avg'), '')
  assert.equal(downloadCsv(''), false)
})

test('filename: cubeapm_explore_yyyyMMdd_HHmmss.csv in local time, name sanitised', () => {
  const d = new Date(2026, 9, 1, 14, 30, 5)
  assert.equal(csvFilename('explore', d), 'cubeapm_explore_20261001_143005.csv')
  assert.equal(csvFilename('my query/1', d), 'cubeapm_my_query_1_20261001_143005.csv')
})
