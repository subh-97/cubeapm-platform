// The panel-head dropdown, moved out of ServiceOverview so the Browser page's
// Traces panel can use it for its "10 results" picker.
//
// The original is kept below as a fixture, copied exactly as it stood in
// ServiceOverview.jsx, and the DB tab's render is compared to it character for
// character — so the service page switches to this module without a pixel
// moving. The one difference allowed is the pair of attributes that tell a
// screen reader the button opens a list and whether it is open; they draw
// nothing. The two new props are then checked for what they add. (The menu
// only opens on a click, once the button has been measured, which a static
// render does not reach.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server.browser'
import { useState, useRef, useEffect } from 'react'
import TitleDropdown from './TitleDropdown.jsx'

const noop = () => {}
const html = el => renderToStaticMarkup(el)

/* ── Fixture: ServiceOverview.jsx's TitleDropdown, verbatim ── */

function OriginalTitleDropdown({ value, options, onChange }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const menuRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const handler = e => {
      if (!btnRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open])
  const rect = btnRef.current?.getBoundingClientRect()
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`title-dropdown${open ? ' open' : ''}`}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
      >
        <span>{value}</span>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && rect && (
        <div
          ref={menuRef}
          className="title-dropdown-menu"
          style={{ position: 'fixed', top: rect.bottom + 4, left: rect.left, minWidth: rect.width }}
        >
          {options.map(o => (
            <div
              key={o}
              className={`title-dropdown-item${o === value ? ' active' : ''}`}
              onClick={() => { onChange(o); setOpen(false) }}
            >
              {o}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// The DB tab's own options (ServiceOverview's DB_FILTER_OPTIONS), each as the
// current value, plus a value the list does not hold.
const DB_OPTIONS = ['All Database Calls', 'MySQL', 'Redis']

// The button's popup attributes, the deliberate addition to the markup.
const POPUP = ' aria-haspopup="listbox" aria-expanded="false"'
const withoutPopup = h => h.replace(POPUP, '')

test('TitleDropdown: with no new props it renders exactly what the service page drew', () => {
  for (const value of [...DB_OPTIONS, 'Something else', '']) {
    const props = { value, options: DB_OPTIONS, onChange: noop }
    const out = html(<TitleDropdown {...props} />)
    assert.ok(out.includes(POPUP), 'the button says it opens a list, and that it is closed')
    assert.equal(withoutPopup(out), html(<OriginalTitleDropdown {...props} />), value)
  }
})

test('TitleDropdown: empty className and ariaLabel change nothing either', () => {
  const props = { value: 'MySQL', options: DB_OPTIONS, onChange: noop }
  assert.equal(
    withoutPopup(html(<TitleDropdown {...props} className="" ariaLabel={undefined} />)),
    html(<OriginalTitleDropdown {...props} />),
  )
})

test('TitleDropdown: className joins the button class, ariaLabel names it, the text stays', () => {
  const out = html(
    <TitleDropdown
      value="10 results"
      options={['5 results', '10 results']}
      onChange={noop}
      className="brw-limit"
      ariaLabel="10 results: how many requests to list"
    />,
  )
  assert.match(out, /^<button type="button" class="title-dropdown brw-limit" aria-label="10 results: how many requests to list" aria-haspopup="listbox" aria-expanded="false">/)
  assert.match(out, /<span>10 results<\/span>/)
  // Closed until clicked: no menu in a first render.
  assert.doesNotMatch(out, /title-dropdown-menu/)
})
