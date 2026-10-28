// What the main card shows while an Alerts page's code loads, the first time
// one is opened (docs/alerts/PLAN.md 7a, "Known gaps"). The three pages are
// split from the main bundle — about 240 kB that nothing else needs — so the
// first visit waits a moment for them. The wait is drawn in the shape of the
// page coming, in the platform's quiet bones (no spinner), and kept here,
// outside the split code, so it needs nothing that is still loading.

const bone = (style, key) => <span key={key} className="ovsk-bone" style={style} />

const card = { background: 'var(--card)', border: '1px solid var(--card-border)', borderRadius: 'var(--radius-lg)' }
const row = { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderTop: '1px solid var(--border-subtle)' }

function Tabs() {
  return (
    <div style={{ display: 'flex', gap: 18, padding: '4px 2px 12px' }}>
      {[64, 70, 104, 116, 98].map((w, i) => bone({ width: w, height: 14 }, i))}
    </div>
  )
}

function Rows({ count }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} style={row}>
      {bone({ width: 14, height: 14 })}
      {bone({ width: 64, height: 18 })}
      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        {bone({ width: `${58 - (i % 3) * 9}%`, height: 12 })}
        {bone({ width: `${40 + (i % 2) * 12}%`, height: 10 })}
      </span>
      {bone({ width: 90, height: 12 })}
    </div>
  ))
}

/**
 * `kind` is the page on its way: 'list' (the tabs), 'rule' (a rule's page) or
 * 'editor'.
 */
export default function AlertsPageSkeleton({ kind = 'list' }) {
  return (
    <div className="skeleton-shell" aria-busy="true" aria-label="Loading Alerts">
      {kind === 'list' && (
        <>
          <Tabs />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 10 }}>
            {Array.from({ length: 6 }, (_, i) => bone({ height: 54, borderRadius: 'var(--radius-md)' }, i))}
          </div>
          <div style={card}>
            <div style={{ padding: '12px 16px' }}>{bone({ width: '42%', height: 28 })}</div>
            <Rows count={6} />
          </div>
        </>
      )}
      {kind === 'rule' && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {bone({ width: 320, height: 20 })}
            {bone({ width: 220, height: 12 })}
          </div>
          <div style={{ ...card, padding: 16 }}>{bone({ width: '100%', height: 220 })}</div>
          <div style={card}><Rows count={3} /></div>
        </>
      )}
      {kind === 'editor' && (
        <>
          {bone({ width: 200, height: 20 })}
          {[180, 120, 120].map((h, i) => (
            <div key={i} style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {bone({ width: 140, height: 12 })}
              {bone({ width: '100%', height: h - 50 })}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
