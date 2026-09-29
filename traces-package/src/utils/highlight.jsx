// Search-term highlighting, shared by the log table and the record drawer.
// It sits apart from both because either one alone would be an odd owner.

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Wraps every occurrence of the searched terms in <mark> so a hit is findable
// without reading the whole line. Terms arrive longest-first so an overlapping
// short term can't chop a longer match in half.
export function highlightTerms(text, terms, className = 'log-hit') {
  if (!terms.length || !text) return text
  const rx = new RegExp(`(${terms.map(escapeRegex).join('|')})`, 'ig')
  const parts = String(text).split(rx)
  // String.split with one capture group interleaves: text, match, text, match…
  return parts.map((p, i) => (i % 2 ? <mark key={i} className={className}>{p}</mark> : p))
}
