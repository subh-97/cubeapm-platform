import { useEffect, useRef } from 'react'

// What the skip link points at: the main column below.
export const MAIN_CONTENT_ID = 'main-content'

/**
 * The app's first Tab stop. Hidden until it has focus, it takes a keyboard
 * reader past the sidebar's twenty-odd stops and into the page. It moves focus
 * itself rather than following its #fragment, which would write #main-content
 * into the address bar, give Back an entry to step through, and scroll.
 */
export function SkipLink() {
  const skip = (e) => {
    e.preventDefault()
    document.getElementById(MAIN_CONTENT_ID)?.focus({ preventScroll: true })
  }
  return <a className="skip-link" href={`#${MAIN_CONTENT_ID}`} onClick={skip}>Skip to content</a>
}

/**
 * The main column beside the sidebar: the floating card and everything in it.
 * It can hold focus (tabIndex -1, never a Tab stop), so it is where the skip
 * link lands and where a new page starts the keyboard.
 *
 * A new page replaces the old one, and with it whatever control had focus —
 * the row that opened a service, the Save that left an editor — so focus falls
 * to <body> and the next Tab would start over at the first sidebar link. When
 * `page` changes, focus that fell to the document is brought here instead,
 * without scrolling anything. So is focus still on a control nobody can see:
 * a page that loads on its own (React.lazy) leaves the page it replaces in the
 * document, display: none, until it arrives, and the control that sent the
 * reader on stays focused in there. Focus anywhere else is left where it is:
 * a page that placed it on mount knows better, and so does a reader still in
 * the sidebar. A page that places it a frame later moves it on from here. Not
 * on the first render: the app opening is not a move to put focus anywhere,
 * and the first Tab still finds the skip link.
 */
export default function MainRegion({ page, children }) {
  const ref = useRef(null)
  const shownPage = useRef(page)
  useEffect(() => {
    if (shownPage.current === page) return
    shownPage.current = page
    const at = document.activeElement
    if (at && at !== document.body && at.getClientRects().length > 0) return
    ref.current?.focus({ preventScroll: true })
  }, [page])
  return (
    <main ref={ref} id={MAIN_CONTENT_ID} className="main" tabIndex={-1}>
      {children}
    </main>
  )
}
