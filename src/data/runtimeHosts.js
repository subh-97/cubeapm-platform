// Which JVMs were running, and when.
//
// The Runtime tab's host rail draws one lifeline per host: the selected range
// from left to right, solid where that host's JVM was sending runtime data.
// That needs each host's history in absolute time, so it is written here as
// runs — one per JVM process — in minutes before BASE_TIME, the same unit
// INCIDENT_START_MIN uses, and clipped to whatever window is open.
//
// The story the four hosts tell is the same incident every other page samples:
//
//   2d 19h ago  a rolling deploy restarts the three original JVMs, one at a
//               time, three minutes apart. On the 3d and 7d views their notches
//               line up and read as a rollout rather than a cause.
//   -22m        payment-service's Redis pool starts failing.
//   -14m        on-call adds a fourth instance by hand on ip-10-0-130-150 (by
//               hand: observability.js reports no HPA for this service).
//   -10m        every request thread on ip-10-0-142-2 is parked on the pool,
//               /actuator/health times out, and its supervisor restarts the JVM.
//               It is back 1m 40s later.
//
// Neither action helped — the bottleneck is shared — and the per-host charts
// show exactly that: the new and the restarted JVMs climb straight back up.
//
// A real backend derives the same thing from `count by (host.name)` of any JVM
// metric at the window's step; a restart is a reset of the process start time.

import { formatLocal } from '@/utils/timeRange'

const H = 60
const D = 24 * H
// Ten minutes past the hour so the three redeployed JVMs all read "up 2d 19h":
// on the hour exactly, a window end floored a few seconds short of now reads
// one of them as 2d 18h.
export const DEPLOY_MIN = 2 * D + 19 * H + 10

/** Two runs closer than this are one JVM restarting, not a stop and a start. */
export const RESTART_GAP_SEC = 300

/** A host is drawn in a chart bucket only if it reported for at least half of it. */
export const DRAW_MIN = 0.5

/**
 * `fromMin: null` means reporting since before the demo has any history.
 * `toMin: null` means still reporting at BASE_TIME.
 *
 * `load` is relative load on that JVM; the three long-lived hosts average 1.0
 * and keep infraCorrelation's CPU order (92 / 89 / 87%). `seed` keys its jitter.
 * There is deliberately no health field: the rail shows when each host ran,
 * not how sick it is.
 */
export const RUNTIME_HOSTS = [
  {
    id: 'ip-10-0-142-133', name: 'ip-10-0-142-133', load: 1.04, seed: 11,
    runs: [
      { fromMin: null, toMin: DEPLOY_MIN + 1.25, stopReason: 'Rolling deploy' },
      { fromMin: DEPLOY_MIN, toMin: null, startReason: 'Rolling deploy' },
    ],
  },
  {
    id: 'ip-10-0-142-2', name: 'ip-10-0-142-2', load: 1.0, seed: 12,
    runs: [
      { fromMin: null, toMin: DEPLOY_MIN - 1.75, stopReason: 'Rolling deploy' },
      {
        fromMin: DEPLOY_MIN - 3, toMin: 10, startReason: 'Rolling deploy',
        stopReason: 'Failed 3 health checks (/actuator/health timed out)',
      },
      { fromMin: 25 / 3, toMin: null, startReason: 'Restarted by its supervisor' },
    ],
  },
  {
    id: 'ip-10-0-143-40', name: 'ip-10-0-143-40', load: 0.96, seed: 13,
    runs: [
      { fromMin: null, toMin: DEPLOY_MIN - 4.75, stopReason: 'Rolling deploy' },
      { fromMin: DEPLOY_MIN - 6, toMin: null, startReason: 'Rolling deploy' },
    ],
  },
  {
    id: 'ip-10-0-130-150', name: 'ip-10-0-130-150', load: 1.0, seed: 14,
    runs: [
      { fromMin: 14, toMin: null, startReason: 'Added by hand · 3 → 4 instances' },
    ],
  },
]

/** Runs as absolute seconds. `from` is -Infinity for a run older than the demo. */
export function livesOf(host, nowSec) {
  const at = m => nowSec - Math.round(m * 60)
  return host.runs.map(r => ({
    from: r.fromMin == null ? -Infinity : at(r.fromMin),
    to: r.toMin == null ? nowSec : at(r.toMin),
    running: r.toMin == null,
    startReason: r.startReason ?? null,
    stopReason: r.stopReason ?? null,
  }))
}

/** Seconds of [t0, t1] during which any of `lives` was reporting. */
export function reportedSec(lives, t0, t1) {
  return lives.reduce((s, l) => s + Math.max(0, Math.min(t1, l.to) - Math.max(t0, l.from)), 0)
}

/**
 * One host, clipped to one window.
 *
 * `pieces` cover [win.start, win.end] exactly, as fractions of it, in time
 * order: `run` where the JVM reported, `gap` where it did not, `future` for the
 * part of "Today" that has not happened. A run's end is `round` when the JVM
 * really started or stopped there and `flat` when the window cut it — or when
 * it is simply still running now.
 *
 * Coverage divides by ELAPSED time, so "Today" does not count its own future
 * as an outage.
 */
export function hostPresence(host, win) {
  const lives = livesOf(host, win.nowSec)
  const lo = win.start
  const end = win.end
  const hi = Math.min(end, win.nowSec)
  const span = Math.max(1, end - lo)
  const fx = t => (t - lo) / span

  // Classified on the unclipped runs, so a restart whose stop fell just before
  // the window still reads as a restart rather than a cold start.
  const events = []
  lives.forEach((l, k) => {
    const prev = lives[k - 1]
    if (prev && l.from - prev.to <= RESTART_GAP_SEC) {
      events.push({ type: 'restart', t: l.from, downAt: prev.to, downSec: l.from - prev.to, reason: prev.stopReason })
    } else {
      if (prev) events.push({ type: 'stop', t: prev.to, reason: prev.stopReason })
      if (Number.isFinite(l.from)) events.push({ type: 'start', t: l.from, reason: l.startReason })
    }
  })
  const last = lives[lives.length - 1]
  if (last && !last.running) events.push({ type: 'stop', t: last.to, reason: last.stopReason })
  const inWindow = events
    .filter(e => e.t >= lo && e.t <= hi)
    .map(e => ({ ...e, x: fx(e.t) }))
    .sort((a, b) => b.t - a.t)

  const pieces = []
  let cursor = lo
  const gap = (from, to, role) => {
    if (to > from) pieces.push({ kind: 'gap', role, x0: fx(from), x1: fx(to), restart: role === 'inner' && to - from <= RESTART_GAP_SEC })
  }
  for (const l of lives) {
    const from = Math.max(lo, l.from)
    const to = Math.min(hi, l.to)
    if (to <= from) continue
    gap(cursor, from, pieces.some(p => p.kind === 'run') ? 'inner' : 'lead')
    pieces.push({
      kind: 'run',
      x0: fx(from),
      x1: fx(to),
      capL: Number.isFinite(l.from) && l.from >= lo ? 'round' : 'flat',
      capR: !l.running && l.to <= hi ? 'round' : 'flat',
    })
    cursor = to
  }
  gap(cursor, hi, pieces.some(p => p.kind === 'run') ? 'tail' : 'empty')
  if (end > hi) pieces.push({ kind: 'future', x0: fx(hi), x1: 1 })

  const rep = reportedSec(lives, lo, hi)
  const pastSec = Math.max(0, hi - lo)
  const coverage = pastSec ? Math.min(1, rep / pastSec) : 0

  const bucketCoverage = win.buckets.map(b => {
    if (b.future) return null
    const t1 = Math.min(b.t + b.durMin * 60, win.nowSec)
    return t1 > b.t ? reportedSec(lives, b.t, t1) / (t1 - b.t) : null
  })

  const current = lives.find(l => l.from <= hi && hi <= l.to && (l.running || hi < l.to))
  const restartingAtEnd = events.some(e => e.type === 'restart' && e.downAt < hi && hi < e.t)

  return {
    id: host.id,
    name: host.name,
    present: rep > 0,
    pieces,
    events: inWindow,
    reportedSec: rep,
    pastSec,
    coverage,
    coverageText: coverageText(coverage),
    restartingAtEnd,
    // A run still going on a trailing range is timed to NOW, not to the range's
    // end: a day-long range ends on a 15-minute step, up to 15 minutes short of
    // now, and "up 2d 18h" on 24h beside "up 2d 19h" on 1h is one JVM described
    // two ways.
    uptimeAtEndSec: current && Number.isFinite(current.from)
      ? (current.running && win.trailing ? win.nowSec : hi) - current.from
      : null,
    firstEverSec: lives[0]?.from ?? Infinity,
    lastEverSec: last?.to ?? -Infinity,
    bucketCoverage,
    lives,
  }
}

// A host with any gap must never read 100%, and a 14-minute host on a 7-day
// window must never read 0%.
function coverageText(c) {
  if (c >= 1) return '100%'
  if (c >= 0.995) return '>99%'
  if (c > 0 && c < 0.005) return '<1%'
  return `${Math.round(c * 100)}%`
}

/** `1m 40s`, `58m`, `14h 20m`, `2d 19h` — two units, seconds only under ten minutes. */
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 10) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

// `8m ago` in the rail's own shorthand. Past an hour it uses the same two units
// as "up 2d 19h", so one deploy is not "up 2d 19h" on a short range and
// "restarted 3d ago" on a long one.
function agoShort(sec) {
  if (sec < 45) return 'just now'
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  return `${fmtDur(sec)} ago`
}

const VERB = { restart: 'restarted', start: 'started', stop: 'stopped' }

/**
 * The short note on the right of a row: the newest thing that happened to this
 * host in the window, or how long its JVM has been up.
 *
 * On a trailing range "ago" is measured from now, so the same restart reads the
 * same on every range that contains it. A past window names a clock time
 * rather than an "ago" that would be a lie.
 */
export function hostNote(p, win) {
  if (!p.present) return { text: 'no data', isEvent: false }
  // Down mid-restart at the range's end is newer than anything in it.
  if (p.restartingAtEnd) return { text: 'restarting', isEvent: true }
  const e = p.events[0]
  // A start more than a day back that began the run still going is the same
  // fact as the uptime, in half the width — the notch and the hover card still
  // say it was a restart.
  const stale = e && e.type !== 'stop' && win.trailing && win.nowSec - e.t >= 86400 && p.uptimeAtEndSec != null
  if (e && !stale) {
    const when = win.trailing
      ? agoShort(win.nowSec - e.t)
      : formatLocal(e.t * 1000, win.crossesDay ? 'MMM DD' : 'HH:mm')
    return { text: `${VERB[e.type]} ${when}`, isEvent: true }
  }
  if (p.uptimeAtEndSec != null) return { text: `up ${fmtDur(p.uptimeAtEndSec)}`, isEvent: false }
  return { text: '', isEvent: false }
}

// 10.0.142.2 before 10.0.142.133: compared as numbers, not strings.
const ipKey = id => (id.match(/\d+/g) || []).map(Number)
function byIp(a, b) {
  const x = ipKey(a.id), y = ipKey(b.id)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  }
  return 0
}

/**
 * The rail's rows for one window.
 *
 * Hosts are ordered by when they first appeared, then by address — never by
 * severity. CLAUDE.md's severity-first rule governs service lists; this one
 * deliberately carries no health, and first-seen order gives a stable staircase
 * that reads as the fleet's history.
 *
 * A selected host that sent nothing in this window is kept as a trailing
 * "ghost" row rather than silently dropped, so changing the range never
 * changes what the charts are scoped to behind the reader's back.
 */
export function runtimeRoster(win, selectedId) {
  const all = RUNTIME_HOSTS.map(h => hostPresence(h, win))
  const present = all
    .filter(p => p.present)
    .sort((a, b) => (a.firstEverSec - b.firstEverSec) || byIp(a, b))
  const ghost = all.find(p => p.id === selectedId && !p.present)

  // How many hosts the "All hosts" line actually averaged, bucket by bucket.
  const drawnCounts = win.buckets
    .map((b, i) => (b.future ? null : present.filter(p => (p.bucketCoverage[i] ?? 0) >= DRAW_MIN).length))
    .filter(n => n != null)

  const hosts = [...present, ...(ghost ? [{ ...ghost, ghost: true }] : [])]
    .map(p => ({ ...p, note: hostNote(p, win) }))

  return {
    hosts,
    count: present.length,
    drawnMin: drawnCounts.length ? Math.min(...drawnCounts) : 0,
    drawnMax: drawnCounts.length ? Math.max(...drawnCounts) : 0,
  }
}
