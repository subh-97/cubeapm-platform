import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import clsx from 'clsx'
import './explore-controls.css'

// The Code tab's editor: a textarea for the caret and the selection, with a
// coloured copy of the same text painted behind it, and a completion menu.
//
// ── Why the text is drawn twice ────────────────────────────────────────────
// A textarea cannot colour its own contents, and a contenteditable div colours
// text at the cost of owning undo, IME, spellcheck and every paste. So the
// textarea keeps the input behaviour and goes transparent, and an aria-hidden
// <pre> underneath paints the tokens. The technique fails in exactly one way —
// the two copies drifting apart — so everything below is about keeping them on
// the same pixels:
//
//   · identical font, size, line-height, letter-spacing, padding and wrapping;
//     both are set by one CSS rule listing both selectors, never by two.
//   · the box, not the textarea, is the scroller. The textarea is sized to its
//     own scrollHeight so it never scrolls internally, and the ink layer is
//     absolutely positioned inside the same scrolling box, so one scroll moves
//     both. Nothing has to be kept in sync by hand, and a scrollbar — which
//     narrows the text and changes where lines wrap — narrows both equally.
//   · a trailing newline is doubled in the ink. A block does not render a line
//     box for its final line break, but a textarea does, so without this the
//     ink is one line short the moment someone presses Enter at the end.
//
// The widths come out of the same containing block: the box carries no padding
// of its own, so `width: 100%` on the textarea and `left/right: 0` on the <pre>
// resolve against the same box, scrollbar included.
//
// ── Keys (ARCH D4) ────────────────────────────────────────────────────────
// Enter accepts the highlighted suggestion when the menu is open, otherwise
// runs. Shift+Enter inserts a newline. Tab accepts. Esc closes. ↑/↓ move, ↓
// opens, Ctrl+Space opens. Cmd/Ctrl+Enter always runs. The footer says so.

const KIND_LABEL = {
  metric: 'Metrics',
  label: 'Labels',
  value: 'Values',
  field: 'Fields',
  aggregation: 'Aggregations',
  function: 'Functions',
  keyword: 'Keywords',
  pipe: 'Pipes',
  statsFn: 'Stats functions',
  filterFn: 'Filter functions',
}

const KIND_BADGE = {
  metric: 'M',
  label: 'L',
  value: '=',
  field: 'A',
  aggregation: 'Σ',
  function: 'ƒ',
  keyword: '&',
  pipe: '|',
  statsFn: 'Σ',
  filterFn: 'ƒ',
}

// Stable, so an empty result never re-renders the menu into a new object.
const NO_SUGGESTIONS = { from: 0, to: 0, items: [] }

/**
 * @param {object} props
 * @param {string} props.value
 * @param {(next:string) => void} props.onChange
 * @param {(text:string) => Array<{type:string, value:string}>} [props.tokenize]
 *   The language's highlighting tokenizer. It must cover the text end to end —
 *   both Explore lexers do — because the ink layer is its output glued back
 *   together.
 * @param {(text:string, caret:number) => ({from:number,to:number,items:Array}|Promise<…>)} [props.suggest]
 *   Memoise it: it is a dependency of the effect that asks for completions.
 * @param {() => void} [props.onSubmit]
 */
export default function CodeEditor({
  value = '',
  onChange,
  tokenize,
  suggest,
  onSubmit,
  placeholder,
  minRows = 1,
  maxRows = 12,
  readOnly = false,
  ariaLabel = 'Query',
  error = null,
  className,
}) {
  const [open, setOpen] = useState(false)
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [sug, setSug] = useState(NO_SUGGESTIONS)
  const wrapRef = useRef(null)
  const boxRef = useRef(null)
  const taRef = useRef(null)
  const listRef = useRef(null)
  const reqRef = useRef(0)
  const menuId = `${useId()}-menu`

  // Always an array: the only writer below rejects a result without one.
  const items = sug.items
  const hi = Math.min(highlight, Math.max(0, items.length - 1))

  const tokens = useMemo(() => {
    if (typeof tokenize !== 'function') return [{ type: 'plain', value }]
    try {
      return tokenize(value) ?? []
    } catch {
      // The lexers do not throw; a caller's might. Uncoloured text beats a
      // blank editor.
      return [{ type: 'plain', value }]
    }
  }, [tokenize, value])

  // Size the textarea to its content so it never scrolls on its own, and cap
  // the box at maxRows. Both numbers come from the element's own computed
  // metrics rather than from constants that could drift from the stylesheet.
  //
  // The cap is set BEFORE the content is measured, because the measurement
  // depends on it: the box's width decides where lines wrap, and `scrollHeight`
  // is read at that width.
  const resize = useCallback(() => {
    const ta = taRef.current
    const box = boxRef.current
    if (!ta || !box) return
    const cs = window.getComputedStyle(ta)
    const line = parseFloat(cs.lineHeight) || 18
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const bs = window.getComputedStyle(box)
    const border = (parseFloat(bs.borderTopWidth) || 0) + (parseFloat(bs.borderBottomWidth) || 0)
    box.style.maxHeight = `${Math.round(maxRows * line + pad + border)}px`
    ta.style.height = 'auto'
    ta.style.height = `${Math.max(ta.scrollHeight, Math.round(minRows * line + pad))}px`
  }, [minRows, maxRows])

  useLayoutEffect(() => { resize() }, [resize, value])

  // A height measured at one width is wrong at another, and the editor sits in
  // a card that resizes — the window, the sidebar collapsing, a tab changing
  // the toolbar's wrap. Re-measure on width changes only; height changes are
  // this effect's own doing and would loop.
  useEffect(() => {
    const box = boxRef.current
    if (!box || typeof ResizeObserver === 'undefined') return undefined
    let last = box.clientWidth
    const ro = new ResizeObserver(() => {
      if (box.clientWidth === last) return
      last = box.clientWidth
      resize()
    })
    ro.observe(box)
    return () => ro.disconnect()
  }, [resize])

  // Ask for completions whenever the menu is open and the text or the caret
  // moves. Answers may arrive out of order, so only the newest request writes.
  useEffect(() => {
    if (!open || typeof suggest !== 'function') {
      setSug(NO_SUGGESTIONS)
      return undefined
    }
    const id = ++reqRef.current
    let alive = true
    Promise.resolve()
      .then(() => suggest(value, caret))
      .then(
        (res) => {
          if (!alive || reqRef.current !== id) return
          setSug(res && Array.isArray(res.items) ? res : NO_SUGGESTIONS)
        },
        () => { if (alive && reqRef.current === id) setSug(NO_SUGGESTIONS) }
      )
    return () => { alive = false }
  }, [open, value, caret, suggest])

  // A list that changed under the cursor cannot keep its old position.
  useEffect(() => { setHighlight(0) }, [sug])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, hi])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const syncCaret = useCallback(() => {
    const ta = taRef.current
    if (ta) setCaret(ta.selectionStart ?? 0)
  }, [])

  const apply = useCallback((item) => {
    if (!item || readOnly) return
    const insert = item.insertText ?? item.label ?? ''
    const next = value.slice(0, sug.from) + insert + value.slice(sug.to)
    const pos = sug.from + insert.length
    onChange?.(next)
    // The menu stays open: one completion usually leads straight into the next
    // question (a label, then its value).
    window.requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }, [onChange, readOnly, sug.from, sug.to, value])

  const onKeyDown = (e) => {
    const has = open && items.length > 0
    if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      return
    }
    if ((e.key === ' ' || e.code === 'Space') && e.ctrlKey && !readOnly) {
      e.preventDefault()
      setOpen(true)
      return
    }
    if (e.key === 'Enter') {
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); setOpen(false); onSubmit?.(); return }
      if (e.shiftKey) return   // a newline, and the only way to get one
      if (has) { e.preventDefault(); apply(items[hi]); return }
      e.preventDefault()
      setOpen(false)
      onSubmit?.()
      return
    }
    if (e.key === 'Tab' && has) { e.preventDefault(); apply(items[hi]); return }
    if (e.key === 'ArrowDown') {
      if (!open && !readOnly) { e.preventDefault(); setOpen(true); return }
      if (items.length) { e.preventDefault(); setHighlight(h => (h + 1) % items.length) }
      return
    }
    if (e.key === 'ArrowUp' && open && items.length) {
      e.preventDefault()
      setHighlight(h => (h - 1 + items.length) % items.length)
    }
  }

  // Consecutive items of one kind become one labelled section, so the menu
  // reads as "Fields … Filter functions" rather than as one undifferentiated list.
  const groups = useMemo(() => {
    const out = []
    items.forEach((it, i) => {
      const kind = it.kind || 'value'
      const last = out[out.length - 1]
      if (last && last.kind === kind) last.items.push({ it, i })
      else out.push({ kind, items: [{ it, i }] })
    })
    return out
  }, [items])

  return (
    <div className={clsx('ex-code', className)} ref={wrapRef}>
      <div
        ref={boxRef}
        className={clsx('ex-code-box', { 'is-error': !!error, 'is-readonly': readOnly })}
        onClick={() => taRef.current?.focus()}
      >
        {/* The ink. aria-hidden because the textarea already carries the text
            for assistive technology; announcing it twice is noise. */}
        <pre className="ex-code-ink" aria-hidden="true">
          {tokens.map((t, i) => (
            <span key={i} className={`ex-tok-${t.type}`}>{t.value}</span>
          ))}
          {value.endsWith('\n') && '\n'}
        </pre>
        <textarea
          ref={taRef}
          className="ex-code-area"
          value={value}
          readOnly={readOnly}
          placeholder={placeholder}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={open && items.length > 0}
          aria-controls={open && items.length > 0 ? menuId : undefined}
          aria-activedescendant={open && items.length > 0 ? `${menuId}-${hi}` : undefined}
          aria-autocomplete="list"
          aria-invalid={error ? true : undefined}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          wrap="soft"
          onChange={(e) => {
            onChange?.(e.target.value)
            setCaret(e.target.selectionStart ?? 0)
            if (!readOnly) setOpen(true)
          }}
          onKeyUp={syncCaret}
          onClick={(e) => { e.stopPropagation(); syncCaret() }}
          onSelect={syncCaret}
          onFocus={syncCaret}
          onKeyDown={onKeyDown}
        />
      </div>

      {error && (
        <div className="ex-code-error" role="alert">
          <AlertCircle size={12} strokeWidth={2} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="ex-code-foot">
        <kbd>↑↓</kbd> move
        <kbd>Tab</kbd> accept
        <kbd>Enter</kbd> accept or run
        <kbd>⇧Enter</kbd> newline
        <kbd>⌘/Ctrl+Enter</kbd> run
        <kbd>Ctrl+Space</kbd> suggest
        <kbd>Esc</kbd> dismiss
      </div>

      {open && items.length > 0 && (
        <div className="ex-code-menu" id={menuId} role="listbox" aria-label={`${ariaLabel} suggestions`} ref={listRef}>
          {groups.map((g, gi) => (
            <div key={`${g.kind}-${gi}`} className="ex-code-group">
              <div className="ex-code-group-lbl">{KIND_LABEL[g.kind] ?? g.kind}</div>
              {g.items.map(({ it, i }) => (
                <button
                  key={`${it.label}-${i}`}
                  id={`${menuId}-${i}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === hi}
                  data-active={i === hi}
                  className={clsx('ex-code-item', { 'is-active': i === hi })}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => apply(it)}
                >
                  <span className="ex-code-item-badge" aria-hidden="true">{KIND_BADGE[it.kind] ?? '·'}</span>
                  <span className="ex-code-item-body">
                    <span className="ex-code-item-label">{it.label}</span>
                    {it.doc && <span className="ex-code-item-doc">{it.doc}</span>}
                  </span>
                  {it.detail && <span className="ex-code-item-detail">{it.detail}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
