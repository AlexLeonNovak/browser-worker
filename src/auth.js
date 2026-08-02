import { timingSafeEqual } from 'crypto';

/**
 * Shared-secret auth for the whole API.
 *
 * /execute takes `evaluate` (arbitrary JS in the page) and `httpRequest`
 * (arbitrary fetch from inside the browser, carrying its cookie jar and the
 * configured proxy). Whoever can reach the port controls that browser, so an
 * always-on deployment needs a check even behind a firewall.
 *
 * /health stays open — the container healthcheck must work without the secret.
 */
const OPEN_PATHS = new Set(['/health']);

/** Constant-time compare. Different lengths are rejected outright: timingSafeEqual throws on them. */
export function tokenMatches(expected, got) {
  if (!got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pulls the token out of `x-worker-token`, falling back to `Authorization: Bearer`. */
export function extractToken(headers = {}) {
  const direct = headers['x-worker-token'];
  if (direct) return direct;
  const m = /^Bearer\s+(.+)$/i.exec(headers.authorization || '');
  return m ? m[1] : null;
}

/**
 * Returns an Express middleware. With no token configured it is a pass-through —
 * the server logs a warning at boot so an unprotected deployment is at least loud.
 */
export function createAuthMiddleware(token = process.env.WORKER_TOKEN) {
  if (!token) return (req, res, next) => next();

  return (req, res, next) => {
    if (OPEN_PATHS.has(req.path)) return next();
    if (tokenMatches(token, extractToken(req.headers))) return next();
    res.status(401).json({ ok: false, error: 'unauthorized' });
  };
}
