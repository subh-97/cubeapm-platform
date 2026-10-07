// What the Runtime tab's host rail and its per-host charts promise.
//
// "All hosts" is the calibrated series, untouched; a host is that series with
// a factor, and the hosts average back to it. If either drifts, the default
// view and the rows beside it stop agreeing about the same JVMs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_TIME, resolveWindow } from './timeWindow.js'
import { runtimeMetricsForWindow } from './services.js'
import { RUNTIME_HOSTS, hostPresence, runtimeRoster, hostNote, fmtDur, DRAW_MIN, DEPLOY_MIN } from './runtimeHosts.js'

// A range's end is floored to its query step — 15 minutes once it spans a day —
// so against the real clock a week-long range can stop up to 15 minutes short
// of now, and "restarted 8m ago" can legitimately fall outside it. Pinning now
// to a 15-minute boundary in local time makes every range end exactly at now,
// so the story reads the same on every run.
const OFF_SEC = -new Date(BASE_TIME).getTimezoneOffset() * 60
const nowSec = Math.floor(BASE_TIME.getTime() / 1000)
const nowMs = (nowSec - ((nowSec - OFF_SEC) % 900)) * 1000
const preset = v => resolveWindow({ kind: 'preset', value: v }, nowMs)
const WINDOWS = ['5m', '15m', '1h', '24h', '7d', 'today'].map(v => [v, preset(v)])
WINDOWS.push(['past hour, 3 days ago', resolveWindow({ kind: 'absolute', from: nowMs - (3 * 24 * 60 + 60) * 60000, to: nowMs - 3 * 24 * 60 * 60000 }, nowMs)])

// Every leaf as [path, rows].
function leaves(node, path = []) {
  if (Array.isArray(node)) return [[path.join('.'), node]]
  return Object.entries(node).flatMap(([k, v]) => leaves(v, [...path, k]))
}
const at = (tree, path) => path.split('.').reduce((n, k) => n[k], tree)

test('no host, an unknown host and null are all the same fleet series', () => {
  for (const [, win] of WINDOWS) {
    const fleet = runtimeMetricsForWindow(win)
    assert.deepEqual(runtimeMetricsForWindow(win, null), fleet)
    assert.deepEqual(runtimeMetricsForWindow(win, 'not-a-host'), fleet)
  }
})

test('per-host rows keep every key but value', () => {
  const win = preset('1h')
  const fleet = runtimeMetricsForWindow(win)
  const one = runtimeMetricsForWindow(win, 'ip-10-0-142-2')
  for (const [path, rows] of leaves(fleet)) {
    at(one, path).forEach((r, i) => {
      const { value: _a, ...rest } = r
      const { value: _b, ...want } = rows[i]
      assert.deepEqual(rest, want, `${path}[${i}]`)
    })
  }
})

test('the drawn hosts average back to the fleet value in every bucket', () => {
  for (const [name, win] of WINDOWS) {
    const fleet = runtimeMetricsForWindow(win)
    const per = RUNTIME_HOSTS.map(h => runtimeMetricsForWindow(win, h.id))
    for (const [path, rows] of leaves(fleet)) {
      const wholeNumbers = rows.every(r => r.value == null || Number.isInteger(r.value))
      rows.forEach((r, i) => {
        if (r.value == null) return
        const vals = per.map(t => at(t, path)[i].value).filter(v => v != null)
        if (!vals.length) return
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length
        // Each host is rounded to the leaf's own precision, so the mean can sit
        // up to half a unit off: half a thread, half a byte, half a hundredth.
        const tol = (wholeNumbers ? 0.5 : 0.005) + 1e-9 + Math.abs(r.value) * 1e-9
        assert.ok(Math.abs(mean - r.value) <= tol, `${name} ${path}[${i}]: mean ${mean} vs fleet ${r.value}`)
      })
    }
  }
})

test('a host is null exactly where it was not reporting', () => {
  for (const [name, win] of WINDOWS) {
    for (const h of RUNTIME_HOSTS) {
      const cov = hostPresence(h, win).bucketCoverage
      const cpu = runtimeMetricsForWindow(win, h.id).cpuPct
      cpu.forEach((r, i) => {
        const drawn = cov[i] != null && cov[i] >= DRAW_MIN
        assert.equal(r.value != null, drawn, `${name} ${h.id}[${i}] coverage ${cov[i]}`)
      })
    }
  }
})

test('no JVM ever holds more than it has taken, or takes more than its limit', () => {
  for (const [name, win] of WINDOWS) {
    for (const h of RUNTIME_HOSTS) {
      const rt = runtimeMetricsForWindow(win, h.id)
      for (const pool of ['heap', 'g1OldGenHeap', 'g1EdenHeap', 'g1SurvivorHeap']) {
        const { used, committed, limit } = rt[pool]
        used.forEach((u, i) => {
          if (u.value == null) return
          assert.ok(u.value <= committed[i].value, `${name} ${h.id} ${pool}[${i}] used > committed`)
          if (limit) assert.ok(committed[i].value <= limit[i].value, `${name} ${h.id} ${pool}[${i}] committed > limit`)
        })
      }
      rt.heap.used.forEach((r, i) => {
        if (r.value == null) return
        const sum = rt.g1OldGenHeap.used[i].value + rt.g1EdenHeap.used[i].value + rt.g1SurvivorHeap.used[i].value
        assert.equal(r.value, Math.round(sum), `${name} ${h.id} heap.used[${i}] is its generations`)
      })
    }
  }
})

test('the last hour tells the story: a restart, a late host, four hosts', () => {
  const win = preset('1h')
  const roster = runtimeRoster(win, null)
  assert.equal(roster.count, 4)
  assert.deepEqual(roster.hosts.map(h => h.id), ['ip-10-0-142-2', 'ip-10-0-142-133', 'ip-10-0-143-40', 'ip-10-0-130-150'])

  const restarted = roster.hosts.find(h => h.id === 'ip-10-0-142-2')
  const restarts = restarted.events.filter(e => e.type === 'restart')
  assert.equal(restarts.length, 1)
  assert.equal(restarts[0].downSec, 100)
  assert.equal(restarted.note.text, 'restarted 8m ago')
  assert.ok(restarted.coverage < 1 && restarted.coverageText !== '100%')

  const late = roster.hosts.find(h => h.id === 'ip-10-0-130-150')
  assert.ok(Math.abs(late.coverage - 14 / 60) < 0.02, `coverage ${late.coverage}`)
  assert.equal(late.note.text, 'started 14m ago')
  assert.equal(late.pieces[0].kind, 'gap')
  assert.equal(late.pieces[1].capL, 'round')

  const steady = roster.hosts.find(h => h.id === 'ip-10-0-142-133')
  assert.equal(steady.coverage, 1)
  assert.equal(steady.note.text, 'up 2d 19h')
})

test('pieces cover the whole window, and Today does not count its future as absence', () => {
  for (const [name, win] of WINDOWS) {
    for (const h of RUNTIME_HOSTS) {
      const p = hostPresence(h, win)
      assert.ok(p.coverage >= 0 && p.coverage <= 1, `${name} ${h.id}`)
      if (!p.pieces.length) continue
      assert.ok(Math.abs(p.pieces[0].x0) < 1e-9, `${name} ${h.id} starts at 0`)
      assert.ok(Math.abs(p.pieces[p.pieces.length - 1].x1 - 1) < 1e-9, `${name} ${h.id} ends at 1`)
      for (let i = 1; i < p.pieces.length; i++) {
        assert.ok(Math.abs(p.pieces[i].x0 - p.pieces[i - 1].x1) < 1e-9, `${name} ${h.id} contiguous`)
      }
    }
  }
  const today = preset('today')
  assert.equal(hostPresence(RUNTIME_HOSTS[0], today).coverage, 1)
})

test('a past hour before the extra host existed lists three hosts and no events', () => {
  const [, win] = WINDOWS.find(([n]) => n.startsWith('past'))
  const roster = runtimeRoster(win, null)
  assert.equal(roster.count, 3)
  assert.ok(roster.hosts.every(h => h.events.length === 0))
  assert.ok(!roster.hosts.some(h => h.id === 'ip-10-0-130-150'))

  // Selected, it stays listed as a ghost instead of vanishing.
  const kept = runtimeRoster(win, 'ip-10-0-130-150')
  const ghost = kept.hosts[kept.hosts.length - 1]
  assert.equal(ghost.id, 'ip-10-0-130-150')
  assert.equal(ghost.ghost, true)
  assert.equal(hostNote(ghost, win).text, 'no data')
})

test('the rolling deploy reads as three restarts, 75 seconds each', () => {
  const win = resolveWindow({ kind: 'absolute', from: nowMs - (DEPLOY_MIN + 5) * 60000, to: nowMs - (DEPLOY_MIN - 10) * 60000 }, nowMs)
  const restarts = RUNTIME_HOSTS
    .map(h => hostPresence(h, win))
    .flatMap(p => p.events.filter(e => e.type === 'restart'))
  assert.equal(restarts.length, 3)
  restarts.forEach(e => assert.equal(e.downSec, 75))
})

test('a week-long range names recent events and turns old restarts into uptime', () => {
  const notes = Object.fromEntries(runtimeRoster(preset('7d'), null).hosts.map(h => [h.id, h.note.text]))
  assert.equal(notes['ip-10-0-142-2'], 'restarted 8m ago')
  assert.equal(notes['ip-10-0-142-133'], 'up 2d 19h')
  assert.equal(notes['ip-10-0-130-150'], 'started 14m ago')
})

test('a range that ends short of now still times its notes from now', () => {
  // Five minutes past a quarter hour: 24h and 7d end five minutes ago, 1h a
  // few seconds ago. The same JVMs must be described the same way on all three.
  const lagged = nowMs + 5 * 60000
  const notes = v => Object.fromEntries(
    runtimeRoster(resolveWindow({ kind: 'preset', value: v }, lagged), null).hosts.map(h => [h.id, h.note.text]),
  )
  const hour = notes('1h')
  assert.equal(hour['ip-10-0-142-2'], 'restarted 8m ago')
  assert.equal(hour['ip-10-0-130-150'], 'started 14m ago')
  for (const v of ['24h', '7d']) {
    const n = notes(v)
    assert.equal(n['ip-10-0-142-2'], hour['ip-10-0-142-2'], v)
    assert.equal(n['ip-10-0-130-150'], hour['ip-10-0-130-150'], v)
    assert.equal(n['ip-10-0-142-133'], 'up 2d 19h', v)
    assert.equal(n['ip-10-0-143-40'], 'up 2d 19h', v)
  }
})

test('a range ending mid-restart says restarting, not an older event', () => {
  // ip-10-0-142-2 went down 10m before now and came back at 8m20s. With now 9
  // minutes past a quarter hour, a week-long range ends on that quarter hour —
  // inside the outage — and still contains the deploy two days back.
  const now = nowMs + 9 * 60000
  const win = resolveWindow({ kind: 'absolute', from: nowMs - 7 * 24 * 3600000, to: nowMs }, now)
  const p = runtimeRoster(win, null).hosts.find(h => h.id === 'ip-10-0-142-2')
  assert.equal(p.restartingAtEnd, true)
  assert.equal(p.note.text, 'restarting')
})

test('durations read in two units', () => {
  assert.equal(fmtDur(100), '1m 40s')
  assert.equal(fmtDur(58 * 60), '58m')
  assert.equal(fmtDur(14 * 3600 + 20 * 60), '14h 20m')
  assert.equal(fmtDur((2 * 24 + 19) * 3600), '2d 19h')
})
