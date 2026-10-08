import { useState, useEffect, useLayoutEffect, useRef } from 'react'

const STEPS = [
  {
    target: '.nav',
    badge: 'Step 1',
    title: 'Navigate the platform',
    desc: 'Jump between Home, APM & Services, Logs, Infra and more. Hover an icon in the collapsed sidebar to see its name.',
    placement: 'right',
    pad: 6,
  },
  {
    target: '.summary-strip',
    badge: 'Step 2',
    title: 'Fleet health at a glance',
    desc: 'Total services, plus a live count of Critical, Warning, and Healthy. Colors are reserved strictly for severity across the platform.',
    placement: 'bottom',
    pad: 8,
  },
  {
    target: '.panel table',
    badge: 'Step 3',
    title: 'Critical services surface first',
    desc: 'The service list always sorts by severity, never alphabetically. Incidents lead so you can act instead of scroll.',
    placement: 'top',
    pad: 8,
  },
  {
    target: '.help-btn',
    badge: 'Step 4',
    title: 'Help is always one click away',
    desc: 'Open the Help Center anytime from this icon to search guides, learn each feature, and find what you need.',
    placement: 'right',
    pad: 6,
    opensHelp: true,
  },
]

function computePosition(rect, tooltipWidth, tooltipHeight, placement, pad) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 14
  let top, left, arrow = placement
  if (placement === 'bottom') {
    top = rect.bottom + pad + gap
    left = rect.left
    if (top + tooltipHeight > vh - 20) {
      top = rect.top - pad - gap - tooltipHeight
      arrow = 'top'
    }
    if (left + tooltipWidth > vw - 20) left = vw - tooltipWidth - 20
    if (left < 20) left = 20
  } else if (placement === 'top') {
    top = rect.top - pad - gap - tooltipHeight
    left = rect.left
    if (top < 20) {
      top = rect.bottom + pad + gap
      arrow = 'bottom'
    }
    if (left + tooltipWidth > vw - 20) left = vw - tooltipWidth - 20
    if (left < 20) left = 20
  } else if (placement === 'right') {
    top = rect.top
    left = rect.right + pad + gap
    if (left + tooltipWidth > vw - 20) {
      left = rect.left - pad - gap - tooltipWidth
      arrow = 'right'
    }
    if (top + tooltipHeight > vh - 20) top = vh - tooltipHeight - 20
    if (top < 20) top = 20
  } else {
    top = rect.top
    left = rect.left - pad - gap - tooltipWidth
    if (left < 20) {
      left = rect.right + pad + gap
      arrow = 'left'
    }
    if (top + tooltipHeight > vh - 20) top = vh - tooltipHeight - 20
    if (top < 20) top = 20
  }
  const arrowOpposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
  return { top, left, arrow: arrowOpposite[arrow] }
}

export default function Walkthrough({ onFinish, onOpenHelp }) {
  const [step, setStep] = useState(0)
  const [pos, setPos] = useState(null)
  const [rect, setRect] = useState(null)
  const tooltipRef = useRef(null)

  const cfg = STEPS[step]
  const isLast = step === STEPS.length - 1

  const finishStep = () => {
    if (cfg.opensHelp) onOpenHelp?.()
    onFinish?.()
  }

  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector(cfg.target)
      if (!el) { setRect(null); return }
      const r = el.getBoundingClientRect()
      setRect(r)
      const tw = 320
      const th = tooltipRef.current?.offsetHeight || 180
      setPos(computePosition(r, tw, th, cfg.placement, cfg.pad))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [step, cfg.target, cfg.placement, cfg.pad])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onFinish?.()
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (isLast) finishStep()
        else setStep(s => s + 1)
      }
      if (e.key === 'ArrowLeft' && step > 0) setStep(s => s - 1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [step, onFinish, isLast])

  return (
    <div className="wt-overlay" role="dialog" aria-label="Platform walkthrough">
      <div className="wt-mask" onClick={onFinish} />
      {rect && (
        <div
          className="wt-spotlight"
          style={{
            top: rect.top - cfg.pad,
            left: rect.left - cfg.pad,
            width: rect.width + cfg.pad * 2,
            height: rect.height + cfg.pad * 2,
          }}
        />
      )}
      {pos && (
        <div
          ref={tooltipRef}
          className="wt-tooltip"
          style={{ top: pos.top, left: pos.left }}
          onClick={e => e.stopPropagation()}
        >
          <span className={`wt-arrow ${pos.arrow}`} />
          <div className="wt-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 10, height: 10 }}><path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z"/></svg>
            {cfg.badge}
          </div>
          <div className="wt-title">{cfg.title}</div>
          <div className="wt-desc">{cfg.desc}</div>
          <div className="wt-progress">
            {STEPS.map((_, i) => (
              <span key={i} className={`wt-progress-dot${i < step ? ' done' : i === step ? ' active' : ''}`} />
            ))}
          </div>
          <div className="wt-actions">
            <button className="wt-skip" onClick={onFinish}>Skip tour</button>
            <div className="wt-nav">
              {step > 0 && (
                <button className="wt-btn secondary" onClick={() => setStep(s => s - 1)}>Back</button>
              )}
              <button className="wt-btn primary" onClick={() => isLast ? finishStep() : setStep(s => s + 1)}>
                {isLast ? (cfg.opensHelp ? 'Open Help Center' : 'Finish') : 'Next'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
