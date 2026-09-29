// Field aliasing and record shape detection. The cases here are the ones the
// drawer actually meets: three agents spelling a trace id three ways, records
// with no message, and values that look linkable but have nowhere to go.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALIASES, conceptOf, resolveField, valueOfConcept, isNoiseField,
  recordType, highlightFields, recordTitle, isStreamField, linkFor, fieldGroupsFor, durationGloss,
} from './logFields.js'
import { logRows } from '@/data/observability'

const rec = (tags, extra = {}) => ({ message: '', tags, ...extra })

// ---------- Aliasing ----------

test('one concept resolves across three vendors spellings', () => {
  assert.equal(valueOfConcept(rec({ trace_id: 'a' }), 'traceId'), 'a')
  assert.equal(valueOfConcept(rec({ 'trace.id': 'b' }), 'traceId'), 'b')
  assert.equal(valueOfConcept(rec({ 'dd.trace_id': 'c' }), 'traceId'), 'c')
})

test('the canonical spelling wins when a record carries two', () => {
  const r = rec({ 'trace.id': 'newrelic', trace_id: 'otel' })
  assert.deepEqual(resolveField(r, 'traceId'), { field: 'trace_id', value: 'otel' })
})

test('severity resolves for OTel, Elastic, New Relic and Datadog', () => {
  assert.equal(valueOfConcept(rec({ severity: 'info' }), 'severity'), 'info')
  assert.equal(valueOfConcept(rec({ 'log.level': 'warn' }), 'severity'), 'warn')
  assert.equal(valueOfConcept(rec({ level: 'error' }), 'severity'), 'error')
  assert.equal(valueOfConcept(rec({ status: 'debug' }), 'severity'), 'debug')
})

test('empty values do not count as present', () => {
  assert.equal(resolveField(rec({ 'log.stacktrace': '' }), 'stacktrace'), null)
  assert.equal(valueOfConcept(rec({ 'log.exception.type': '', 'error.class': 'Boom' }), 'exceptionType'), 'Boom')
})

test('a field maps back to exactly one concept', () => {
  assert.equal(conceptOf('hostname'), 'host')
  assert.equal(conceptOf('error.stack'), 'stacktrace')
  assert.equal(conceptOf('not-a-real-field'), null)
})

test('no spelling is claimed by two concepts', () => {
  const seen = new Map()
  for (const [concept, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      assert.equal(seen.has(n), false, `${n} is in both ${seen.get(n)} and ${concept}`)
      seen.set(n, concept)
    }
  }
})

// ---------- Record shape ----------

test('shape is read off the fields, not a stored type', () => {
  assert.equal(recordType(rec({ 'event.domain': 'k8s', 'object.reason': 'BackOff' })), 'k8s-event')
  assert.equal(recordType(rec({ 'db.system': 'redis' })), 'db-span')
  assert.equal(recordType(rec({ 'error.stack': 'boom' })), 'exception')
  assert.equal(recordType(rec({ endpoint: '/v1/order' })), 'request')
  assert.equal(recordType(rec({ 'k8s.pod.name': 'etcd-minikube' })), 'k8s-log')
  assert.equal(recordType(rec({ foo: 'bar' })), 'record')
})

test('a database call leads with the call, not the service', () => {
  const r = rec({ 'db.system': 'mysql', 'db.operation': 'SELECT', 'db.sql.table': 'orders', duration: '1840000000' })
  assert.deepEqual(highlightFields(r).map(([k]) => k), ['db.system', 'db.operation', 'duration'])
})

test('highlights use whichever spelling the record has', () => {
  const r = rec({ 'service.name': 'checkout', 'trace.id': 'abc' })
  assert.deepEqual(highlightFields(r).map(([k]) => k), ['service.name', 'trace.id'])
})

// ---------- Titles ----------

test('a k8s event builds a title, because it has no message', () => {
  const r = rec({ 'event.domain': 'k8s', 'object.reason': 'BackOff', 'object.note': 'Back-off restarting' },
    { message: 'UNSET' })
  assert.deepEqual(recordTitle(r), { title: 'BackOff', detail: 'Back-off restarting' })
})

test('the literal UNSET is never shown as a message', () => {
  assert.equal(recordTitle(rec({ foo: 'bar' }, { message: 'UNSET' })).detail, '')
})

// ---------- Noise ----------

test('the resource block and managedFields are noise', () => {
  assert.equal(isNoiseField('_resource.process.command_line'), true)
  assert.equal(isNoiseField('object.metadata.managedFields'), true)
  assert.equal(isNoiseField('object.deprecatedSource.host'), true)
  assert.equal(isNoiseField('db.statement'), false)
  assert.equal(isNoiseField('object.reason'), false)
})

// ---------- Links ----------

const services = new Set(['order-service', 'notify-service'])

test('a trace id opens the trace', () => {
  const l = linkFor({ field: 'trace.id', value: 'abcdef1234', record: rec({}), knownServices: services })
  assert.equal(l.kind, 'open')
  assert.equal(l.view, 'traces')
})

test('a service links only when APM knows it, and filters when it does not', () => {
  const known = linkFor({ field: 'service', value: 'order-service', record: rec({}), knownServices: services })
  assert.equal(known.kind, 'open')
  const unknown = linkFor({ field: 'service', value: 'order', record: rec({}), knownServices: services })
  assert.equal(unknown.kind, 'filter')
  assert.match(unknown.hint, /No APM service named order/)
})

test('a span id filters, because no page addresses a span', () => {
  const l = linkFor({ field: 'span_id', value: 'deadbeef', record: rec({}), knownServices: services })
  assert.equal(l.kind, 'filter')
})

test('a database instance is built from the peer host and port', () => {
  const r = rec({ 'db.system': 'mysql', 'net.peer.name': 'db.example.com', 'net.peer.port': '3306' })
  const l = linkFor({ field: 'db.system', value: 'mysql', record: r, knownServices: services })
  assert.equal(l.kind, 'open')
  assert.equal(l.resource, 'db.example.com:3306')
})

test('a database with no peer has nowhere to go', () => {
  const r = rec({ 'db.system': 'mysql' })
  assert.equal(linkFor({ field: 'db.system', value: 'mysql', record: r, knownServices: services }), null)
})

test('pods and hosts resolve to infrastructure whichever agent named them', () => {
  const otel = linkFor({ field: 'k8s.pod.name', value: 'etcd-minikube', record: rec({}), knownServices: services })
  const nr = linkFor({ field: 'pod_name', value: 'etcd-minikube', record: rec({}), knownServices: services })
  assert.equal(otel.source, 'k8s-pod')
  assert.deepEqual(otel, nr)
})

test('an undecorated field returns no link at all', () => {
  assert.equal(linkFor({ field: 'db.statement', value: 'select 1', record: rec({}), knownServices: services }), null)
  assert.equal(linkFor({ field: 'trace_id', value: '', record: rec({}), knownServices: services }), null)
})

// ---------- Against the seeded stream ----------

test('the seeded stream carries every shape the drawer handles', () => {
  const shapes = new Set(logRows.map(recordType))
  for (const want of ['k8s-event', 'db-span', 'exception', 'request', 'k8s-log']) {
    assert.equal(shapes.has(want), true, `no seeded record of shape ${want}`)
  }
})

test('stream membership is per record, not per field name', () => {
  const event = logRows.find(r => recordType(r) === 'k8s-event')
  const podLog = logRows.find(r => recordType(r) === 'k8s-log')
  // Same field, opposite answers: a stream key on the container log, a plain
  // body field on the event. A static list of stream fields would get one wrong.
  assert.equal(isStreamField(podLog, 'k8s.namespace.name'), true)
  assert.equal(isStreamField(event, 'k8s.namespace.name'), false)
})

test('every seeded record resolves a severity and a timestamp', () => {
  for (const r of logRows) {
    assert.ok(valueOfConcept(r, 'severity') || r.level, `no severity on ${r.id}`)
    assert.ok(r.time instanceof Date, `no time on ${r.id}`)
  }
})

// ---------- Grouping ----------

test('a database call groups the call first and the resource block last', () => {
  const r = logRows.find(x => recordType(x) === 'db-span')
  const groups = fieldGroupsFor(r)
  assert.equal(groups[0].fields[0][0], 'db.system')
  assert.equal(groups.at(-1).noise, true)
  assert.ok(groups.at(-1).fields.every(([k]) => k.startsWith('_resource.')))
})

test('a k8s event leads with what happened, not with metadata', () => {
  const r = logRows.find(x => recordType(x) === 'k8s-event')
  const groups = fieldGroupsFor(r)
  assert.deepEqual(groups[0].fields.map(([k]) => k), ['object.type', 'object.reason', 'object.note'])
  assert.ok(groups.at(-1).fields.some(([k]) => k === 'object.metadata.managedFields'))
})

test('every field lands in exactly one group', () => {
  for (const r of logRows) {
    const seen = fieldGroupsFor(r).flatMap(g => g.fields.map(([k]) => k))
    assert.equal(new Set(seen).size, seen.length, `duplicate field in ${r.id}`)
    assert.deepEqual(new Set(seen), new Set(Object.keys(r.tags)), `dropped a field on ${r.id}`)
  }
})

test('hidden fields are dropped rather than grouped', () => {
  const r = { message: '', tags: { 'log.stacktrace': '', service: 'order' } }
  const groups = fieldGroupsFor(r, { isHidden: (k, v) => v === '' })
  assert.deepEqual(groups.flatMap(g => g.fields.map(([k]) => k)), ['service'])
})

// ---------- Units ----------

test('nanosecond durations get a readable gloss, milliseconds do not', () => {
  assert.equal(durationGloss('duration', '3000000'), '3 ms')
  assert.equal(durationGloss('duration', '1840000000'), '1.84 s')
  assert.equal(durationGloss('event.duration', '450000'), '450 µs')
  assert.equal(durationGloss('duration_ms', '1840'), null)
  assert.equal(durationGloss('db.statement', 'select 1'), null)
})

test('an endpoint links into its service, and filters when APM does not know it', () => {
  const known = rec({ service: 'order-service', endpoint: 'GET /v1/order' })
  const open = linkFor({ field: 'endpoint', value: 'GET /v1/order', record: known, knownServices: services })
  assert.equal(open.kind, 'open')
  assert.equal(open.subTab, 'detail')
  assert.equal(open.serviceId, 'order-service')

  const unknown = rec({ service: 'order', endpoint: 'GET /v1/order' })
  assert.equal(linkFor({ field: 'endpoint', value: 'GET /v1/order', record: unknown, knownServices: services }).kind, 'filter')

  const orphan = rec({ endpoint: 'GET /v1/order' })
  assert.match(linkFor({ field: 'endpoint', value: 'GET /v1/order', record: orphan, knownServices: services }).hint, /No service on this record/)
})

test('a namespace opens the namespace overview, not the deployment list', () => {
  const l = linkFor({ field: 'k8s.namespace.name', value: 'kube-system', record: rec({}), knownServices: services })
  assert.equal(l.kind, 'open')
  assert.equal(l.source, 'k8s-cluster')
  assert.equal(l.resource, 'kube-system')
  // Every k8s spelling reaches the same place.
  for (const f of ['kube_namespace', 'orchestrator.namespace']) {
    assert.equal(linkFor({ field: f, value: 'kube-system', record: rec({}), knownServices: services }).source, 'k8s-cluster')
  }
})
