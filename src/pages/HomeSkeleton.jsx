export default function HomeSkeleton() {
  return (
    <div className="skeleton-shell" aria-hidden aria-label="Loading dashboard">
      <div className="sk-summary">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="sk-pill">
            <div className="sk-num" />
            <div className="sk-lbl" />
          </div>
        ))}
      </div>

      <div className="sk-tabs">
        <div className="sk-block" />
        <div className="sk-block" />
        <div className="sk-block" />
      </div>

      <div className="sk-table">
        <div className="sk-table-head">
          <div className="sk-lbl" />
        </div>
        {[0, 1, 2, 3, 4, 5, 6].map(i => (
          <div key={i} className="sk-row">
            <div className="sk-row-svc">
              <div className="sk-dot" />
              <div className="sk-line" />
            </div>
            <div className="sk-cell" />
            <div className="sk-cell" />
            <div className="sk-cell" />
            <div className="sk-cell" />
          </div>
        ))}
      </div>
    </div>
  )
}
