/**
 * A path or URL with a line-break opportunity after every '/'. A browser finds
 * none in one by itself, so a long one wrapping in a narrow column is cut
 * wherever the column ends ('index-' / '4f2a9c.js', 'v' / '1/payments'); with
 * these it wraps between segments and every segment stays whole. The text, as
 * copied or read out, is unchanged.
 */
export default function BreakAtSlashes({ text }) {
  const parts = String(text ?? '').split(/(?<=\/)/)
  return parts.map((p, i) => (i === 0 ? p : <span key={i}><wbr />{p}</span>))
}
