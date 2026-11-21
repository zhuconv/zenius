// Session values in the DOM (CSRF tokens, nonces, visitor ids, hidden form
// fields) say nothing about structure and shouldn't be committed, even when
// anonymous. Hidden inputs never appear in snapshots, so blanking is safe.
export function scrubDom(html) {
  return html
    .replace(/(<input\b[^>]*\btype=["']?hidden["']?[^>]*\bvalue=)("[^"]*"|'[^']*')/gi, '$1""')
    .replace(/(<input\b[^>]*\bvalue=)("[^"]*"|'[^']*')([^>]*\btype=["']?hidden)/gi, '$1""$3')
    .replace(
      /(<meta\b[^>]*\bname=["']?[^"'>]*(token|nonce|csrf|visitor|octolytics|request-id|hmac|session|analytics|user|login|fb:|ga-)[^"'>]*["']?[^>]*\bcontent=)("[^"]*"|'[^']*')/gi,
      '$1""',
    )
    .replace(/\bnonce=("[^"]*"|'[^']*')/gi, 'nonce=""');
}
