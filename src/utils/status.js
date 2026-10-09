export const STATUS = {
  healthy: 'healthy',
  warning: 'warning',
  critical: 'critical',
  info: 'info',
  neutral: 'neutral',
}

export const STATUS_COLORS = {
  healthy: '#22C55E',
  warning: '#F59E0B',
  critical: '#EF4444',
  info: '#60A5FA',
  neutral: '#616C86',
}

export const STATUS_LABELS = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  info: 'Info',
  neutral: 'No Data',
}

const THRESHOLDS = {
  latencyP90Ms: { warn: 150, critical: 300 },
  errorRatePct: { warn: 1, critical: 3 },
}

export function statusForLatency(ms) {
  if (ms == null) return STATUS.neutral
  if (ms >= THRESHOLDS.latencyP90Ms.critical) return STATUS.critical
  if (ms >= THRESHOLDS.latencyP90Ms.warn) return STATUS.warning
  return STATUS.healthy
}

export function statusForErrorRate(pct) {
  if (pct == null) return STATUS.neutral
  if (pct >= THRESHOLDS.errorRatePct.critical) return STATUS.critical
  if (pct >= THRESHOLDS.errorRatePct.warn) return STATUS.warning
  return STATUS.healthy
}

// Log severity maps onto the shared status scale, so a level badge is coloured
// by the same resolver as every other severity signal rather than by a palette
// of its own. `info` is the informational blue, not healthy green — an info log
// says nothing about health.
export function statusForLogLevel(level) {
  if (level === 'error') return STATUS.critical
  if (level === 'warn') return STATUS.warning
  if (level === 'info') return STATUS.info
  return STATUS.neutral
}

// An HTTP response code on the same scale, for records whose status_code is the
// code itself rather than OTel's ERROR/UNSET — a mobile request reports what the
// server answered. 0 is not a code at all: the request never got an answer
// (timed out, no connection), which for the person holding the phone is as
// broken as a 5xx. A 4xx is the client's own fault, worth seeing but not paging
// on. UNSET is a record that never set a status, which means nothing went wrong
// — the same reading statusForSpan gives it. Anything else, a blank included,
// says nothing about health and stays neutral.
export function statusForHttpStatus(code) {
  if (code == null) return STATUS.neutral
  const s = String(code).trim()
  if (s === 'UNSET') return STATUS.healthy
  if (!/^\d+$/.test(s)) return STATUS.neutral
  const n = Number(s)
  if (n === 0 || (n >= 500 && n <= 599)) return STATUS.critical
  if (n >= 400 && n <= 499) return STATUS.warning
  if (n >= 100 && n <= 399) return STATUS.healthy
  return STATUS.neutral
}

export function worstStatus(...statuses) {
  const order = [STATUS.critical, STATUS.warning, STATUS.healthy, STATUS.info, STATUS.neutral]
  for (const s of order) {
    if (statuses.includes(s)) return s
  }
  return STATUS.neutral
}

export function statusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.neutral
}
