// The magnifier every search box carries: the legend and table searches on the
// service and Browser pages, and the filter dropdowns' panel search. Its size
// comes from the box it sits in (13px in all of them), so one glyph serves every
// variant.
export default function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
    </svg>
  )
}
