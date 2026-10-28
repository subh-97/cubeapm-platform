import { useId, useState } from 'react'
import { ArrowRight, ChevronRight, Plus } from 'lucide-react'
import { AlertDialog } from '@/components/alerts/shared'
import { RULE_TEMPLATES } from '@/utils/alerts/ruleTemplates'
import awsLogo from '@/assets/infra/aws.svg'
import kafkaLogo from '@/assets/infra/kafka.svg'
import kubernetesLogo from '@/assets/infra/kubernetes.svg'

/**
 * The two ways to make a rule, side by side above the timeline: from a
 * template (white) or from scratch (the brand's blue). A template opens the
 * editor already set (utils/alerts/ruleTemplates.js); scratch opens it blank.
 * `onTemplate(template)` and `onScratch()` do the opening.
 */
export default function CreateRuleBanners({ onTemplate, onScratch }) {
  const [picking, setPicking] = useState(false)
  const templateId = useId()
  const scratchId = useId()

  return (
    <div className="rtab-slots">
      <section className="rtab-slot rtab-create is-template" aria-labelledby={templateId}>
        <TemplatesArt />
        <div className="rtab-create-body">
          <h2 id={templateId} className="rtab-create-title">Create a rule from a template</h2>
          <p className="rtab-create-text">Start from a ready-made rule for errors, latency, CPU or logs.</p>
        </div>
        <button type="button" className="hbtn rtab-create-cta" aria-haspopup="dialog" onClick={() => setPicking(true)}>
          Browse templates<ArrowRight aria-hidden="true" />
        </button>
      </section>

      <section className="rtab-slot rtab-create is-scratch" aria-labelledby={scratchId}>
        <ScratchArt />
        <div className="rtab-create-body">
          <h2 id={scratchId} className="rtab-create-title">Create a rule from scratch</h2>
          <p className="rtab-create-text">Write your own query and thresholds, then preview it.</p>
        </div>
        <button type="button" className="hbtn rtab-create-cta" onClick={onScratch}>
          <Plus aria-hidden="true" />Create rule
        </button>
      </section>

      {picking && (
        <TemplatePicker
          onCancel={() => setPicking(false)}
          onPick={(t) => { setPicking(false); onTemplate(t) }}
        />
      )}
    </div>
  )
}

// A small stack of rule cards, the front one a rule already drawn: a line
// under its dashed threshold. Each card wears what it watches on a bubble at
// its corner, as the scratch banner wears its plus — the vendors' own marks
// from assets/infra, as the Infrastructure page draws them. Brand tints
// otherwise, never a status hue.
function TemplatesArt() {
  return (
    <svg className="rtab-create-art" viewBox="0 0 112 88" aria-hidden="true">
      <rect className="art-back" x="42" y="10" width="62" height="42" rx="7" />
      <rect className="art-bar" x="50" y="16" width="20" height="4" rx="2" />
      <LogoBubble cx={104} cy={10} href={kafkaLogo} />
      <rect className="art-mid" x="25" y="23" width="62" height="42" rx="7" />
      <rect className="art-bar" x="33" y="29" width="20" height="4" rx="2" />
      <LogoBubble cx={87} cy={23} href={awsLogo} />
      <rect className="art-card" x="8.5" y="37.5" width="64" height="49" rx="7.5" />
      <rect className="art-bar" x="16" y="46" width="24" height="4" rx="2" />
      <line className="art-threshold" x1="16" y1="58" x2="65" y2="58" />
      <path className="art-area" d="M16 78 L25 74 L33 76 L42 69 L50 71 L58 62 L65 56 V80 H16 Z" />
      <polyline className="art-line" points="16,78 25,74 33,76 42,69 50,71 58,62 65,56" />
      <LogoBubble cx={72.5} cy={37.5} href={kubernetesLogo} />
    </svg>
  )
}

function LogoBubble({ cx, cy, href }) {
  return (
    <g>
      <circle className="art-badge" cx={cx} cy={cy} r="8" />
      <image href={href} x={cx - 5} y={cy - 5} width="10" height="10" />
    </g>
  )
}

// An empty chart with a line half drawn toward its dashed threshold, and a
// plus at the corner: the rule is yours to write. White at low alphas on blue.
function ScratchArt() {
  return (
    <svg className="rtab-create-art" viewBox="0 0 112 88" aria-hidden="true">
      <rect className="art-frame" x="6.5" y="12.5" width="92" height="70" rx="8" />
      <rect className="art-bar" x="15" y="21" width="28" height="4" rx="2" />
      <line className="art-grid" x1="15" y1="52" x2="90" y2="52" />
      <line className="art-grid" x1="15" y1="66" x2="90" y2="66" />
      <line className="art-threshold" x1="15" y1="38" x2="90" y2="38" />
      <polyline className="art-line" points="15,71 26,67 35,69 46,59 55,62 66,49" />
      <polyline className="art-line art-ghost" points="66,49 76,44 88,40" />
      <circle className="art-dot" cx="66" cy="49" r="3" />
      <circle className="art-badge" cx="98" cy="13" r="11" />
      <path className="art-plus" d="M98 8 V18 M93 13 H103" />
    </svg>
  )
}

// The templates as a list to choose from; one opens the editor on it.
function TemplatePicker({ onPick, onCancel }) {
  const bodyId = useId()
  return (
    <AlertDialog title="Create a rule from a template" onCancel={onCancel} describedBy={bodyId}>
      <p id={bodyId} className="alr-dialog-text">Pick one to open the editor with it set. Nothing is saved until you save it there.</p>
      <ul className="rtab-tpl-list">
        {RULE_TEMPLATES.map(t => (
          <li key={t.id}>
            <button type="button" className="rtab-tpl" onClick={() => onPick(t)}>
              <span className="rtab-tpl-text">
                <span className="rtab-tpl-title">{t.title}</span>
                <span className="rtab-tpl-desc">{t.description}</span>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </AlertDialog>
  )
}
