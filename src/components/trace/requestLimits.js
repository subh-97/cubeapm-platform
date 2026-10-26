// Production's "N results" choices for a list of requests: the Browser page's
// Traces tab and the service page's Slow Requests. The list is that many
// requests sampled across the range, newest first, and the Sort by toggle
// orders those — so "Latency" is the slowest of the ten, a sample of the range
// rather than its slowest ten (docs/decisions/browser-page.md). Each caller
// keeps its own default: production's Browser traces open on 10, its Slow
// Requests on 5.

export const LIMITS = [5, 10, 20, 50, 100]
export const resultsLabel = n => `${n} results`
export const LIMIT_OPTIONS = LIMITS.map(resultsLabel)
