// The PromQL/MetricsQL engine, as one import.
//
// `api.js` takes `parsePromql`, `evaluateRange`, `evaluateInstant` and
// `PromqlError` from here; the editor additionally takes the lexer, because
// highlighting and autocomplete tokenise the same text the parser will read.

export { tokenizePromql, durationSeconds, AGGREGATION_NAMES, FUNCTION_NAMES, PROMQL_MODIFIERS, BINARY_WORD_OPERATORS } from './lexer.js'
export { parsePromql, PromqlError } from './parser.js'
export { evaluateRange, evaluateInstant } from './evaluate.js'
