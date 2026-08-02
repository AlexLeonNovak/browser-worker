/**
 * Request capture — records the outgoing requests the page makes.
 *
 * Some APIs are gated by headers the SPA computes at runtime (a bearer plus a
 * context header). Those live nowhere readable: `getCookies` and
 * `getLocalStorage` do not see them. The only place they exist is on the
 * request the page itself sends, so the only way to get them is to listen.
 *
 * Header sets can be endpoint-scoped — headers captured on one view may be
 * rejected on another — which is why matching is by URL pattern, not
 * "the first request".
 */

/**
 * Arms a page-level listener for requests matching `urlPattern`.
 *
 * params:
 *   urlPattern  required, a regex SOURCE STRING (not a glob) tested against the full url
 *   method      optional, compared case-insensitively; any method when omitted
 *   max         default 10 — caps the buffer so a chatty page cannot grow it without bound
 */
export function armCapture(session, params = {}) {
  const { urlPattern, method, max = 10 } = params;

  if (!urlPattern || typeof urlPattern !== 'string') {
    throw new Error('captureRequests: "urlPattern" is required (a regex string)');
  }

  let re;
  try {
    re = new RegExp(urlPattern);
  } catch (e) {
    throw new Error(`captureRequests: invalid urlPattern regex — ${e.message}`);
  }

  // Re-arming must replace, not stack: a session may need a second endpoint's
  // headers after it already captured a first one.
  disarmCapture(session);

  const wanted = method ? String(method).toUpperCase() : null;
  const captured = [];

  session.captured = captured;
  session.captureHandler = (req) => {
    if (captured.length >= max) return;
    if (wanted && req.method().toUpperCase() !== wanted) return;
    if (!re.test(req.url())) return;
    // headers() is synchronous and returns lowercased keys. allHeaders() is a
    // superset but awaits a CDP extra-info event that never arrives for requests
    // the ad-block route aborts, which would leave a dangling promise.
    captured.push({ url: req.url(), method: req.method(), headers: req.headers() });
  };
  session.page.on('request', session.captureHandler);

  return { armed: urlPattern, method: wanted || 'ANY', max };
}

/** Reads what was captured. Non-draining — safe to call more than once. */
export function getCaptured(session) {
  return { requests: session.captured ?? [] };
}

/** Removes the listener. Safe on a session that was never armed. */
export function disarmCapture(session) {
  if (!session.captureHandler) return;
  try { session.page.off('request', session.captureHandler); } catch {}
  session.captureHandler = null;
  session.captured = [];
}
