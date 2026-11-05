import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { DOMAINS, SUBDOMAINS } from '@/utils/alerts/ruleTemplates'
import { CategoryMark } from './TemplateMarks'

const ALL = 'all'

/**
 * The catalogue as a tree of accordions: All templates at the root, the
 * Domains under it by name alone, each Domain's Sub-domains under that with
 * their marks — the Infrastructure page's AWS / GCP / Kubernetes groups
 * again (index.css, "accordion group sources"), any number open at once.
 * The chevron at a row's right opens and closes it and nothing else; choosing
 * the row shows its templates and opens it. All templates and the Domain in view open with the page; the other
 * Domains start closed, so the rail is five rows until one is asked for. A
 * closed row's children leave the tab order and the accessibility tree.
 *
 * Each row is a button that scopes the page; the one in view carries
 * aria-current. A row's count is the templates homed there under the search
 * and filters; a row holding none is muted and still choosable. ↑/↓, Home and
 * End move between the rows in view; → opens a row, or steps into an open
 * one; ← closes it, or steps back to its parent.
 *
 * Built on the Infrastructure page's source rail (.svc-sidebar-*), with
 * buttons where that rail has bare divs.
 *
 * @param {{ scope: { domain: string|null, sub: string|null },
 *   counts: { all: number, domains: object, subs: object },
 *   onScope: (scope: { domain: string|null, sub: string|null }) => void }} props
 */
export default function TemplateRail({ scope, counts, onScope }) {
  const list = useRef(null)
  const uid = useId()
  const [open, setOpen] = useState(() => new Set([ALL, scope.domain].filter(Boolean)))
  const setNodeOpen = (id, next) => setOpen((o) => {
    if (o.has(id) === next) return o
    const n = new Set(o)
    if (next) n.add(id)
    else n.delete(id)
    return n
  })

  // A scope that arrives from elsewhere — a link, Back, "Show all" — opens the
  // way down to it: All templates always, and its Domain when it has one.
  // Closing a row stays the viewer's to do; a new Sub-domain in the same
  // Domain, a search or a filter reopens nothing.
  useEffect(() => {
    setNodeOpen(ALL, true)
    if (scope.domain) setNodeOpen(scope.domain, true)
  }, [scope.domain])

  const onKeyDown = (e) => {
    const rows = [...(list.current?.querySelectorAll('button.tpl-rail-row') ?? [])].filter(r => !r.closest('.is-closed'))
    const el = document.activeElement
    const i = rows.indexOf(el)
    if (i < 0) return
    const { node, parent } = el.dataset
    if (e.key === 'ArrowRight' && node) {
      e.preventDefault()
      if (open.has(node)) rows[i + 1]?.focus()
      else setNodeOpen(node, true)
      return
    }
    if (e.key === 'ArrowLeft' && (node || parent)) {
      e.preventDefault()
      if (node && open.has(node)) setNodeOpen(node, false)
      else if (parent) rows.find(r => r.dataset.node === parent)?.focus()
      return
    }
    const to = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1)
      : e.key === 'ArrowUp' ? Math.max(0, i - 1)
        : e.key === 'Home' ? 0
          : e.key === 'End' ? rows.length - 1
            : null
    if (to == null) return
    e.preventDefault()
    rows[to].focus()
  }

  const row = ({ label, icon, count, current, onClick, level, node, parent }) => (
    <button
      type="button"
      className={`svc-sidebar-item tpl-rail-row tpl-rail-l${level}${level === 2 ? ' svc-sidebar-child' : ''}${current ? ' active' : ''}${count === 0 ? ' is-empty' : ''}`}
      data-node={node}
      data-parent={parent}
      aria-current={current ? 'true' : undefined}
      onClick={onClick}
    >
      {icon && <CategoryMark icon={icon} size={14} className="svc-sidebar-icon tpl-rail-mark" />}
      <span className="svc-sidebar-name">{label}</span>
      <span className="svc-sidebar-count">{count}</span>
    </button>
  )

  // A row with children: the row, its chevron, and the children it opens.
  const branch = ({ id, label, rowProps, children }) => {
    const isOpen = open.has(id)
    const childrenId = `${uid}-${id}`
    return (
      <>
        <div className="tpl-rail-head">
          {row({ ...rowProps, label, node: id })}
          <button
            type="button"
            className="tpl-rail-toggle"
            aria-expanded={isOpen}
            aria-controls={childrenId}
            aria-label={`${label} categories`}
            title={isOpen ? `Collapse ${label}` : `Expand ${label}`}
            onClick={() => setNodeOpen(id, !isOpen)}
          >
            <ChevronDown className={`svc-sidebar-group-chev${isOpen ? ' open' : ''}`} aria-hidden="true" />
          </button>
        </div>
        <div id={childrenId} className={`tpl-rail-subs${isOpen ? '' : ' is-closed'}`}>
          <ul>{children}</ul>
        </div>
      </>
    )
  }

  return (
    <nav className="tpl-rail" aria-label="Template categories">
      <ul ref={list} className="tpl-rail-list" onKeyDown={onKeyDown}>
        <li>
          {branch({
            id: ALL, label: 'All templates',
            rowProps: {
              level: 0, count: counts.all, current: !scope.domain && !scope.sub,
              onClick: () => { setNodeOpen(ALL, true); onScope({ domain: null, sub: null }) },
            },
            children: DOMAINS.map(d => (
              <li key={d.id} className="tpl-rail-domain">
                {branch({
                  id: d.id, label: d.label,
                  rowProps: {
                    level: 1, parent: ALL, count: counts.domains[d.id] ?? 0,
                    current: scope.domain === d.id && !scope.sub,
                    onClick: () => { setNodeOpen(d.id, true); onScope({ domain: d.id, sub: null }) },
                  },
                  children: d.subs.map(id => (
                    <li key={id}>
                      {row({
                        level: 2, label: SUBDOMAINS[id].label, icon: SUBDOMAINS[id].icon, parent: d.id, count: counts.subs[id] ?? 0,
                        current: scope.sub === id, onClick: () => onScope({ domain: d.id, sub: id }),
                      })}
                    </li>
                  )),
                })}
              </li>
            )),
          })}
        </li>
      </ul>
    </nav>
  )
}
