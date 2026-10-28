import { useRef } from 'react'
import { clsx } from 'clsx'
import './filter-chips.css'

/**
 * Capsules that narrow a list to one kind: "All", then each kind with its mark
 * and how many it holds. One choice at a time, so a radio group: the arrow
 * keys, Home and End move between the capsules and choose as they go, with
 * only the chosen one in the Tab order. A capsule that holds nothing stays
 * choosable, dimmed. The mark is decoration; the label names the capsule.
 *
 * Not TabBar: tabs switch between views of a page, capsules filter one list,
 * and they wrap onto a second line where tabs would have to scroll.
 *
 * @param {{ options: Array<{ id: string, label: string, count?: number, icon?: import('react').ReactNode }>,
 *   active: string, onChange: (id: string) => void, ariaLabel: string, className?: string }} props
 */
export default function FilterChips({ options, active, onChange, ariaLabel, className }) {
  const refs = useRef(new Map())
  const onKeyDown = (e) => {
    const n = options.length
    const i = options.findIndex(o => o.id === active)
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n
        : e.key === 'Home' ? 0
          : e.key === 'End' ? n - 1
            : null
    if (to == null || !options[to]) return
    e.preventDefault()
    onChange(options[to].id)
    refs.current.get(options[to].id)?.focus()
  }
  return (
    <div className={clsx('chips', className)} role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {options.map(o => {
        const on = o.id === active
        return (
          <button
            key={o.id}
            ref={el => (el ? refs.current.set(o.id, el) : refs.current.delete(o.id))}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={clsx('chip', on && 'is-on', o.count === 0 && 'is-empty')}
            onClick={() => onChange(o.id)}
          >
            {o.icon && <span className="chip-icon" aria-hidden="true">{o.icon}</span>}
            {o.label}
            {o.count != null && <span className="chip-count">{o.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
