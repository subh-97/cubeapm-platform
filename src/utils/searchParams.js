// Query-string helpers shared by every page that owns its own query string
// (Errors, Browser). They lived in errorsUrl.js and errorsPage.js, which still
// re-export them under the same names; they moved here so the Browser page's
// URL module can use them without pulling in the Errors query builder.

// encodeURIComponent, minus the escapes a query string does not need, so a
// shared link reads `span_name=POST+api.stripe.com/v1/charges` rather than
// `POST%20api.stripe.com%2Fv1%2Fcharges`. URLSearchParams reads either.
export function encodeValue(v) {
  return encodeURIComponent(String(v))
    .replace(/%20/g, '+')
    .replace(/%2F/gi, '/')
    .replace(/%3A/gi, ':')
    .replace(/%2C/gi, ',')
}

/**
 * Whether two search strings say the same thing. The browser re-escapes what
 * it is handed — an apostrophe in the search text comes back from the address
 * bar as %27 — so comparing the raw strings would write the URL a second time
 * after every change for a difference only the encoding makes.
 */
export function sameSearch(a, b) {
  const canonical = s => new URLSearchParams(String(s ?? '').replace(/^\?/, '')).toString()
  return canonical(a) === canonical(b)
}
