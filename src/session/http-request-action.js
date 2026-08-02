/**
 * `httpRequest` action — runs fetch() inside the page so the request carries
 * the browser's real TLS / HTTP-2 fingerprint and the full cookie jar. This is
 * how you bypass Cloudflare for follow-up calls after solveCaptcha: the cookie
 * was issued for THIS browser's fingerprint, so the cookie is only honored
 * when the request goes through the same browser.
 *
 * params:
 *   url           required, string
 *   method        default "GET"
 *   headers       object (default {})
 *   body          string OR object (objects are JSON-stringified and a
 *                 Content-Type: application/json header is added if absent)
 *   credentials   "include" (default) | "same-origin" | "omit"
 *   responseType  "text" (default) | "json" — controls how body is parsed
 *                 server-side before returning to caller
 *   timeoutMs     default 30000 — aborts the fetch via AbortController
 *
 * Returns:
 *   { status, ok, statusText, headers, body, finalUrl }
 */
export async function httpRequestAction(session, params) {
  const { page } = session;
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    credentials = 'include',
    responseType = 'text',
    timeoutMs = 30000
  } = params;

  if (!url || typeof url !== 'string') {
    throw new Error('httpRequest: "url" is required');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`httpRequest: "url" must be absolute http(s) — got "${url}"`);
  }
  if (!['text', 'json'].includes(responseType)) {
    throw new Error(`httpRequest: responseType must be "text" or "json"`);
  }

  // Normalize body: objects → JSON. Leave strings (form-encoded etc.) alone.
  let normalizedBody = body;
  const finalHeaders = { ...headers };
  if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof Uint8Array)) {
    normalizedBody = JSON.stringify(body);
    const hasCT = Object.keys(finalHeaders).some(h => h.toLowerCase() === 'content-type');
    if (!hasCT) finalHeaders['Content-Type'] = 'application/json';
  }

  console.log(`[session:${session.sessionId}] httpRequest ${method} ${url}`);
  const t0 = Date.now();

  const result = await page.evaluate(async (args) => {
    const { url, method, headers, body, credentials, responseType, timeoutMs } = args;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const init = { method, headers, credentials, signal: ctrl.signal };
      if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
        init.body = body;
      }
      const res = await fetch(url, init);
      const headerObj = {};
      res.headers.forEach((v, k) => { headerObj[k] = v; });
      const bodyOut = responseType === 'json' ? await res.json() : await res.text();
      return {
        status: res.status,
        ok: res.ok,
        statusText: res.statusText,
        headers: headerObj,
        body: bodyOut,
        finalUrl: res.url
      };
    } catch (e) {
      let crossOrigin = false;
      try { crossOrigin = new URL(url, location.href).origin !== location.origin; } catch {}
      return {
        __error: e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e.message,
        __crossOrigin: crossOrigin,
        __pageOrigin: location.origin
      };
    } finally {
      clearTimeout(timer);
    }
  }, { url, method, headers: finalHeaders, body: normalizedBody, credentials, responseType, timeoutMs });

  if (result && result.__error) {
    // "Failed to fetch" is all the browser tells the page about a CORS refusal.
    // The most common cause here is credentials: "include" against an API that
    // does not return Access-Control-Allow-Credentials, so say so.
    const corsHint = /failed to fetch/i.test(result.__error) && result.__crossOrigin
      ? ` — cross-origin from ${result.__pageOrigin}, and the browser gave no reason. Check the API's CORS policy allows this origin and the headers you sent; with credentials:"${credentials}" it must also return Access-Control-Allow-Credentials: true. Token-gated APIs usually want credentials:"omit".`
      : '';
    throw new Error(`httpRequest failed: ${result.__error}${corsHint}`);
  }

  console.log(`[session:${session.sessionId}] httpRequest ${method} ${url} → ${result.status} in ${Date.now() - t0}ms`);
  return result;
}
