/**
 * Content Security Policy.
 *
 * This is an API. It serves JSON, not documents, so the policy is mostly about
 * making that explicit rather than about restricting a page: the one HTML-ish
 * surface is the error path, and a CSP stops a reflected string from ever being
 * treated as a document.
 *
 * The real value is `frame-ancestors` and `base-uri`. A JSON response cannot be
 * framed usefully, but declaring `frame-ancestors 'none'` means that stays true
 * if someone later adds a route that returns HTML.
 *
 * `connect-src` is deliberately permissive ('self' plus nothing) because the
 * browser-side app is served from a *different* origin than this API -- it runs
 * on Vercel while this runs on Render. A CSP here governs documents this origin
 * serves, and there are none, so it is not the place to police cross-origin
 * fetches; the CORS headers are.
 */

const DEFAULT_DIRECTIVES = {
  'default-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
  'object-src': ["'none'"],
  'script-src': ["'none'"],
  'style-src': ["'none'"],
  'img-src': ["'none'"],
  'connect-src': ["'self'"],
  'manifest-src': ["'self'"],
};

/** Render a directives object into the header value. */
export function buildCsp(directives = DEFAULT_DIRECTIVES) {
  return Object.entries(directives)
    .map(([key, values]) => `${key} ${[].concat(values).join(' ')}`)
    .join('; ');
}

/**
 * The security headers worth sending from an API.
 *
 * `X-Content-Type-Options: nosniff` is the one that earns its place here: it
 * stops a browser treating a JSON error body as HTML, which is the only
 * realistic path from "user text" to "script runs".
 */
export function securityHeaders() {
  const csp = buildCsp();

  return function setSecurityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Nothing here is a document, so nothing should be cached by a shared proxy.
    // Set per-route instead where it matters; this is the conservative default.
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    next();
  };
}