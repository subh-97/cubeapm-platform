import ExSelect from '@/components/explore/ExSelect'
import { STATIC_OPERATORS, ANOMALY_OPERATORS } from '@/utils/alerts/catalog'

const STATIC_OPTIONS = STATIC_OPERATORS.map(o => ({ value: o.op, label: o.words }))
const ANOMALY_OPTIONS = ANOMALY_OPERATORS.map(o => ({ value: o.op, label: o.words }))

/**
 * The two named tiers (docs/alerts/DESIGN.md D7). Production asks for a
 * "Condition" and an "Additional Condition (optional)" that tags
 * severity=critical; here they are what they are, Warning and Critical, and
 * either or both may be set. A row left empty is off.
 *
 * The operators are production's six (three for anomaly), verbatim, as words;
 * the sentence above writes the symbol. Each threshold carries its unit (R27):
 * a latency alert is in milliseconds while the APM charts show seconds, and
 * production's inputs say nothing about either.
 */
export default function TierRows({ kind, rows, unit, onTier, problems }) {
  const anomaly = kind === 'anomaly'
  const options = anomaly ? ANOMALY_OPTIONS : STATIC_OPTIONS
  const suffix = anomaly ? 'deviations' : unit === 'count' ? '' : unit === 'x' ? '×' : unit
  return (
    <div className="ae-tiers" id="ae-field-tiers" tabIndex={-1}>
      {['warning', 'critical'].map(name => {
        const row = rows[name]
        const problem = problems[`tier-${name}`]
        const label = name === 'warning' ? 'Warning' : 'Critical'
        return (
          <div key={name} className={`ae-tier ${name}`} id={`ae-field-tier-${name}`}>
            <span className="ae-tier-name">{label} when</span>
            <ExSelect
              value={row.op}
              options={options}
              onChange={op => onTier(name, { op })}
              ariaLabel={`${label} condition`}
              width={200}
            />
            <span className={`ae-tier-input${problem ? ' invalid' : ''}`}>
              <input
                type="text"
                inputMode="decimal"
                value={row.value}
                placeholder="Not set"
                aria-label={`${label} threshold${suffix ? ` in ${suffix}` : ''}`}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? `ae-tier-${name}-problem` : undefined}
                onChange={e => onTier(name, { value: e.target.value })}
              />
              {suffix && <span className="ae-tier-unit">{suffix}</span>}
            </span>
            {row.value !== '' && (
              <button type="button" className="ae-link" onClick={() => onTier(name, { value: '' })}>
                Clear
              </button>
            )}
            {problem && <span id={`ae-tier-${name}-problem`} className="ae-field-problem">{problem}</span>}
          </div>
        )
      })}
      {anomaly && (
        <p className="ae-hint">
          A deviation is one standard deviation of the query&apos;s usual value at that time of day. The preview
          draws the usual range as a grey band; a reading outside it by the number set here fires.
        </p>
      )}
      {problems.tiers && <p className="ae-field-problem" role="status">{problems.tiers}</p>}
    </div>
  )
}
