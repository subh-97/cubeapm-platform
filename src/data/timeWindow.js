// How a time range turns into data.
//
// The mock layer used to be a pile of 60-point arrays, each one a fixed hour of
// one-minute buckets. That makes the time picker a lie: changing it could only
// ever slice the same hour, so "Last 7 days" and "Last 5 minutes" drew the same
// chart with a different label. This module is the other half of the time
// model — `utils/timeRange` says what window you asked for, this says what was
// happening during it.
//
// Three ideas carry the whole thing:
//
//   1. ONE INCIDENT, ONE PROFILE. Everything on the platform is anchored to the
//      same event: payment-service's Redis pool starts failing 22 minutes
//      before now and is still failing. Every series, every window aggregate
//      and every log level mix samples that one profile, which is what makes
//      two different windows disagree in the way they should rather than in a
//      way that has to be hand-maintained per chart.
//
//   2. THE ONE-HOUR WINDOW IS THE CALIBRATION POINT. The numbers written down
//      in `services.js` (452.7 rpm, 612 ms, 4.8%) are what the product has
//      always shown, and they are what the default range must keep showing. So
//      a profile is not written as "baseline and peak" — it is written as
//      "baseline, and whatever peak makes the last hour average out to the
//      published figure". `calibratePeak` solves for that. Change the range and
//      the number moves; come back to Last 1 hour and it is 612 ms again.
//
//   3. AGGREGATES ARE AGGREGATES, NOT SAMPLES. A rate averages over the window.
//      A percentile is taken over the window's requests, weighted by how many
//      arrived in each bucket. That difference is the whole demonstration: a
//      22-minute incident is 37% of an hour, so p90 sits in the slow tail and
//      reads 612 ms — but it is 0.2% of a week, so the same p90 reads 140 ms
//      and you have to zoom in to find the fire. Error rate, being a mean,
//      fades smoothly instead; latency falls off a cliff. Both are true.
//
// Everything is anchored on BASE_TIME, the same anchor the log and span
// streams already use, so a window's charts and its rows agree about when the
// incident was.

import { resolveRange, rangeLabel, formatLocal } from '@/utils/timeRange'

/**
 * The demo's "now". Every row, every series and every window in the mock layer
 * is written relative to this instant, so it is fixed once at load rather than
 * read from the clock on each render — otherwise the incident would drift a
 * minute further into the past every minute a session stayed open, and a chart
 * drawn twice would not agree with itself.
 *
 * It lives here, with the time model, and `data/observability` re-exports it
 * for the modules that have always imported it from there.
 */
export const BASE_TIME = new Date()

/** The incident sits 22 minutes back and has not resolved. */
export const INCIDENT_START_MIN = 22
/** It took four minutes to go from healthy to fully broken. */
export const INCIDENT_RAMP_MIN = 4

/** Charts aim for this many buckets; the step ladder below gets them close. */
const CHART_BUCKETS = 60

// Steps a human reads without doing arithmetic. A bucket of 2.75 hours is
// arithmetically ideal for a 7-day window and unreadable on an axis.
const STEP_LADDER = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]

const MIN = 60
const niceStep = (sec) => STEP_LADDER.find(s => s >= sec) ?? STEP_LADDER[STEP_LADDER.length - 1]

/**
 * Deterministic noise in [0, 1) from two integers. Keyed on the bucket's start
 * second rather than its index, so two windows that overlap draw the same
 * wobble over the minutes they share instead of each inventing their own.
 */
export function noiseAt(seed, t) {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(t | 0, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 1 at the incident's peak, 0 before it began, ramping over four minutes. */
export function incidentWeight(minutesAgo) {
  if (minutesAgo > INCIDENT_START_MIN || minutesAgo < 0) return 0
  return Math.min(1, (INCIDENT_START_MIN - minutesAgo) / INCIDENT_RAMP_MIN)
}

// Area under `incidentWeight` from now back to `minutesAgo` — the ramp makes it
// piecewise linear, so it integrates in closed form.
function incidentIntegral(minutesAgo) {
  const plateau = INCIDENT_START_MIN - INCIDENT_RAMP_MIN
  if (minutesAgo <= 0) return 0
  if (minutesAgo <= plateau) return minutesAgo
  if (minutesAgo >= INCIDENT_START_MIN) return plateau + INCIDENT_RAMP_MIN / 2
  const x = minutesAgo - plateau
  return plateau + x - (x * x) / (2 * INCIDENT_RAMP_MIN)
}

/**
 * How much of a BUCKET the incident occupied, rather than how bad things were
 * at the instant the bucket opened.
 *
 * This matters more than it sounds. Sampling at the bucket's edge quantises a
 * 22-minute incident to a whole number of buckets, so at a five-minute step it
 * reads as 15 minutes and at a three-hour step it vanishes entirely — and
 * because p90 is a percentile, losing two points of share flips it from 612 ms
 * to 143 ms with nothing in between. Averaging across the bucket makes the
 * incident's share fall off smoothly as the window widens, which is the whole
 * behaviour the range picker is meant to show.
 */
export function incidentWeightOver(minutesAgo, spanMin) {
  if (!(spanMin > 0)) return incidentWeight(minutesAgo)
  const newest = Math.max(0, minutesAgo - spanMin)
  const oldest = Math.max(0, minutesAgo)
  if (oldest <= newest) return 0
  return (incidentIntegral(oldest) - incidentIntegral(newest)) / (oldest - newest)
}

// Traffic breathes over the day: busiest mid-afternoon, quietest before dawn.
// Without it every window longer than the incident would be a flat line, and
// "Last 7 days" would have nothing to show but seven days of the same number.
function dailyWave(ms) {
  const d = new Date(ms)
  const hour = d.getHours() + d.getMinutes() / 60
  return 1 + 0.38 * Math.sin(((hour - 10) / 24) * 2 * Math.PI)
}

/**
 * A window: the bounds a query ran over, and the buckets a chart draws.
 *
 * Resolved against BASE_TIME rather than the wall clock, because every row and
 * every series in the mock layer is written relative to BASE_TIME — resolving
 * against a drifting `Date.now()` would walk the incident off the axis over the
 * life of a session.
 */
export function resolveWindow(range, nowMs = BASE_TIME.getTime()) {
  const r = resolveRange(range, nowMs, 15)
  const step = Math.max(r.step, niceStep(Math.max(1, Math.round(r.span / CHART_BUCKETS))))

  // The START is floored to the chart step, in local time, the same way
  // `resolveRange` floors to the query step — so the first bucket of "Today" is
  // midnight rather than whatever falls a whole number of steps back from the
  // last one.
  //
  // The END is NOT. Flooring it too would be the obvious symmetry and it is
  // wrong: at a three-hour step it throws away up to three hours, which on a
  // seven-day window is the whole incident — the range would end before the
  // thing you opened it to look at. So the window runs to the end the range
  // actually asked for, and the last bucket is however much of a step is left.
  const off = -new Date(nowMs).getTimezoneOffset()
  const floorTo = t => t - ((((t - off * MIN) % step) + step) % step)
  const begin = floorTo(r.start)
  const end = Math.max(begin + 1, r.end)
  const nowSec = Math.floor(nowMs / 1000)
  const spanSec = end - begin
  const stepMin = step / MIN

  // A trailing window runs up to now, which is the only case where "-14m" says
  // anything: on a window that ended last Tuesday, every relative label is a
  // lie about how long ago it was.
  const trailing = nowSec - end < step
  const crossesDay = new Date(begin * 1000).toDateString()
    !== new Date(Math.max(begin, end - step) * 1000).toDateString()
  const withDate = !trailing || crossesDay
  // Relative labels only where they are also unique: rounded to the minute,
  // they collide the moment a bucket is shorter than one.
  const relative = trailing && step >= MIN && spanSec <= 3600
  const clockFmt = `${withDate ? 'MMM DD ' : ''}HH:mm${step < MIN ? ':ss' : ''}`

  const buckets = []
  for (let i = 0, t = begin; t < end; i++, t += step) {
    const ms = t * 1000
    // Minutes before NOW, not before the window's end — the incident sits at a
    // fixed instant, so a window that stops short of now has to see it that
    // many minutes further back, or every past window would report the outage
    // as happening during it.
    const minutesAgo = (nowSec - t) / MIN
    // Every bucket is a whole step except the last, which is whatever is left.
    const durMin = Math.min(step, end - t) / MIN
    const clock = formatLocal(ms, clockFmt)
    // A clock label names when the bucket OPENED, which is the convention every
    // time-series axis uses. A relative one names when it CLOSED, because the
    // thing a reader is locating is the right-hand edge: the newest bucket of a
    // trailing window is "now", not "-1m".
    const agoMin = minutesAgo - durMin
    buckets.push({
      i,
      t,
      ms,
      m: minutesAgo,
      durMin,
      // The incident's share of THIS bucket, not its value at the bucket's
      // edge — see `incidentWeightOver`.
      w: incidentWeightOver(minutesAgo, durMin),
      // "Today" runs to midnight, so part of it has not happened. Marked rather
      // than dropped: the axis still shows the rest of the day, it just has
      // nothing to draw in it.
      future: t >= nowSec,
      label: relative ? (agoMin < 1 ? 'now' : `-${Math.round(agoMin)}m`) : clock,
      exactTime: clock,
    })
  }

  const pastBuckets = buckets.filter(b => !b.future)
  return {
    start: begin, end, step, stepMin, spanSec,
    spanMin: spanSec / MIN,
    buckets,
    // Buckets that have actually happened — what every aggregate divides by.
    pastBuckets,
    // Minutes of the window that have actually happened. Not
    // `pastBuckets.length * stepMin`: the last bucket is usually short.
    pastMinutes: pastBuckets.reduce((a, b) => a + b.durMin, 0),
    nowSec,
    label: rangeLabel(range),
    isAbsolute: range?.kind === 'absolute',
  }
}

/** The reference window every published figure was measured over. */
export const REFERENCE_WINDOW = resolveWindow({ kind: 'preset', value: '1h' })

/** Which bucket a timestamp falls in, or -1 when it is outside the window. */
export function bucketIndexOf(win, ms) {
  const t = Math.floor(ms / 1000)
  if (t < win.start || t >= win.end) return -1
  return Math.min(win.buckets.length - 1, Math.floor((t - win.start) / win.step))
}

// The incident's average weight across a window — 0.34 over the last hour,
// 0.0014 over the last week. Every calibration and every dilution comes from
// this one number.
function incidentMean(win) {
  const bs = win.pastBuckets
  if (bs.length === 0) return 0
  let sum = 0, dur = 0
  for (const b of bs) { sum += (b.w ?? incidentWeight(b.m)) * b.durMin; dur += b.durMin }
  return dur > 0 ? sum / dur : 0
}

// The daily wave is normalised against the reference hour, so a published
// figure comes out the same whether the demo is opened at 3pm or at 3am, and
// the wave still bends every window wider than an hour.
const WAVE_REFERENCE = (() => {
  let sum = 0
  for (const b of REFERENCE_WINDOW.buckets) sum += dailyWave(b.ms)
  return sum / REFERENCE_WINDOW.buckets.length
})()

const REFERENCE_INCIDENT_MEAN = incidentMean(REFERENCE_WINDOW)

/**
 * The peak multiplier that makes a profile average out to `target` over the
 * reference hour. This is the inverse of the sampling below: a metric whose
 * baseline is 0.05% and which must read 4.8% over the last hour was running at
 * 14% while the incident was live.
 *
 * Returns 1 for a profile with no incident, or one already at its target.
 */
export function calibratePeak(baseline, target, win = REFERENCE_WINDOW) {
  const w = win === REFERENCE_WINDOW ? REFERENCE_INCIDENT_MEAN : incidentMean(win)
  if (!(baseline > 0) || !(w > 0)) return 1
  return 1 + (target / baseline - 1) / w
}

/**
 * A metric profile.
 *
 * @typedef {object} Profile
 * @property {number} baseline   value when nothing is wrong
 * @property {number} [peak]     multiplier at the incident's worst (1 = unaffected)
 * @property {number} [target]   value this must average to over the last hour;
 *                               `peak` is solved for when this is given
 * @property {number} [noise]    peak-to-peak jitter as a fraction of the value
 * @property {number} [seed]     which jitter
 * @property {boolean} [diurnal] whether the daily traffic wave applies
 * @property {number} [floor]    clamp (an apdex cannot exceed 1)
 * @property {number} [ceil]
 */

function peakOf(p) {
  if (p.peak != null) return p.peak
  if (p.target != null) return calibratePeak(p.baseline, p.target)
  return 1
}

/** The profile's value at one bucket, incident and wave and jitter included. */
export function sampleAt(profile, bucket, peak = peakOf(profile)) {
  const w = bucket.w ?? incidentWeight(bucket.m)
  let v = profile.baseline * (1 + (peak - 1) * w)
  if (profile.diurnal) v *= dailyWave(bucket.ms) / WAVE_REFERENCE
  if (profile.noise) v *= 1 + (noiseAt(profile.seed ?? 1, bucket.t) - 0.5) * profile.noise
  if (profile.floor != null) v = Math.max(profile.floor, v)
  if (profile.ceil != null) v = Math.min(profile.ceil, v)
  return v
}

/**
 * The profile sampled across a window, in the shape every chart on the platform
 * already reads: `{ m, value }` plus the axis label and tooltip time, so a
 * series drawn over seven days labels itself as seven days without each chart
 * learning how.
 */
export function windowSeries(win, profile, { round = 2 } = {}) {
  const peak = peakOf(profile)
  const f = 10 ** round
  return win.buckets.map(b => ({
    m: b.m,
    t: b.t,
    label: b.label,
    exactTime: b.exactTime,
    // null, not 0: a line should stop at now, not dive to the axis and draw the
    // rest of the day as an outage.
    value: b.future ? null : Math.round(sampleAt(profile, b, peak) * f) / f,
  }))
}

/** The window's mean of a profile — what a rate or an average reads as. */
export function windowMean(win, profile) {
  const bs = win.pastBuckets
  if (bs.length === 0) return profile.baseline
  const peak = peakOf(profile)
  // Weighted by how long each bucket actually covers, because the last one is
  // usually a fraction of a step and must not count as a whole one.
  let sum = 0, dur = 0
  for (const b of bs) { sum += sampleAt(profile, b, peak) * b.durMin; dur += b.durMin }
  return dur > 0 ? sum / dur : profile.baseline
}

/**
 * A percentile over the window's REQUESTS, not over its buckets.
 *
 * This is the one aggregate that cannot be an average, and the reason the time
 * picker is worth wiring up at all. Each bucket contributes as many requests as
 * it served, so the question "how slow were the slowest 10% of requests this
 * window" has a different answer depending on whether the incident was 37% of
 * the window or 0.2% of it — a cliff, not a fade.
 */
export function windowQuantile(win, profile, q, weightProfile) {
  const bs = win.pastBuckets
  if (bs.length === 0) return profile.baseline
  const peak = peakOf(profile)
  const wPeak = weightProfile ? peakOf(weightProfile) : null
  // A bucket's weight is the requests it served: its rate times its duration.
  const points = bs.map(b => ({
    v: sampleAt(profile, b, peak),
    w: b.durMin * (weightProfile ? Math.max(0, sampleAt(weightProfile, b, wPeak)) : 1),
  }))
  points.sort((a, b) => a.v - b.v)
  const total = points.reduce((a, p) => a + p.w, 0)
  if (!(total > 0)) return points[points.length - 1]?.v ?? profile.baseline
  let acc = 0
  for (const p of points) {
    acc += p.w
    if (acc >= total * q) return p.v
  }
  return points[points.length - 1].v
}

/**
 * Pins a profile so that `aggregate(REFERENCE_WINDOW, profile)` comes out at
 * exactly `target`.
 *
 * `calibratePeak` gets the shape right but works on the noiseless profile, and
 * a percentile does not have a closed form at all — so the last step is simply
 * to measure and scale. Every term in `sampleAt` is multiplicative, which makes
 * the aggregate linear in the baseline and the correction exact in one pass.
 * The baseline moves by a fraction of a percent; what it buys is that Last 1
 * hour still reads 612 ms and 4.8%, to the digit, as it always has.
 *
 * Profiles with a clamp are left alone — a clamp is the one term that is not
 * linear, and the only clamped metric here (apdex) has no published figure to
 * hit anyway.
 */
export function pinToReference(profile, aggregate, target) {
  if (!(target > 0) || profile.floor != null || profile.ceil != null) return profile
  const measured = aggregate(REFERENCE_WINDOW, profile)
  if (!(measured > 0)) return profile
  return { ...profile, baseline: profile.baseline * (target / measured) }
}

/**
 * How many of something the window holds, given a per-minute rate profile.
 * Used for log and span counts, where the chart's bars are volumes rather than
 * levels: a bar covers `stepMin` minutes, so it stacks that many minutes' worth.
 */
export function windowCount(win, profile) {
  return windowMean(win, profile) * win.pastMinutes
}

/**
 * `n` timestamps spread across the window, newest first.
 *
 * Rows are a SAMPLE, not the stream — a week of logs is tens of millions of
 * records and nobody is scrolling them. Spreading the sample across the window
 * rather than taking the newest n is the deliberate choice: the newest n of a
 * week all land in the last hour, which would make a seven-day search look
 * exactly like a one-hour one.
 */
export function spreadTimes(win, n) {
  if (n <= 0) return []
  const startMs = win.start * 1000
  // Never past now: a window that runs to midnight has not collected the rest
  // of the day's records yet.
  const spanMs = Math.max(0, Math.min(win.end, win.nowSec) * 1000 - startMs)
  const gap = spanMs / n
  return Array.from({ length: n }, (_, i) => {
    const slot = n - 1 - i
    const jitter = noiseAt(9173, win.start + slot) * gap * 0.8
    return startMs + slot * gap + jitter
  })
}

/**
 * How many sampled rows a window is worth. Tied to the span so a wider search
 * does return more, and capped so the table stays a table.
 */
export function sampleCount(win, perMinute, { min = 24, max = 300 } = {}) {
  return Math.max(min, Math.min(max, Math.round(win.pastMinutes * perMinute)))
}

/** 'Last 1 hour · 60 buckets · 1m' — the hint every chart header carries. */
export function windowHint(win) {
  const step = win.step >= 86400 ? `${win.step / 86400}d`
    : win.step >= 3600 ? `${win.step / 3600}h`
      : win.step >= 60 ? `${win.step / 60}m` : `${win.step}s`
  return `${win.label} · ${win.buckets.length} buckets · ${step}`
}
