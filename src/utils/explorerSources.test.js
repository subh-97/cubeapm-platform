// The span explorer's dataset seam (explorerSources) and the page it drives.
//
// TracesView holds no knowledge of any one dataset: everything that differs
// between Traces and Mobile Traces is read off a source. These tests pin three
// promises. Every source satisfies the whole contract, in ways that agree with
// each other (every row falls in a band the chart draws, every default column
// is a field the picker offers). TRACES_SOURCE is the Traces page as it stands
// — its rows, bands, columns, badges and wording; what moved on Traces when
// the seam was cut is listed in docs/decisions/mobile-traces-page.md — and
// MOBILE_TRACES_SOURCE turns the same page into Mobile Traces. And the page
// really does read the source, rather than a constant a
// second dataset would silently inherit. The histogram's filter scaling
// (filterVolume) is tested on its own, because rare bands vanishing under a
// filter is the bug it exists to fix.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { createElement } from 'react'
import { BASE_TIME, REFERENCE_WINDOW, resolveWindow } from '@/data/timeWindow'
import { spanRowsForWindow } from '@/data/tracesExplorer'
import { STATUS } from '@/utils/status'
import { tryParseConditions, splitQuery } from '@/utils/rawQuery'
import { flattenLeaves } from '@/utils/queryTree'
import TracesView from '@/pages/TracesView'
import { TRACES_SOURCE, MOBILE_TRACES_SOURCE, filterVolume } from '@/utils/explorerSources'
import { MOBILE_FACET_FIELDS } from '@/data/mobileTracesExplorer'

const OFF_SEC = -new Date(BASE_TIME).getTimezoneOffset() * 60
const BASE_SEC = Math.floor(BASE_TIME.getTime() / 1000)
const nowMs = (BASE_SEC - ((BASE_SEC - OFF_SEC) % 1800)) * 1000
const WINDOWS = {
  '5m': resolveWindow({ kind: 'preset', value: '5m' }, nowMs),
  '1h': REFERENCE_WINDOW,
  '24h': resolveWindow({ kind: 'preset', value: '24h' }, nowMs),
  '7d': resolveWindow({ kind: 'preset', value: '7d' }, nowMs),
}

// Every key the page reads off a source. A config missing one would render a
// page that throws, or one that quietly falls back to nothing.
const CONTRACT_KEYS = [
  'id', 'title', 'noun', 'emptyText',
  'rowsForWindow', 'extraRowsFor', 'mergeExtraRows',
  'volumeForWindow', 'bands', 'bandOf',
  'buildFacets', 'facetFieldsFor',
  'fieldCatalog', 'getValue', 'allFields', 'defaultActiveFields', 'columnsFor',
  'formatDuration', 'statusForStatusCode', 'statusForRow', 'badgeFor',
  'exampleQueries', 'queryHistory', 'initialRecents',
  'placeholder', 'freeTextNoun', 'freeTextMeta',
  'csvColumns', 'csvPrefix', 'alertEmptyLabel', 'alertNamePlaceholder', 'docsUrl', 'exploreDatasource',
]

const noop = () => {}
const render = (props = {}) => renderToStaticMarkup(createElement(TracesView, {
  timeRange: { kind: 'preset', value: '1h' },
  setTimeRange: noop,
  goHome: noop,
  ...props,
}))

const rows1h = spanRowsForWindow(REFERENCE_WINDOW)

/* ---- every source ---- */

const SOURCES = { traces: TRACES_SOURCE, mtraces: MOBILE_TRACES_SOURCE }
const FUNCTION_KEYS = [
  'rowsForWindow', 'volumeForWindow', 'bandOf', 'buildFacets', 'facetFieldsFor', 'getValue', 'columnsFor',
  'formatDuration', 'statusForStatusCode', 'statusForRow', 'badgeFor',
]
const STATUSES = new Set(Object.values(STATUS))

for (const [name, source] of Object.entries(SOURCES)) {
  const rowsByWindow = Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, source.rowsForWindow(w)]))
  const bandKeys = source.bands.map(b => b.key)

  test(`${name}: carries every key the explorer reads, each of the right kind`, () => {
    for (const key of CONTRACT_KEYS) assert.ok(key in source, `${name} has no ${key}`)
    assert.equal(source.id, name, 'the id is the key App mounts the page under')
    for (const key of FUNCTION_KEYS) assert.equal(typeof source[key], 'function', key)
    // Extra rows are optional, but a source that has them must say how they merge.
    if (source.extraRowsFor !== null) {
      assert.equal(typeof source.extraRowsFor, 'function')
      assert.equal(typeof source.mergeExtraRows, 'function')
    }
    assert.ok(source.noun.one && source.noun.many && source.emptyText && source.title)
    assert.ok(source.defaultActiveFields instanceof Set)
  })

  test(`${name}: every band names a status, never a colour, under a unique key`, () => {
    assert.equal(new Set(bandKeys).size, bandKeys.length)
    for (const b of source.bands) {
      assert.ok(STATUSES.has(b.status), `${b.key} has unknown status ${b.status}`)
      assert.ok(!('color' in b), `${b.key} carries its own colour`)
      assert.ok(b.label && b.opacity > 0 && b.opacity <= 1, b.key)
    }
  })

  for (const [range, win] of Object.entries(WINDOWS)) {
    test(`${name}: every volume entry carries every band, summing to its total (${range})`, () => {
      const volume = source.volumeForWindow(win)
      assert.equal(volume.length, win.buckets.length)
      volume.forEach((d, i) => {
        assert.equal(d.t, win.buckets[i].t, `bucket ${i} is not the window's`)
        for (const k of bandKeys) assert.ok(Number.isInteger(d[k]) && d[k] >= 0, `${k} is ${d[k]}`)
        assert.equal(bandKeys.reduce((n, k) => n + d[k], 0), d.total)
      })
    })

    test(`${name}: every row falls in a band the chart draws, with a known severity (${range})`, () => {
      const keys = new Set(bandKeys)
      for (const r of rowsByWindow[range]) {
        assert.ok(keys.has(source.bandOf(r)), `${r.id} fell in ${source.bandOf(r)}`)
        assert.ok(STATUSES.has(source.statusForRow(r)), `${r.id}: ${source.statusForRow(r)}`)
        const badge = source.badgeFor(r)
        assert.ok(STATUSES.has(badge.status) && badge.label, `${r.id} badge ${JSON.stringify(badge)}`)
      }
    })
  }

  test(`${name}: the default columns are fields the picker offers, in the picker's order`, () => {
    const all = source.allFields.map(f => f.key)
    const defaults = [...source.defaultActiveFields]
    for (const k of defaults) assert.ok(all.includes(k), `${k} is a default column the picker does not offer`)
    assert.deepEqual(all.slice(0, defaults.length), defaults, 'the picker leads with the defaults')
    assert.deepEqual(source.columnsFor(source.defaultActiveFields).map(c => c.key), defaults)
    const [first, ...rest] = source.csvColumns
    assert.equal(first, 'time')
    for (const c of rest) assert.ok(all.includes(c), `CSV column ${c}`)
  })

  test(`${name}: the examples, recents and history are written in its own vocabulary`, () => {
    const known = new Set(source.fieldCatalog.map(f => f.field))
    for (const q of source.exampleQueries) {
      for (const leaf of flattenLeaves(q.chips)) assert.ok(known.has(leaf.field), `${q.name}: ${leaf.field}`)
    }
    for (const chips of source.initialRecents) {
      for (const leaf of flattenLeaves(chips)) assert.ok(known.has(leaf.field), leaf.field)
    }
    for (const h of source.queryHistory) {
      assert.ok(tryParseConditions(splitQuery(h.query).conditions).ok, `history ${h.id} does not parse`)
    }
  })

  test(`${name}: the rail lists only facets that have values to click`, () => {
    const facets = source.buildFacets(rowsByWindow['1h'])
    const fields = source.facetFieldsFor(facets)
    assert.ok(fields.length > 0)
    for (const f of fields) assert.ok(facets[f]?.length > 0, `${f} is listed with no values`)
  })
}

/* ---- the Traces source ---- */

test('TRACES_SOURCE keeps the Traces page\'s names', () => {
  assert.equal(TRACES_SOURCE.id, 'traces')
  assert.equal(TRACES_SOURCE.title, 'Traces')
  assert.deepEqual(TRACES_SOURCE.noun, { one: 'span', many: 'spans' })
  assert.equal(TRACES_SOURCE.exploreDatasource, 'traces')
  assert.equal(TRACES_SOURCE.csvPrefix, 'traces')
})

test('the Traces bands keep their keys, labels, opacities and severities', () => {
  assert.deepEqual(
    TRACES_SOURCE.bands.map(({ key, label, status, opacity }) => ({ key, label, status, opacity })),
    [
      { key: 'unset', label: 'UNSET', status: STATUS.healthy, opacity: 0.6 },
      { key: 'event', label: 'span_event', status: STATUS.neutral, opacity: 0.65 },
      { key: 'error', label: 'ERROR', status: STATUS.critical, opacity: 0.85 },
    ],
  )
})

test('every span falls in a band, and its band agrees with its status', () => {
  const keys = new Set(TRACES_SOURCE.bands.map(b => b.key))
  for (const r of rows1h) {
    const band = TRACES_SOURCE.bandOf(r)
    assert.ok(keys.has(band), `${r.id} fell in ${band}`)
    if (r.tags['event.domain'] === 'span_event') assert.equal(band, 'event')
    else assert.equal(band, r.statusCode === 'ERROR' ? 'error' : 'unset')
  }
})

test('a span row reads its severity and badge off its status', () => {
  const failing = rows1h.find(r => r.statusCode === 'ERROR')
  const ok = rows1h.find(r => r.statusCode === 'UNSET')
  const event = rows1h.find(r => r.tags['event.domain'] === 'span_event')
  assert.ok(failing && ok && event, 'the reference hour lacks a span shape')

  assert.equal(TRACES_SOURCE.statusForRow(failing), STATUS.critical)
  assert.equal(TRACES_SOURCE.statusForRow(ok), STATUS.healthy)
  assert.equal(TRACES_SOURCE.statusForRow(event), STATUS.neutral)
  assert.deepEqual(TRACES_SOURCE.badgeFor(failing), { status: STATUS.critical, label: 'ERROR' })
  assert.deepEqual(TRACES_SOURCE.badgeFor(ok), { status: STATUS.healthy, label: 'UNSET' })
  assert.deepEqual(TRACES_SOURCE.badgeFor(event), { status: STATUS.neutral, label: 'Span event' })
  assert.equal(TRACES_SOURCE.statusForStatusCode('ERROR'), STATUS.critical)
})

test('the trace id column links to its trace, and no other default column is a link', () => {
  const cols = TRACES_SOURCE.columnsFor(TRACES_SOURCE.defaultActiveFields)
  assert.deepEqual(cols.map(c => c.key),
    ['service', 'span_name', 'span_kind', 'duration', 'status_code', 'trace_id', 'span_id'])
  for (const c of cols) assert.equal(c.link, c.key === 'trace_id' ? 'trace' : undefined, c.key)
})

// Free text becomes a `_msg` chip, and a span answers `_msg` with its name — so
// the bar must say it searches span names, not the builder's log default.
test('the free-text rows say what a span search actually reads', () => {
  assert.equal(TRACES_SOURCE.freeTextNoun, 'spans')
  assert.equal(TRACES_SOURCE.freeTextMeta, 'Span name')
  const r = rows1h.find(x => x.spanName)
  assert.equal(TRACES_SOURCE.getValue(r, '_msg'), r.spanName)
})

/* ---- filterVolume ---- */

for (const source of [TRACES_SOURCE, MOBILE_TRACES_SOURCE]) {
  for (const [range, win] of Object.entries(WINDOWS)) {
    const volume = source.volumeForWindow(win)
    const rows = source.rowsForWindow(win)
    const scale = (filteredRows) => filterVolume({
      volume, bands: source.bands, bandOf: source.bandOf, win, allRows: rows, filteredRows,
    })

    // Before, a band with no sample in a bucket dropped to 0 under ANY filter —
    // so even a filter that kept everything erased the rare bands. Mobile's
    // five minutes usually hold no 4xx sample at all, which is the case that
    // has to fall back past the band's own window share.
    test(`a filter that keeps every row draws the baseline unchanged (${source.id}, ${range})`, () => {
      assert.deepEqual(scale(rows), volume)
    })

    test(`a filter that keeps no row draws nothing (${source.id}, ${range})`, () => {
      for (const d of scale([])) {
        assert.equal(d.total, 0)
        for (const b of source.bands) assert.equal(d[b.key], 0)
      }
    })

    test(`the scaled histogram never draws more than the baseline (${source.id}, ${range})`, () => {
      const kept = rows.filter((_, i) => i % 2 === 0)
      const before = JSON.stringify(volume)
      const out = scale(kept)
      assert.equal(JSON.stringify(volume), before, 'the baseline was modified')
      out.forEach((d, i) => {
        for (const b of source.bands) assert.ok(d[b.key] <= volume[i][b.key], `${b.key} grew in bucket ${i}`)
        assert.equal(source.bands.reduce((n, b) => n + d[b.key], 0), d.total)
      })
    })
  }
}

test('a band with no sample anywhere in the window follows the share of rows kept', () => {
  const win = REFERENCE_WINDOW
  const bands = [{ key: 'a', status: STATUS.healthy }, { key: 'b', status: STATUS.warning }]
  const volume = win.buckets.map(b => ({ m: b.m, t: b.t, label: b.label, a: 10, b: 8, total: 18 }))
  const rows = [0, 1, 2, 3].map(i => ({ time: new Date(win.buckets[i].t * 1000 + 1000), band: 'a' }))
  const out = filterVolume({ volume, bands, bandOf: r => r.band, win, allRows: rows, filteredRows: rows.slice(0, 1) })
  // `b` has no sample at all; one row of four was kept, so it draws a quarter.
  assert.equal(out[10].b, 2)
})

test('a band with no sample in a bucket is scaled by its share of the whole window', () => {
  const win = REFERENCE_WINDOW
  const bands = [{ key: 'a', status: STATUS.healthy }, { key: 'b', status: STATUS.critical }]
  const volume = win.buckets.map(b => ({ m: b.m, t: b.t, label: b.label, a: 10, b: 4, total: 14 }))
  const at = (i, band, kept) => ({ time: new Date(win.buckets[i].t * 1000 + 1000), band, kept })
  // Bucket 0 holds two `a` samples and no `b`; bucket 2 holds four `b` samples.
  // The filter keeps one `a` of two and one `b` of four.
  const rows = [
    at(0, 'a', true), at(0, 'a', false),
    at(2, 'b', true), at(2, 'b', false), at(2, 'b', false), at(2, 'b', false),
    // A band the source does not list is not counted, and does not break the tally.
    at(0, 'zzz', true),
  ]
  const out = filterVolume({
    volume, bands, bandOf: r => r.band, win, allRows: rows, filteredRows: rows.filter(r => r.kept),
  })
  // Bucket 0: `a` by its own samples (1 of 2), `b` by its window share (1 of 4).
  assert.equal(out[0].a, 5)
  assert.equal(out[0].b, 1)
  assert.equal(out[0].total, 6)
  // Bucket 2: `b` by its own samples, `a` (no samples there) by its window share.
  assert.equal(out[2].b, 1)
  assert.equal(out[2].a, 5)
  // A bucket with no samples at all is scaled by both window shares.
  assert.deepEqual({ a: out[1].a, b: out[1].b, total: out[1].total }, { a: 5, b: 1, total: 6 })
  // Everything else on the entry rides through.
  assert.equal(out[0].label, volume[0].label)
})

/* ---- the page reads its source ---- */

test('with no source the page is the Traces page', () => {
  const html = render()
  assert.match(html, /class="current">Traces</)
  assert.ok(html.includes(`>${rows1h.length.toLocaleString()} spans<`), 'span count missing')
  assert.ok(html.includes('Chart this query in Explore'), 'Explore entry point missing')
  // The legend is worst-first, emphasises the critical band, and draws every
  // swatch from a status token.
  assert.match(html, /background:var\(--critical\)"><\/span><span class="lvl-key">ERROR<\/span><span class="lvl-val val-critical">/)
  assert.match(html, /background:var\(--healthy\)"><\/span><span class="lvl-key">UNSET<\/span><span class="lvl-val">/)
  assert.ok(!/background:#/.test(html), 'a legend swatch carries a raw hex')
  assert.ok(!html.includes('Open trace undefined'), 'a trace link points at nothing')
})

test('a source supplies the title, noun and empty state', () => {
  const html = render({
    source: {
      ...TRACES_SOURCE,
      id: 'test',
      title: 'Test Records',
      noun: { one: 'thing', many: 'things' },
      emptyText: 'No things match this filter',
      rowsForWindow: () => [],
    },
  })
  assert.match(html, /class="current">Test Records</)
  assert.ok(html.includes('>0 things<'), 'count does not use the source noun')
  assert.ok(html.includes('No things match this filter'))
  assert.ok(!html.includes('No spans match'), 'the Traces empty text leaked through')
})

test('a source without an Explore datasource gets no Explore entry point', () => {
  const html = render({ source: { ...TRACES_SOURCE, id: 'test', exploreDatasource: null } })
  assert.ok(!html.includes('Chart this query in Explore'))
})

test('link cells render a dash for a missing value and a titled button otherwise', () => {
  const [withAll, bare] = rows1h.filter(r => r.tags.root_name && r.tags.duration > 0)
  const { trace_id: _t, root_name: _r, duration: _d, ...bareTags } = bare.tags
  const rows = [withAll, { ...bare, id: 'bare', tags: bareTags }]
  const html = render({
    source: {
      ...TRACES_SOURCE,
      id: 'test',
      rowsForWindow: () => rows,
      columnsFor: (active) => [
        ...TRACES_SOURCE.columnsFor(active),
        { key: 'root_name', label: 'root_name', width: 320, link: 'filter', linkTitle: 'Show every row like this' },
      ],
    },
  })
  // One trace link and one filter link, both on the row that has the values.
  assert.equal((html.match(/class="span-trace-link"/g) || []).length, 2)
  assert.ok(html.includes(`title="Open trace ${withAll.tags.trace_id}"`))
  assert.ok(html.includes(`title="${withAll.tags.root_name}\nShow every row like this"`), 'filter link title')
  assert.ok(!html.includes('Open trace undefined'))
  // The bare row's trace id, root name and duration all read as blanks.
  assert.ok(html.includes('class="span-cell span-dur mono" style="width:104px"><span class="span-empty">—</span>'), 'duration dash')
  assert.ok(html.includes('class="span-cell mono" style="width:246px"><span class="span-empty">—</span>'), 'trace id dash')
  assert.ok(html.includes('class="span-cell" style="width:320px"><span class="span-empty">—</span>'), 'filter link dash')
})

test('the row bar, status colour and legend emphasis come from the source', () => {
  const html = render({
    source: {
      ...TRACES_SOURCE,
      id: 'test',
      rowsForWindow: () => rows1h.filter(r => r.statusCode).slice(0, 3),
      statusForRow: () => STATUS.warning,
      statusForStatusCode: () => STATUS.warning,
      bands: [{ key: 'unset', label: 'fine', status: STATUS.healthy, opacity: 0.6, desc: 'Nothing wrong' },
        { key: 'error', label: 'bad', status: STATUS.warning, opacity: 0.85 }],
    },
  })
  assert.equal((html.match(/log-lvl-bar span-bar-warning/g) || []).length, 3)
  assert.ok(html.includes('span-status status-warning'))
  assert.match(html, /background:var\(--warning\)"><\/span><span class="lvl-key">bad<\/span><span class="lvl-val val-warning">/)
  assert.ok(html.includes('class="lvl-row" title="Nothing wrong"'), 'band desc is not the legend title')
})

/* ---- the Mobile Traces source ---- */

const mobileRows1h = MOBILE_TRACES_SOURCE.rowsForWindow(REFERENCE_WINDOW)

test('MOBILE_TRACES_SOURCE speaks of events, and leaves out what has nowhere to go', () => {
  const s = MOBILE_TRACES_SOURCE
  assert.equal(s.title, 'Mobile Traces')
  assert.deepEqual(s.noun, { one: 'event', many: 'events' })
  assert.equal(s.emptyText, 'No events match this filter')
  assert.equal(s.csvPrefix, 'mobile-traces')
  assert.ok(s.csvColumns.includes('crash_location'))
  assert.equal(s.alertEmptyLabel, 'All mobile events')
  assert.equal(s.alertNamePlaceholder, 'e.g. Crashes on Cubedemo Shop 4.2.8')
  assert.equal(s.freeTextNoun, 'events')
  // Explore has no mobile datasource, there is no mobile querying guide, and
  // no other page hands this one extra rows.
  assert.equal(s.exploreDatasource, null)
  assert.equal(s.docsUrl, null)
  assert.equal(s.extraRowsFor, null)
})

test('the mobile rail is pinned to prod\'s stream labels, in prod\'s order', () => {
  const facets = MOBILE_TRACES_SOURCE.buildFacets(mobileRows1h)
  assert.deepEqual(MOBILE_TRACES_SOURCE.facetFieldsFor(facets), MOBILE_FACET_FIELDS)
  assert.deepEqual(MOBILE_FACET_FIELDS, ['category', 'cube.eventType', 'event.domain', 'eventType', 'service'])
  // `service` has one value on every row — the span admission test would drop it.
  assert.deepEqual(facets.service, [{ value: 'Cubedemo Shop', count: mobileRows1h.length }])
})

test('the mobile bands stack by severity, and a row\'s band is its severity', () => {
  assert.deepEqual(
    MOBILE_TRACES_SOURCE.bands.map(({ key, status }) => ({ key, status })),
    [
      { key: 'ok', status: STATUS.healthy },
      { key: 'none', status: STATUS.neutral },
      { key: 'warn', status: STATUS.warning },
      { key: 'fail', status: STATUS.critical },
    ],
  )
  const bandOfStatus = Object.fromEntries(MOBILE_TRACES_SOURCE.bands.map(b => [b.status, b.key]))
  for (const r of mobileRows1h) {
    assert.equal(MOBILE_TRACES_SOURCE.bandOf(r), bandOfStatus[MOBILE_TRACES_SOURCE.statusForRow(r)], r.id)
  }
  // The status_code cell reads the HTTP answer, not OTel's ERROR/UNSET.
  assert.equal(MOBILE_TRACES_SOURCE.statusForStatusCode('0'), STATUS.critical)
  assert.equal(MOBILE_TRACES_SOURCE.statusForStatusCode('503'), STATUS.critical)
  assert.equal(MOBILE_TRACES_SOURCE.statusForStatusCode('429'), STATUS.warning)
  assert.equal(MOBILE_TRACES_SOURCE.statusForStatusCode('200'), STATUS.healthy)
  assert.equal(MOBILE_TRACES_SOURCE.statusForStatusCode('UNSET'), STATUS.healthy)
})

test('the mobile columns add crash_location, a link that narrows the results to it', () => {
  const cols = MOBILE_TRACES_SOURCE.columnsFor(MOBILE_TRACES_SOURCE.defaultActiveFields)
  assert.deepEqual(cols.map(c => c.key),
    ['service', 'span_name', 'span_kind', 'duration', 'status_code', 'trace_id', 'span_id', 'crash_location'])
  const byKey = Object.fromEntries(cols.map(c => [c.key, c]))
  assert.equal(byKey.trace_id.link, 'trace')
  assert.equal(byKey.crash_location.link, 'filter')
  assert.equal(byKey.crash_location.linkTitle, 'Show every crash at this location')
})

test('under a filter for crashes, only the failing band is drawn', () => {
  const win = REFERENCE_WINDOW
  const crashes = mobileRows1h.filter(r => r.tags.eventType === 'MobileCrash')
  assert.ok(crashes.length > 0)
  const out = filterVolume({
    volume: MOBILE_TRACES_SOURCE.volumeForWindow(win),
    bands: MOBILE_TRACES_SOURCE.bands, bandOf: MOBILE_TRACES_SOURCE.bandOf,
    win, allRows: mobileRows1h, filteredRows: crashes,
  })
  const sum = k => out.reduce((n, d) => n + d[k], 0)
  assert.ok(sum('fail') > 0, 'the crashes vanished from the chart')
  assert.equal(sum('ok') + sum('none') + sum('warn'), 0)
})

test('the Mobile Traces page', () => {
  const html = render({ source: MOBILE_TRACES_SOURCE })
  assert.match(html, /class="current">Mobile Traces</)
  assert.ok(html.includes(`>${mobileRows1h.length.toLocaleString()} events<`), 'event count missing')
  assert.ok(!html.includes('Chart this query in Explore'), 'Explore has no mobile datasource')
  // The rail is the pinned list, in order.
  const rail = [...html.matchAll(/class="facet-title">([^<]+)</g)].map(m => m[1])
  assert.deepEqual(rail, MOBILE_FACET_FIELDS)
  // Four bands, worst first, each in its status token.
  assert.match(html, /background:var\(--critical\)"><\/span><span class="lvl-key">5xx · 0 · crash<\/span><span class="lvl-val val-critical">/)
  assert.match(html, /background:var\(--warning\)"><\/span><span class="lvl-key">4xx<\/span><span class="lvl-val val-warning">/)
  assert.match(html, /background:var\(--neutral\)"><\/span><span class="lvl-key">no status</)
  assert.match(html, /background:var\(--healthy\)"><\/span><span class="lvl-key">2xx · UNSET</)
  assert.ok(!/background:#/.test(html), 'a legend swatch carries a raw hex')
  // A link per value that leads somewhere, and a dash wherever there is none.
  const traced = mobileRows1h.filter(r => r.traceId).length
  const crashed = mobileRows1h.filter(r => r.tags.crash_location).length
  assert.equal((html.match(/class="span-trace-link"/g) || []).length, traced + crashed)
  assert.ok(html.includes('Show every crash at this location'))
  assert.ok(!html.includes('Open trace undefined'))
  assert.ok(!html.includes('0 ns<'), 'a record with no duration read as 0 ns')
  // Every severity reaches the row gutter.
  for (const s of ['critical', 'warning', 'healthy', 'neutral']) {
    assert.ok(html.includes(`log-lvl-bar span-bar-${s}`), `no ${s} row`)
  }
})
