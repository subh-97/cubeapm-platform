import { useState, useRef, useEffect, useCallback } from 'react'

/**
 * A sticky strip that gets out of the way while a reader scrolls down, and
 * comes straight back the moment they scroll up: the service page's Endpoint
 * strip, its Runtime scope strip, and the Browser page's Traces filters.
 *
 * The strip is in one of three states:
 *   'natural'  - sitting in flow near the top, where it scrolls like anything else
 *   'hidden'   - slid out of view, because the reader is scrolling down
 *   'revealed' - slid back over the top of the content, because they turned round
 *
 * Near the top (under 48px) the strip is simply in its place, so it never
 * animates over content that is barely moving. Further down only a deliberate
 * move counts: more than 2px either way, so the jitter of a trackpad coming to
 * rest neither hides nor reveals it.
 *
 * `onScroll` goes on the element that scrolls. It reads that element
 * (currentTarget) rather than the event's target: React does not bubble scroll
 * events, so the two are the same element today, and currentTarget keeps it
 * that way if a scrolling child ever reports through.
 *
 * `resetKey` puts the strip back in its place, with the scroll memory cleared,
 * whenever it changes - when the content under the strip is replaced (another
 * tab, another endpoint) and its scroller starts again from the top. It is
 * compared by value: pass a string or a number, joining several things into
 * one string (`${tab}:${endpoint}`). An array is joined for you, because an
 * array written inline is a new array on every render, and as a dependency it
 * would put the strip back in its place on every render.
 */
export function useScrollReveal(resetKey) {
  const lastScrollRef = useRef(0)
  const [reveal, setReveal] = useState('natural')

  const onScroll = useCallback((e) => {
    const t = e.currentTarget.scrollTop
    const dy = t - lastScrollRef.current
    lastScrollRef.current = t
    if (t < 48) { setReveal('natural'); return }
    if (dy > 2) setReveal('hidden')
    else if (dy < -2) setReveal('revealed')
  }, [])

  const key = Array.isArray(resetKey) ? resetKey.join('\u0000') : resetKey
  useEffect(() => { setReveal('natural'); lastScrollRef.current = 0 }, [key])

  return { reveal, onScroll }
}

// The modifier a strip's className carries for each state, ready to append:
// `endpoint-strip is-sticky${revealClass(reveal)}`. In its place it needs none.
export function revealClass(reveal) {
  if (reveal === 'hidden') return ' is-hidden'
  if (reveal === 'revealed') return ' is-revealed'
  return ''
}
