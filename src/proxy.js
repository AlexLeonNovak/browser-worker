/**
 * Resolves the proxy object passed to Playwright's newContext.
 *
 * Resolution rules:
 *   body.proxy === null        → no proxy (explicit opt-out even if env is set)
 *   body.proxy === undefined   → fall back to env (PROXY_SERVER + optional creds)
 *   body.proxy === { ... }     → use as-is (overrides env)
 *
 * Returns null when nothing is configured.
 */
export function resolveProxyConfig(bodyProxy) {
  if (bodyProxy === null) return null;
  if (bodyProxy !== undefined) return bodyProxy;
  if (!process.env.PROXY_SERVER) return null;
  const p = { server: process.env.PROXY_SERVER };
  if (process.env.PROXY_USERNAME) p.username = process.env.PROXY_USERNAME;
  if (process.env.PROXY_PASSWORD) p.password = process.env.PROXY_PASSWORD;
  if (process.env.PROXY_BYPASS) p.bypass = process.env.PROXY_BYPASS;
  return p;
}
