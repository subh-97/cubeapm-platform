import { useMemo, useState } from 'react'
import { CircleCheck } from 'lucide-react'
import { statusForAlertState } from '@/utils/status'
import { worstFiring, quietLine } from './firingSummary'
import { buildLanes } from './timelineLanes'
import AlertTimeline from './AlertTimeline'
import { StaleLine } from './ListStates'

/**
 * The band above the rules (D2): the timeline of the range, open whenever a
 * rule fires that nobody has silenced. When nothing does, the band is one
 * line, and the timeline opens only on request. How old the list is sits in
 * the page bar, beside Auto; a failed refresh says so here, over the data.
 *
 * It no longer has a title, state pills or a banner for the worst rule: the
 * State facet's counts and the first row, worst first, already say what is
 * firing now.
 */
export default function FiringNow({
  rules, timeline, byId, seriesFor, win, onOpenRule, setTimeRange, stale, onRetry,
}) {
  const firing = useMemo(() => worstFiring(rules) != null, [rules])
  const hasLanes = useMemo(() => buildLanes(timeline, byId, win).length > 0, [timeline, byId, win])
  const [timelineAsked, setTimelineAsked] = useState(false)
  const showTimeline = firing || timelineAsked

  return (
    <div className="rtab-band">
      <StaleLine stale={stale} onRetry={onRetry} />

      {!firing && (
        <div className="rtab-quiet" role="status">
          <CircleCheck className={statusForAlertState('ok')} aria-hidden="true" />
          <span className="rtab-quiet-text">{quietLine({ rules, timeline, win })}</span>
          {hasLanes && (
            <button type="button" className="hbtn small" aria-expanded={timelineAsked} onClick={() => setTimelineAsked(v => !v)}>
              {timelineAsked ? 'Hide timeline' : 'Show timeline'}
            </button>
          )}
        </div>
      )}

      {showTimeline && (
        // Folded on arrival, unless "Show timeline" was what brought it.
        <AlertTimeline
          timeline={timeline} byId={byId} seriesFor={seriesFor} win={win}
          onOpenRule={onOpenRule} setTimeRange={setTimeRange} defaultOpen={timelineAsked}
        />
      )}
    </div>
  )
}
