// When a toast goes by itself: how long it is given, and the countdown that
// spends that time only while nobody is holding the toast. Neither touches
// React or the DOM, so both are tested in node; Toast.jsx does the wiring.

// A plain notice is up long enough to read. A message carrying a control of
// its own (UndoMessage's Undo) has to be read and then reached, the pointer
// travelled to it or Tab walked down to it, so it is given longer.
export const NOTICE_MS = 4500
export const ACTION_MS = 10000

/**
 * How long a toast stays up while nothing holds it. A caller's own `duration`
 * wins outright, and 0 or null keeps the toast until it is closed. Otherwise
 * the message decides: `interactive` when it carries a control.
 */
export function toastDuration({ duration, interactive = false } = {}) {
  if (duration !== undefined) return duration
  return interactive ? ACTION_MS : NOTICE_MS
}

const systemClock = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: id => clearTimeout(id),
}

/**
 * A toast's countdown to `onDone`, running only while nothing holds it.
 *
 * Each hold is named for its reason, the pointer resting on the toast or focus
 * inside it, so the pointer leaving does not let go of a toast the keyboard is
 * still on. Releasing the last hold resumes from the time that was left, not
 * the whole time again: a long read uses up nothing, and a toast that was
 * nearly gone goes soon after.
 *
 * `ms` that is not a positive number never runs out. `cancel` is for the toast
 * going some other way (closed, replaced by the next message); after it, or
 * after `onDone`, no hold or release starts anything again.
 *
 * `clock` is only there for the tests to drive.
 */
export function countdown(ms, onDone, clock = systemClock) {
  const holds = new Set()
  let left = ms > 0 && Number.isFinite(ms) ? ms : Infinity
  let since = 0
  let timer = null
  let over = false

  const run = () => {
    if (over || timer != null || holds.size > 0 || left === Infinity) return
    since = clock.now()
    timer = clock.set(() => { timer = null; over = true; onDone() }, left)
  }
  const stop = () => {
    if (timer == null) return
    clock.clear(timer)
    timer = null
    left = Math.max(0, left - (clock.now() - since))
  }

  run()
  return {
    hold(reason) { holds.add(reason); stop() },
    release(reason) { holds.delete(reason); run() },
    cancel() { stop(); over = true },
  }
}
