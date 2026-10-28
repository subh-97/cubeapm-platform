import { ReferenceLine } from 'recharts'
import { thresholdBands } from '@/components/charts/thresholdBands'
import { formatThreshold } from '@/utils/alerts/describe'

// A rule's tiers drawn on its chart (D7): both tiers' bands where production
// draws only its primary threshold as a thin red line (R45). The tiers are
// read off the view's `tiers` — what the rule stores — never re-derived from
// the query, so the bands are exactly the rule.
//
// Returns Recharts elements for LegendLineChart's `overlays`, like
// thresholdBands itself; never wrap them in a component.

const HIGHER = new Set(['>', '>='])
const LOWER = new Set(['<', '<='])

/**
 * The bands for a static rule's tiers:
 *
 *   - both tiers above (> / >=): good below warning, amber to critical, red above;
 *   - both below (< / <=): the same, the other way up (an RPM drop);
 *   - one tier: one line to cross, so two zones;
 *   - anything else — equality (`== 0`, a synthetic monitor down), or tiers
 *     pointing different ways — is drawn as dashed rules at the thresholds
 *     with no zones, since a zone would claim a side that is not "worse".
 *
 * Each rule is labelled with its threshold in the rule's unit ("3%").
 * An anomaly rule's tiers are deviations, not readings: none here (its
 * expected range is chartOverlays' expectedRangeBand).
 */
export function tierBands(view, { keyPrefix = 'tiers' } = {}) {
  if (!view || view.kind === 'anomaly') return []
  const { warning = null, critical = null } = view.tiers ?? {}
  const fmt = v => formatThreshold(view, v)
  const tiers = [warning, critical].filter(Boolean)
  if (tiers.length === 0) return []
  const all = ops => tiers.every(t => ops.has(t.op))
  if (all(HIGHER) || all(LOWER)) {
    return thresholdBands({
      good: warning?.threshold,
      poor: critical?.threshold,
      direction: all(LOWER) ? 'lower' : 'higher',
      keyPrefix,
      fmt,
    })
  }
  const rule = (tier, severity) => (
    <ReferenceLine
      key={`${keyPrefix}-${severity}-rule`}
      y={tier.threshold}
      stroke={severity === 'critical' ? 'var(--critical)' : 'var(--warning)'}
      strokeDasharray="4 3"
      strokeOpacity={0.8}
      label={{ value: `${tier.op === '!=' ? '≠' : '='} ${fmt(tier.threshold)}`, position: 'insideBottomRight', offset: 4, fill: 'var(--text-muted)', fontSize: 10 }}
      ifOverflow="hidden"
    />
  )
  return [
    ...(warning ? [rule(warning, 'warning')] : []),
    ...(critical ? [rule(critical, 'critical')] : []),
  ]
}
