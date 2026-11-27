/**
 * A yes/no (or on/off) filter as a tri-state segmented control — Any, then its
 * two values — the rail counterpart of a boolean chip (Enabled, Has receiver,
 * Muted now, Notification grouping). One value is picked at a time; picking the
 * active one again, or Any, clears it. `values` carry counts, shown on each.
 *
 * `onSet(value|null)` sets the one value, or clears to Any; the parent writes it
 * into the shared selection, so the chip bar reflects it at once.
 */
export default function FacetToggle({ title, values = [], selected, onSet, renderLabel }) {
  const current = values.find(o => selected?.has(o.value))?.value ?? null
  const label = o => (renderLabel ? renderLabel(o.value) : o.value)
  return (
    <div className="facet-group facet-toggle" role="group" aria-label={title}>
      <div className="facet-toggle-title">{title}</div>
      <div className="facet-toggle-seg">
        <button
          type="button"
          className={`facet-toggle-opt${current == null ? ' on' : ''}`}
          aria-pressed={current == null}
          onClick={() => onSet(null)}
        >
          Any
        </button>
        {values.map(o => (
          <button
            key={o.value}
            type="button"
            className={`facet-toggle-opt${current === o.value ? ' on' : ''}`}
            aria-pressed={current === o.value}
            onClick={() => onSet(current === o.value ? null : o.value)}
            title={`${label(o)}: ${o.count} rule${o.count === 1 ? '' : 's'}`}
          >
            {label(o)}
            <span className="facet-toggle-count">{o.count}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
