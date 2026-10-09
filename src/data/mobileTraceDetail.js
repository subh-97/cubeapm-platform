/**
 * A mobile trace, assembled for the inspect view.
 *
 * What a phone reports under a trace id is one HTTP request it made (or, for a
 * first launch, the install record), so a mobile trace is a trace of one span —
 * which is what production's inspect view shows for `?datasource=mobile`. The
 * span is rebuilt from the id alone (`mobileRecordForTraceId` decodes it), so a
 * reload or a pasted link lands on the same request the table row showed, from
 * any window. An id that does not decode is not a mobile request and comes back
 * null — "not found" — never as a backend trace borrowed in its place.
 *
 * Nothing here reads backend data — only `assembleTrace`, so both datasets end
 * in the same trace shape. The trace resolver is the one place the two meet.
 */

import { mobileRecordForTraceId } from './mobileTracesExplorer'
import { assembleTrace } from './traceDetail'

// The waterfall colours whatever code it is handed by its number, so only a
// real three-digit answer is passed on. A 0 is no answer at all and UNSET is
// no request status — handing either over would draw a green chip beside a
// request that never got a reply.
const HTTP_CODE = /^\d{3}$/

/**
 * A mobile record as a view-model span (the shape `assembleTrace` takes).
 *
 * The record's attributes become the span's tags as they are, sorted, and not
 * renamed: the backend view renames `status_code` to `otel.status_code`
 * because there it is OTel's status, but on a phone it is the HTTP code the
 * server answered with, and the waterfall search's example names it as such.
 */
function spanOf(row) {
  const code = row.tags.status_code ?? ''
  const failed = row.tags.eventType === 'MobileRequestError'
  const isRequest = failed || row.tags.eventType === 'MobileRequest'
  return {
    id: row.spanId,
    parentId: null,
    depth: 0,
    name: row.spanName,
    service: row.service,
    kind: 'client',
    // The install record is a launch, not a call over the wire.
    category: isRequest ? 'http' : 'internal',
    start: 0,
    startTime: row.time,
    // The record's own duration; an install was never timed, and reads 0.
    duration: row.durationNs != null ? row.durationNs / 1e6 : 0,
    status: failed ? 'error' : 'ok',
    httpStatus: HTTP_CODE.test(code) ? code : null,
    db: false,
    // A failed request is the span's exception, so the Errors tab and the
    // row's error icon show it. Nothing on the device recorded a stack.
    exception: failed
      ? {
          type: row.tags.errorType || 'HTTPError',
          message: row.tags.networkError || `HTTP ${code}`,
          stack: '',
        }
      : null,
    childIds: [],
    tags: Object.fromEntries(Object.entries(row.tags).sort(([a], [b]) => a.localeCompare(b))),
  }
}

/** The one-span trace a mobile trace id stands for, or null when it stands for none. */
export function buildMobileTrace(traceId) {
  const row = mobileRecordForTraceId(traceId)
  if (!row) return null
  return assembleTrace(traceId, [spanOf(row)])
}
