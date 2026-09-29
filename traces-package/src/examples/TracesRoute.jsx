// How the two pages connect.
//
// This file is the one thing in the package written for the package rather
// than copied out of the app — everything else is byte-identical to its
// source. It exists because the explorer and the detail view are each
// self-contained, and the thing that is *not* in either of them is the wiring
// between them: which props cross, who owns the trace id, and what happens
// when a span row is clicked. In the app that lives in `App.jsx` among six
// other views. Here it is on its own.
//
// Two things below are not obvious and are easy to lose in a rewrite. Both are
// commented where they happen.

import { useCallback, useState } from 'react'
import TracesView from '@/pages/TracesView'
import TraceDetail from '@/pages/TraceDetail'

export default function TracesRoute({ goHome, setToast }) {
  const [traceId, setTraceId] = useState('')
  const [timeRange, setTimeRange] = useState('Last 1 hour')
  const [settingsOpen, setSettingsOpen] = useState(false)

  // A chip handed to the explorer from somewhere else — a service page asking
  // for "this service's spans". The explorer applies it once and calls back, so
  // the same chip is not re-applied on every later render.
  const [incomingChip, setIncomingChip] = useState(null)

  const openTrace = useCallback((id) => {
    setTraceId(id)
    setSettingsOpen(false)
  }, [])

  // A record can point at a trace, a service or an infrastructure resource, and
  // only the router knows how to reach all three. The explorer does not: it
  // hands up a link and stays out of it. Trace links are the only kind this
  // example can service — wire the rest to your own routes.
  const openLink = useCallback((link) => {
    if (link?.view === 'traces') openTrace(link.traceId)
  }, [openTrace])

  if (traceId) {
    return (
      <TraceDetail
        // The key is load-bearing. A trace's collapsed rows, its selected span,
        // its active tab and its pane split are all component state, and
        // without a remount on trace id, opening a second trace inherits the
        // first one's — a span selection that belongs to a trace you left.
        key={traceId}
        traceId={traceId}
        goHome={goHome}
        goTraces={() => setTraceId('')}
        // Same trace, other dataset: hand the id to Logs as a filter rather
        // than as a search string, so it arrives as a chip and not as text.
        goLogs={(id) => { /* your logs route: filter trace_id = id */ void id }}
        timeRange={timeRange}
        setTimeRange={setTimeRange}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
      />
    )
  }

  return (
    <TracesView
      goHome={goHome}
      timeRange={timeRange}
      setTimeRange={setTimeRange}
      setToast={setToast}
      onOpenTrace={openTrace}
      onOpenLink={openLink}
      incomingChip={incomingChip}
      onIncomingChipApplied={() => setIncomingChip(null)}
    />
  )
}
