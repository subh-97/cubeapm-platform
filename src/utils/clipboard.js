// Copying text, for the Errors page and its details drawer.

// The async clipboard is missing outright on a plain-http address other than
// localhost, and can refuse (no permission, the page not focused). The older
// execCommand copy still works from a click in both cases, so it is the
// fallback; the answer says whether either one worked, so the toast never
// claims a copy that did not happen.
//
// Call it straight from the click handler: execCommand needs the click's user
// activation, which a call made after an await no longer has.
/** @returns {Promise<boolean>} whether the text reached the clipboard */
export function copyText(text) {
  const legacy = () => {
    const back = document.activeElement
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
    document.body.appendChild(ta)
    ta.focus({ preventScroll: true })
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    ta.remove()
    if (back instanceof HTMLElement) back.focus({ preventScroll: true })
    return ok
  }
  try {
    return navigator.clipboard.writeText(text).then(() => true, legacy)
  } catch {
    return Promise.resolve(legacy())
  }
}
