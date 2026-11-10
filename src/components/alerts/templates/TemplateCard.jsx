import { useId } from 'react'
import { ArrowRight, Lock } from 'lucide-react'
import { statusForAlertState, STATUS } from '@/utils/status'
import {
  SUBDOMAINS, PROBLEM_TYPES, DATA_SOURCES, URGENCIES, HOSTINGS, domainOf, fullName, templateSource,
} from '@/utils/alerts/ruleTemplates'
import { displayName } from '@/utils/alerts/describe'
import { CategoryMark, HostingMark } from './TemplateMarks'

const LABEL = list => Object.fromEntries(list.map(x => [x.id, x]))
const PROBLEM = LABEL(PROBLEM_TYPES)
const SOURCE = LABEL(DATA_SOURCES)
const URGENCY = LABEL(URGENCIES)
const HOSTING = LABEL(HOSTINGS)

// Urgency is a severity, so its colour comes from the alert scale (CLAUDE.md
// rule 1): High as a firing critical, Medium as a firing warning; Low has no
// severity to borrow and stays neutral. Always beside its word.
const urgencyTone = u => (u === 'high' ? statusForAlertState('firing', 'critical')
  : u === 'medium' ? statusForAlertState('firing', 'warning')
    : STATUS.neutral)

/**
 * One template on Browse Templates. Its path names its home, in whatever
 * category it is listed; the title is "Subject + state"; the definition is
 * one line, what it alerts on; the tags are its urgency, problem type, data
 * source, hosting and what it waits on. "Use template" is the card's one
 * control, at the foot's right, and its ::after covers the card, so the whole
 * card opens the editor while a keyboard meets one stop per card; what
 * carries a tooltip sits above the cover. A template the platform cannot run
 * yet keeps its place with the button disabled and the reason said beside it.
 *
 * `usedBy` are the rules already made from it, named to a screen reader on
 * the button too.
 */
export default function TemplateCard({ template: t, usedBy = [], onUse }) {
  const uid = useId()
  const home = SUBDOMAINS[t.home]
  const domain = domainOf(t.home)
  const usedNames = usedBy.map(displayName).join(', ')
  const inUseId = `${uid}-inuse`
  const blockedId = `${uid}-blocked`
  return (
    <li className={`tpl-card${t.blocked ? ' is-blocked' : ''}`}>
      <div className="tpl-card-top">
        <span className="tpl-path">
          <CategoryMark icon={home.icon} size={13} />
          {domain.label} · {home.label}
        </span>
        {usedBy.length > 0 && (
          <span className="tpl-inuse" id={inUseId} title={`Already used by ${usedNames}`}>
            In use<span className="sr-only"> by {usedNames}</span>
          </span>
        )}
      </div>

      <h3 className="tpl-title">{t.title}</h3>
      <p className="tpl-def">{t.subtitle}</p>

      <ul className="tpl-tags" aria-label="Tags">
        <li className="tpl-tag tpl-urgency" title={`${URGENCY[t.urgency].label} urgency: ${URGENCY[t.urgency].word.toLowerCase()}`}>
          <span className={`status-dot ${urgencyTone(t.urgency)}`} aria-hidden="true" />
          {URGENCY[t.urgency].label} urgency<span className="sr-only">: {URGENCY[t.urgency].word.toLowerCase()}</span>
        </li>
        <li className="tpl-tag">{PROBLEM[t.problem].label}</li>
        <li className="tpl-tag">{SOURCE[templateSource(t)].label}</li>
        {t.hosting.map(h => (
          <li key={h} className="tpl-tag tpl-hosting"><HostingMark hosting={h} />{HOSTING[h].label}</li>
        ))}
        {t.needs && <li className="tpl-tag tpl-needs">Needs {t.needs}</li>}
      </ul>

      <div className="tpl-card-foot">
        {t.blocked ? (
          <>
            <span className="tpl-blocked-why" id={blockedId}>{t.blocked}</span>
            <button type="button" className="hbtn tpl-use" aria-disabled="true" aria-label={`Not available yet: ${fullName(t)}`} aria-describedby={blockedId}>
              <Lock aria-hidden="true" />Not available yet
            </button>
          </>
        ) : (
          <button
            type="button" className="hbtn primary tpl-use"
            aria-label={`Use template: ${fullName(t)}`} aria-describedby={usedBy.length ? inUseId : undefined}
            onClick={() => onUse?.(t)}
          >
            Use template<ArrowRight aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  )
}
