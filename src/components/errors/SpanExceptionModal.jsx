import ExceptionModal from './ExceptionModal'
import { msLabel } from '@/components/trace/Waterfall'

/**
 * The stack trace of one failed span, as the trace page has always shown it:
 * the exception class over the span's service, name and duration, then the
 * message and the raw stack. The trace page opens it from its Errors tab, and
 * the Browser page's Traces tab for a backend span under a failed call (a
 * payment-service exception behind the storefront's 503), so both read alike.
 */
export default function SpanExceptionModal({ span, onClose }) {
  return (
    <ExceptionModal
      type={span.exception.type}
      message={span.exception.message}
      stack={span.exception.stack}
      ariaLabel={`Stack trace for ${span.name}`}
      subtitle={<>{span.service}<span className="sep">&middot;</span><span className="mono">{span.name}</span><span className="sep">&middot;</span>{msLabel(span.duration)}</>}
      onClose={onClose}
    />
  )
}
