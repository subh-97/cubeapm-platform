// The shared controls the service and Infrastructure pages were drawing for
// themselves, now drawn from one place for them and the Browser page: the
// Table | Graph switch, the column-driven table, the service picker and the
// filter dropdown.
//
// Each moved without changing what it draws. The originals are kept below as
// fixtures, copied exactly as they stood in ServiceOverview.jsx and
// InfraView.jsx, and every default render is compared to theirs character for
// character - so when those pages switch to these modules, nothing on them can
// move. The new options are then checked for what they add.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { services } from '@/data/services'
import { useSortedRows } from '@/hooks/useSortedRows'
import { useScrollReveal, revealClass } from '@/hooks/useScrollReveal'
import ViewToggle from './ViewToggle.jsx'
import { SortableTable, SortableTh, CellBar } from './SortableTable.jsx'
import FilterSelect from './FilterSelect.jsx'
import ServicePicker from '../ServicePicker.jsx'

const noop = () => {}
const html = el => renderToStaticMarkup(el)

/* ── Fixtures: the originals, verbatim ── */

// ServiceOverview.jsx, RedViewToggle.
function RedViewToggle({ view, setView }) {
  const isGraph = view === 'graph'
  return (
    <div className="view-toggle">
      <button
        type="button"
        className={`view-toggle-btn${!isGraph ? ' active' : ''}`}
        onClick={() => setView('table')}
        title="Table view"
        aria-pressed={!isGraph}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>
        <span>Table</span>
      </button>
      <button
        type="button"
        className={`view-toggle-btn${isGraph ? ' active' : ''}`}
        onClick={() => setView('graph')}
        title="Graph view"
        aria-pressed={isGraph}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
        <span>Graph</span>
      </button>
    </div>
  )
}

// InfraView.jsx, InfraTable.
function InfraTable({ columns, rows, rowKey, defaultSort = null, onRowClick, empty, sortable = true }) {
  const { rows: sorted, sort, toggle } = useSortedRows(rows, defaultSort, 'desc')
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map(c => (sortable && c.sortable !== false
              ? <SortableTh key={c.key} sortKey={c.sortKey ?? c.key} sort={sort} onToggle={toggle} align={c.align ?? 'right'}>{c.label}</SortableTh>
              : <th key={c.key} style={c.align === 'left' ? { textAlign: 'left' } : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map(c => (
                <td key={c.key} className={c.mono ? 'mono' : undefined} style={c.align === 'left' ? { textAlign: 'left' } : undefined}>
                  {c.clip
                    ? <span className="cell-clip" style={{ maxWidth: c.clip }} title={c.title?.(r)}>{c.render ? c.render(r) : r[c.key]}</span>
                    : (c.render ? c.render(r) : r[c.key])}
                </td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr className="svc-empty-row"><td colSpan={columns.length}>{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

// ServicePicker.jsx's closed field, as it rendered for the service page before
// it took a list: the static markup of its one closed state.
const originalPickerField = s => '<div class="svc-picker"><div class="svc-picker-field">'
  + `<button type="button" class="svc-picker-control" title="Switch service" aria-label="Service: ${s.name}. Switch service" aria-haspopup="listbox" aria-expanded="false">`
  + `<span class="svc-picker-label" aria-hidden="true">Service</span><span class="svc-picker-name mono">${s.name}</span>`
  + (s.language ? `<span class="svc-lang">${s.language}</span>` : '')
  + '<svg class="svc-picker-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>'
  + '</button></div></div>'

// ServiceOverview.jsx's FilterSelect, closed: its trigger.
const originalFilterTrigger = (label, value, cls = '') => `<div class="filter-select${cls ? ` ${cls}` : ''}" title="${label}: ${value}">`
  + `<span class="filter-label">${label}</span><span class="filter-value"><span>${value}</span>`
  + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>'
  + '</span></div>'

/* ── ViewToggle ── */

test('ViewToggle with no options draws the RED panel switch exactly', () => {
  for (const view of ['graph', 'table', undefined, 'list']) {
    assert.equal(
      html(<ViewToggle view={view} setView={noop} />),
      html(<RedViewToggle view={view} setView={noop} />),
      `view=${view}`,
    )
  }
})

test('ViewToggle names its group only when asked, and draws the options it is given', () => {
  const named = html(<ViewToggle view="graph" setView={noop} ariaLabel="Panel view" />)
  assert.match(named, /^<div class="view-toggle" role="group" aria-label="Panel view">/)
  assert.equal(named.replace(' role="group" aria-label="Panel view"', ''), html(<RedViewToggle view="graph" setView={noop} />))

  const opts = [{ id: 'graph', label: 'Graph' }, { id: 'list', label: 'List', title: 'One row per call' }]
  const custom = html(<ViewToggle view="list" setView={noop} options={opts} />)
  assert.equal(custom,
    '<div class="view-toggle">'
    + '<button type="button" class="view-toggle-btn" title="Graph view" aria-pressed="false"><span>Graph</span></button>'
    + '<button type="button" class="view-toggle-btn active" title="One row per call" aria-pressed="true"><span>List</span></button>'
    + '</div>')
  // With options, a view that is none of them chooses none of them, rather
  // than falling back to the first the way the default pair falls to Table.
  assert.doesNotMatch(html(<ViewToggle view="table" setView={noop} options={opts} />), /active/)
})

/* ── SortableTable ── */

const HOSTS = [
  { host: 'ip-10-0-1-12', service: 'payment-service', cpu: 91.2, mem: 62.5, disk: 40.1, netIn: 1.2, netOut: 0.8, netInRate: 1.2e6, netOutRate: 0.8e6, unit: 'M' },
  { host: 'ip-10-0-1-40', service: null, cpu: 12.75, mem: 30, disk: 71.4, netIn: 310, netOut: 120.5, netInRate: 310e3, netOutRate: 120.5e3, unit: 'K' },
  { host: 'ip-10-0-2-7', service: 'order-service', cpu: 48.333, mem: 88.1, disk: 12, netIn: 2.5, netOut: 3.1, netInRate: 2.5e6, netOutRate: 3.1e6, unit: 'M' },
]
// InfraView's host columns: left-aligned mono names, a rendered cell with a
// title, CellBars, and columns ordered by a field other than the one shown.
const HOST_COLUMNS = [
  { key: 'host', label: 'Host', align: 'left', mono: true },
  { key: 'service', label: 'Service', align: 'left', mono: true, render: h => <span title={h.service ? undefined : 'No APM service reports from this host'}>{h.service ?? '—'}</span> },
  { key: 'cpu', label: 'CPU %', render: h => <CellBar fill={h.cpu}>{h.cpu.toFixed(2)}</CellBar> },
  { key: 'mem', label: 'Mem %', render: h => <CellBar fill={h.mem}>{h.mem.toFixed(2)}</CellBar> },
  { key: 'disk', label: 'Disk %', render: h => <CellBar fill={h.disk}>{h.disk.toFixed(1)}</CellBar> },
  { key: 'netIn', label: 'Net In', sortKey: 'netInRate', render: h => `${h.netIn.toFixed(2)}${h.unit}` },
  { key: 'netOut', label: 'Net Out', sortKey: 'netOutRate', render: h => `${h.netOut.toFixed(2)}${h.unit}` },
]
// A one-record table (sortable={false}) with a clipped, titled name column and
// a column that has nothing to order by.
const DETAIL_COLUMNS = [
  { key: 'host', label: 'Host', align: 'left', mono: true, clip: 160, title: h => h.host },
  { key: 'cpu', label: 'CPU %', render: h => <CellBar fill={h.cpu}>{h.cpu.toFixed(2)}</CellBar> },
  { key: 'actions', label: '', sortable: false, render: () => '…' },
]

test('SortableTable draws every Infra table exactly as InfraTable did', () => {
  const cases = [
    { columns: HOST_COLUMNS, rows: HOSTS, rowKey: h => h.host, defaultSort: 'cpu', onRowClick: noop, empty: 'No hosts' },
    { columns: HOST_COLUMNS, rows: HOSTS, rowKey: h => h.host },
    { columns: HOST_COLUMNS, rows: HOSTS, rowKey: h => h.host, defaultSort: 'netInRate' },
    { columns: HOST_COLUMNS, rows: [], rowKey: h => h.host, defaultSort: 'cpu', empty: 'No hosts match your search.' },
    { columns: DETAIL_COLUMNS, rows: HOSTS.slice(0, 1), rowKey: h => h.host, sortable: false },
    { columns: DETAIL_COLUMNS, rows: HOSTS, rowKey: h => h.host, defaultSort: 'host' },
  ]
  for (const [i, props] of cases.entries()) {
    assert.equal(html(<SortableTable {...props} />), html(<InfraTable {...props} />), `case ${i}`)
  }
})

// What an InfoTip draws until it is opened. The real one measures itself in a
// layout effect, which a server render can only warn about.
const InfoStandIn = ({ label }) => <button type="button" className="infotip-btn" aria-label={label}>i</button>

test('SortableTable column width, ⓘ, scroller class and default direction', () => {
  const columns = [
    { key: 'endpoint', label: 'Route', align: 'left', mono: true, width: 360 },
    { key: 'rpm', label: 'RPM', info: <InfoStandIn label="About RPM" /> },
    { key: 'avg', label: 'Response Time (avg)', render: r => `${r.avg} ms` },
  ]
  const rows = [
    { endpoint: '/checkout', rpm: 4.5, avg: 1810 },
    { endpoint: '/', rpm: 52.1, avg: 640 },
    { endpoint: '/cart', rpm: 12.3, avg: 920 },
  ]
  const out = html(<SortableTable columns={columns} rows={rows} rowKey={r => r.endpoint} defaultSort="avg" defaultDir="asc" className="brw-table" />)

  assert.match(out, /^<div class="table-scroll brw-table"><table>/)
  // The width lands on the header as a style, beside the sort header's own.
  assert.match(out, /<th class="sortable-th" style="text-align:left;cursor:pointer;user-select:none;width:360px" aria-sort="none">/)
  // The label is the header's sort button; the ⓘ sits after it — outside the
  // button, inside the span that keeps a click on it from sorting — and ahead
  // of the sort arrow.
  const rpmTh = /<th class="sortable-th"[^>]*><span class="sortable-th-inner"><span><button type="button" class="sortable-th-btn">RPM<\/button>(<span class="sortable-th-info"[^>]*>.*?<\/span>)<\/span><svg class="sortable-th-arrow/.exec(out)
  assert.ok(rpmTh, 'RPM header carries its ⓘ')
  assert.match(rpmTh[1], /^<span class="sortable-th-info" style="[^"]*text-transform:none[^"]*">/)
  assert.match(rpmTh[1], /<button type="button" class="infotip-btn" aria-label="About RPM"/)
  // Ascending by the default column, so the fastest route leads.
  const order = [...out.matchAll(/<td class="mono" style="text-align:left">([^<]*)<\/td>/g)].map(m => m[1])
  assert.deepEqual(order, ['/', '/cart', '/checkout'])
  assert.match(out, /<th class="sortable-th" style="text-align:right;cursor:pointer;user-select:none" aria-sort="ascending">/)

  // The same column, unsortable: a plain header with both styles and the ⓘ.
  const flat = html(<SortableTable columns={columns} rows={rows} rowKey={r => r.endpoint} sortable={false} />)
  assert.match(flat, /^<div class="table-scroll"><table>/)
  assert.match(flat, /<th style="text-align:left;width:360px">Route<\/th>/)
  assert.match(flat, /<th>RPM<span class="sortable-th-info"[^>]*><button type="button" class="infotip-btn"/)
  // An unsortable header has nothing to press, so its label stays text.
  assert.doesNotMatch(flat, /sortable-th-btn/)
  // No default sort: the rows keep the order they were handed in.
  assert.deepEqual([...flat.matchAll(/<td class="mono" style="text-align:left">([^<]*)<\/td>/g)].map(m => m[1]), ['/checkout', '/', '/cart'])
})

test('a sortable header\'s label is a button the keyboard can press; the cell keeps aria-sort', () => {
  const out = html(
    <table><thead><tr>
      <SortableTh sortKey="rpm" sort={{ key: 'rpm', dir: 'desc' }} onToggle={noop}>RPM</SortableTh>
      <SortableTh sortKey="avg" sort={{ key: 'rpm', dir: 'desc' }} onToggle={noop} align="left">Avg</SortableTh>
    </tr></thead></table>,
  )
  assert.match(out, /<th class="sortable-th"[^>]*aria-sort="descending"><span class="sortable-th-inner"><span><button type="button" class="sortable-th-btn">RPM<\/button><\/span><svg class="sortable-th-arrow active"/)
  assert.match(out, /aria-sort="none"><span class="sortable-th-inner align-left"><span><button type="button" class="sortable-th-btn">Avg<\/button>/)
})

/* ── ServicePicker ── */

test('ServicePicker with no list draws the service page picker exactly', () => {
  assert.equal(html(<ServicePicker serviceId={services[0].id} onSelect={noop} />), originalPickerField(services[0]))
  assert.equal(html(<ServicePicker serviceId={services[2].id} onSelect={noop} />), originalPickerField(services[2]))
  // An id it does not know falls back to the first service, as before.
  assert.equal(html(<ServicePicker serviceId="no-such-service" onSelect={noop} />), originalPickerField(services[0]))
})

test('ServicePicker lists what it is given, in its words', () => {
  const apps = [
    { id: 'cubedemo-web', name: 'cubedemo-web', language: 'web' },
    { id: 'cubedemo-admin', name: 'cubedemo-admin', language: 'web' },
  ]
  const out = html(<ServicePicker serviceId="cubedemo-admin" onSelect={noop} items={apps} label="App" noun="app" idPrefix="brw" />)
  assert.match(out, /title="Switch app"/)
  assert.match(out, /aria-label="App: cubedemo-admin. Switch app"/)
  assert.match(out, /<span class="svc-picker-label" aria-hidden="true">App<\/span><span class="svc-picker-name mono">cubedemo-admin<\/span><span class="svc-lang">web<\/span>/)
  assert.doesNotMatch(out, /[Ss]ervice<|Switch service/)

  // The Browser page keeps the field's word, "Service", as production does;
  // the list is still its own, and an unknown id falls to its first item.
  const browser = html(<ServicePicker serviceId="gone" onSelect={noop} items={apps} />)
  assert.equal(browser, originalPickerField(apps[0]))
  // Nothing to list draws nothing.
  assert.equal(html(<ServicePicker serviceId="x" onSelect={noop} items={[]} />), '')
})

/* ── FilterSelect ── */

const A11Y = ' role="button" tabindex="0" aria-haspopup="listbox" aria-expanded="false"'

test('FilterSelect draws the original trigger, plus only what a keyboard needs', () => {
  const plain = html(<FilterSelect label="Category" value="ALL" options={['ALL', 'HTTP', 'DB']} onSelect={noop} />)
  assert.ok(plain.includes(A11Y), 'trigger is a focusable button with a listbox popup')
  assert.equal(plain.replace(A11Y, ''), originalFilterTrigger('Category', 'ALL'))

  const endpoint = html(<FilterSelect className="is-endpoint" label="Endpoint" value="GET /api/orders" options={['GET /api/orders']} onSelect={noop} />)
  assert.equal(endpoint.replace(A11Y, ''), originalFilterTrigger('Endpoint', 'GET /api/orders', 'is-endpoint'))

  // An empty value with no placeholder is still the original's empty span.
  const empty = html(<FilterSelect label="Endpoint" value="" options={['a']} onSelect={noop} />)
  assert.equal(empty.replace(A11Y, ''), originalFilterTrigger('Endpoint', ''))
})

test('FilterSelect shows its placeholder, muted, only while nothing is chosen', () => {
  for (const value of ['', null]) {
    const out = html(<FilterSelect className="is-endpoint" label="Endpoint" value={value} placeholder="All endpoints" clearLabel="All endpoints" options={['GET /a', 'GET /b']} onSelect={noop} />)
    assert.match(out, /title="Endpoint: All endpoints"/)
    assert.match(out, /<span class="filter-value"><span class="filter-placeholder" style="color:var\(--text-muted\);font-family:inherit;font-weight:400">All endpoints<\/span><svg/)
  }
  const chosen = html(<FilterSelect label="Error" value="TypeError" placeholder="All errors" options={['TypeError']} onSelect={noop} />)
  assert.match(chosen, /title="Error: TypeError"/)
  assert.match(chosen, /<span class="filter-value"><span>TypeError<\/span><svg/)
  assert.doesNotMatch(chosen, /All errors|filter-placeholder/)
})

/* ── useScrollReveal ── */

test('a strip starts in its place, and each state has its modifier', () => {
  function Strip({ resetKey }) {
    const { reveal } = useScrollReveal(resetKey)
    return <div className={`endpoint-strip is-sticky${revealClass(reveal)}`} data-reveal={reveal} />
  }
  assert.equal(html(<Strip resetKey="detail:GET /a" />), '<div class="endpoint-strip is-sticky" data-reveal="natural"></div>')
  assert.equal(html(<Strip resetKey={['detail', 'GET /a']} />), '<div class="endpoint-strip is-sticky" data-reveal="natural"></div>')
  assert.equal(revealClass('natural'), '')
  assert.equal(revealClass('hidden'), ' is-hidden')
  assert.equal(revealClass('revealed'), ' is-revealed')
})
