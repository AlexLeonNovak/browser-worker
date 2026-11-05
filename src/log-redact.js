/**
 * What may reach the container log from a caller's step params, a step result
 * or createSession options.
 *
 * Callers pass credentials through this API: fill values (logins), request
 * headers (bearer tokens), cookies, storageState, proxy and captcha keys. The
 * log used to print all of it as is, so every login password and bearer token
 * a caller sent ended up in `docker logs`.
 *
 * An allowlist, not a denylist: a new action or a new field stays hidden until
 * someone adds it here, instead of leaking until someone notices.
 */

// Top-level fields whose string value is safe to print (selectors, urls, flags,
// the small echo objects actions return). Everything else prints as its shape.
const SAFE_KEYS = new Set([
  'selector', 'url', 'finalUrl', 'method', 'key', 'state', 'waitUntil', 'statusText',
  'clicked', 'filled', 'typed', 'found', 'hovered', 'checked', 'pressed', 'selected',
  'armed', 'provider', 'strategy', 'type', 'userAgent', 'responseType', 'credentials'
]);

const URL_KEYS = new Set(['url', 'finalUrl']);

function shape(v) {
  if (typeof v === 'string') return `<string ${v.length}>`;
  if (Array.isArray(v)) return `<array ${v.length}>`;
  if (v && typeof v === 'object') return `<object ${Object.keys(v).join(',')}>`;
  return `<${typeof v}>`;
}

/**
 * A log-safe, one-level copy: safe keys keep their value, numbers / booleans /
 * null are kept (no secret, useful for debugging), anything else becomes its
 * shape — `<string 12>`, `<array 3>`, `<object a,b>`.
 */
export function summarize(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object' || Array.isArray(obj)) return shape(obj);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && SAFE_KEYS.has(k)) out[k] = URL_KEYS.has(k) ? safeUrl(v) : v;
    else out[k] = shape(v);
  }
  return out;
}

/** A url without its query, fragment or user:password — tokens live there. */
export function safeUrl(u) {
  if (typeof u !== 'string') return `<${typeof u}>`;
  const noAuth = u.replace(/\/\/[^/?#@]*@/, '//***@');
  const cut = noAuth.search(/[?#]/);
  return cut === -1 ? noAuth : `${noAuth.slice(0, cut)}?…`;
}

function secretStrings(v, out = []) {
  if (typeof v === 'string') { if (v.length >= 4) out.push(v); }
  else if (v && typeof v === 'object') for (const x of Object.values(v)) secretStrings(x, out);
  return out;
}

/**
 * An error message with every string the step was given (outside SAFE_KEYS)
 * cut out. Playwright errors can echo the call they failed on, value included.
 * Values under 4 chars are left: replacing "on" or "1" would shred the message
 * and protects nothing.
 */
export function scrub(msg, params) {
  if (typeof msg !== 'string' || !params || typeof params !== 'object') return msg;
  const secrets = Object.entries(params)
    .filter(([k]) => !SAFE_KEYS.has(k))
    .flatMap(([, v]) => secretStrings(v))
    .sort((a, b) => b.length - a.length); // longest first, so a substring does not split a longer one
  return secrets.reduce((m, s) => m.split(s).join('[redacted]'), msg);
}
