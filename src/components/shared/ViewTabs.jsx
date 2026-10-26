import { useRef } from 'react'
import { viewTabId, viewTabPanelId } from './viewTabIds'
import './view-tabs.css'

// The underline tab strip under a page's card head: icon + label tabs that pick
// which view the card body shows. The service page drew one for its views and
// Browser drew another for its own, the same markup written out twice; Alerts
// is the third page to want it, so it lives here now (docs/alerts/DESIGN.md).
//
// Two forms, because the two copies were not the same:
//
//   - Given an `idPrefix`, the strip is the full tablist pattern Browser built:
//     every tab names the panel it controls, the open tab is the strip's one Tab
//     stop, and the arrows, Home and End move along it. The page labels its body
//     with `viewTabPanelId(idPrefix)` / `viewTabId(idPrefix, active)` from
//     ./viewTabIds.
//   - Without one it is the service page's plain strip, attribute for attribute,
//     so moving that page here changed nothing it draws. Giving it an `idPrefix`
//     is how it would gain the keyboard pattern too.
//
// The attribute order below is each original's, which is what lets their
// markup come out byte-identical (sharedUi.test.js keeps them as fixtures).

/**
 * @param {object} props
 * @param {{id: string, label: string, Icon: Function, count?: import('react').ReactNode}[]} props.tabs
 * @param {string} props.active        the id of the open tab
 * @param {(id: string) => void} props.onSelect
 * @param {string} props.ariaLabel     names the tablist ("Service views")
 * @param {string} [props.idPrefix]    turns on the full tablist pattern
 * @param {{current: object}} [props.tabRefs]  receives each tab's button by id,
 *   for a page that puts focus back on its open tab when the body is replaced
 */
export default function ViewTabs({ tabs, active, onSelect, ariaLabel, idPrefix, tabRefs, className }) {
  const ownRefs = useRef({})
  const refs = tabRefs ?? ownRefs
  const full = !!idPrefix
  const panel = full ? viewTabPanelId(idPrefix) : undefined

  // The strip is one Tab stop; the arrows, Home and End move along it, and
  // Enter or Space opens the tab (a new screen, so it is not done on arrow).
  const onKeyDown = (e) => {
    const ids = tabs.map(t => t.id)
    const i = ids.indexOf(document.activeElement?.dataset?.tab ?? active)
    const to = e.key === 'ArrowRight' ? (i + 1) % ids.length
      : e.key === 'ArrowLeft' ? (i - 1 + ids.length) % ids.length
        : e.key === 'Home' ? 0
          : e.key === 'End' ? ids.length - 1
            : null
    if (to == null) return
    e.preventDefault()
    refs.current[ids[to]]?.focus()
  }

  return (
    <div
      className={`view-tabs${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={full ? onKeyDown : undefined}
    >
      {tabs.map(({ Icon, ...t }) => {
        const on = active === t.id
        return (
          <button
            key={t.id}
            ref={full ? (el => { refs.current[t.id] = el }) : undefined}
            {...(full ? { id: viewTabId(idPrefix, t.id), 'data-tab': t.id } : null)}
            type="button"
            role="tab"
            aria-selected={on}
            {...(full ? { 'aria-controls': panel, tabIndex: on ? 0 : -1 } : null)}
            className={`view-tab${on ? ' active' : ''}`}
            onClick={() => onSelect(t.id)}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
            {t.label}
            {t.count != null && t.count !== '' && <span className="view-tab-count">{t.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
