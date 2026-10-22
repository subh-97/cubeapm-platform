// The facet group's head, as a disclosure a keyboard and a screen reader can
// use: the title is a button that says whether its group is open and names the
// part it folds, and the head's other controls stand beside that button rather
// than inside it, since a button can't hold another.
//
// It changed without changing what it draws. The original is kept below as a
// fixture, copied exactly as it stood in FacetGroup.jsx, and the render is
// compared to it character for character. The differences allowed draw
// nothing: the button round the title's text, the chevron hidden from screen
// readers (aria-expanded says what it shows), and the element round the search
// box and list that the button names. (A group only folds on a click, which a
// static render does not reach.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { useState, useEffect } from 'react'
import FacetGroup from './FacetGroup.jsx'

const noop = () => {}
const html = el => renderToStaticMarkup(el)
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null

const OPTIONS = [
  { value: 'error', count: 18 },
  { value: 'warn', count: 55 },
  { value: 'info', count: 1204 },
]

/* ── Fixture: FacetGroup.jsx before its head was a button, verbatim ── */

const FACET_VISIBLE_ROWS = 6

function OriginalFacetGroup({ title, options = [], selected, onToggle, renderLabel }) {
  const [open, setOpen] = useState(true)
  const [q, setQ] = useState('')
  const [onlySelected, setOnlySelected] = useState(false)

  const selectedCount = options.filter(o => selected.has(o.value)).length

  // Unchecking the last value while filtered to selections would strand the user
  // on an empty list, so drop back to showing everything.
  useEffect(() => {
    if (onlySelected && selectedCount === 0) setOnlySelected(false)
  }, [onlySelected, selectedCount])

  const searched = q ? options.filter(o => o.value.toLowerCase().includes(q.toLowerCase())) : options
  const shown = onlySelected ? searched.filter(o => selected.has(o.value)) : searched
  const scrollable = shown.length > FACET_VISIBLE_ROWS

  return (
    <div className="facet-group">
      <div className="facet-head" onClick={() => setOpen(o => !o)}>
        <div>
          <div className="facet-title">{title}</div>
          <div className="facet-meta">
            <div className="facet-meta-left">
              <span>{options.length} total ·</span>
              {selectedCount === 0 ? (
                <span>{selectedCount} selected</span>
              ) : (
                <button
                  type="button"
                  className={`facet-sel-toggle${onlySelected ? ' on' : ''}`}
                  aria-pressed={onlySelected}
                  title={onlySelected
                    ? `Showing only selected — click to show all ${options.length} values`
                    : `Show only the ${selectedCount} selected value${selectedCount === 1 ? '' : 's'}`}
                  onClick={(e) => { e.stopPropagation(); setOpen(true); setOnlySelected(v => !v) }}
                >
                  {selectedCount} selected
                  {onlySelected ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  )}
                </button>
              )}
            </div>
            {selectedCount > 0 && (
              <button
                type="button"
                className="facet-clear-btn-meta"
                title="Clear selected"
                onClick={(e) => { e.stopPropagation(); [...selected].forEach(v => onToggle(title, v)) }}
              >
                <span>Clear</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            )}
          </div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={`facet-chev${open ? ' open' : ''}`}><path d="M6 9l6 6 6-6"/></svg>
      </div>
      {open && (
        <>
          <div className="facet-search">
            <input placeholder="search…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div className={`facet-list${scrollable ? ' scrollable' : ''}`}>
            {shown.length === 0 && <div className="facet-none">No values match</div>}
            {shown.map(o => (
              <label key={o.value} className="facet-opt">
                <input type="checkbox" checked={selected.has(o.value)} onChange={() => onToggle(title, o.value)} />
                <span className="facet-opt-label" title={o.value}>{renderLabel ? renderLabel(o.value) : o.value}</span>
                <span className="facet-opt-count">{o.count.toLocaleString()}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/* ── The head ── */

test('the title is a button saying its group is open, and naming the search box and list it folds', () => {
  const out = html(<FacetGroup title="log.level" options={OPTIONS} selected={new Set()} onToggle={noop} />)
  const btn = out.match(/<button[^>]*class="facet-title-btn"[^>]*>/)?.[0]
  assert.ok(btn, 'the title is not a button')
  assert.equal(attr(btn, 'type'), 'button', 'inside a form it would submit')
  assert.equal(attr(btn, 'aria-expanded'), 'true', 'a group starts open')
  assert.match(out, /class="facet-title-btn"[^>]*>log\.level<\/button>/, 'the title is what the button is called')
  const id = attr(btn, 'aria-controls')
  assert.ok(id, 'no aria-controls')
  const body = out.slice(out.indexOf(` id="${id}"`))
  assert.ok(out.indexOf(` id="${id}"`) > out.indexOf(btn), 'aria-controls names nothing below the head')
  assert.match(body, /^ id="[^"]+"><div class="facet-search">/, 'the part it folds starts at the search box')
  assert.match(body, /<div class="facet-list">[\s\S]*class="facet-opt"/, 'and holds the options')
})

test('each group\'s button names its own list', () => {
  const out = html(
    <>
      <FacetGroup title="log.level" options={OPTIONS} selected={new Set()} onToggle={noop} />
      <FacetGroup title="service" options={OPTIONS} selected={new Set()} onToggle={noop} />
    </>
  )
  const ids = [...out.matchAll(/aria-controls="([^"]+)"/g)].map(m => m[1])
  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1])
  for (const id of ids) assert.equal(out.split(` id="${id}"`).length, 2, `${id} names one element`)
})

test('with values ticked, "N selected" and Clear are buttons beside the title, not inside it', () => {
  const out = html(<FacetGroup title="log.level" options={OPTIONS} selected={new Set(['error', 'warn'])} onToggle={noop} />)
  const head = out.slice(0, out.indexOf('<div class="facet-search">'))
  assert.deepEqual([...head.matchAll(/<button[^>]*class="([^"]+)"/g)].map(m => m[1]),
    ['facet-title-btn', 'facet-sel-toggle', 'facet-clear-btn-meta'])
  assert.doesNotMatch(out, /<button\b(?:(?!<\/button>)[\s\S])*<button\b/, 'a button opens inside another')
  assert.match(head, /<svg[^>]*class="facet-chev open"[^>]*aria-hidden="true"/, 'the chevron is read as nothing')
})

test('it draws what the original drew', () => {
  const cases = [
    { selected: [] },
    { selected: ['error'] },
    { selected: ['error', 'warn', 'info'], renderLabel: v => <b>{v}</b> },
  ]
  for (const { selected, renderLabel } of cases) {
    const props = { title: 'log.level', options: OPTIONS, onToggle: noop, renderLabel }
    const now = html(<FacetGroup {...props} selected={new Set(selected)} />)
    const was = html(<OriginalFacetGroup {...props} selected={new Set(selected)} />)
    // The new render is the old head, the folded part's element, the old body.
    const wrap = `<div id="${attr(now, 'aria-controls')}">`
    const at = now.indexOf(wrap)
    assert.ok(at > 0 && now.endsWith('</div></div>'), `no folded part (${selected.length} ticked)`)
    const head = now.slice(0, at)
      .replace(/<button type="button" class="facet-title-btn"[^>]*>([^<]*)<\/button>/, '$1')
      .replace(/(class="facet-chev[^"]*") aria-hidden="true"/, '$1')
    const body = now.slice(at + wrap.length, -'</div></div>'.length)
    assert.equal(head + body + '</div>', was, `${selected.length} ticked`)
  }
})
