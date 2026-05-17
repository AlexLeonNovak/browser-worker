export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Converts a Playwright-style proxy object to the "ip:port[:user:pass]" string
 * format expected by CapSolver's proxy field (legacy form).
 */
export function proxyToCapsolverString(p) {
  if (!p || !p.server) return null;
  try {
    const u = new URL(p.server);
    const host = u.hostname;
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (p.username && p.password) return `${host}:${port}:${p.username}:${p.password}`;
    return `${host}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Converts a Playwright-style proxy object to CapSolver's explicit field form:
 *   { proxyType, proxyAddress, proxyPort, proxyLogin?, proxyPassword? }
 *
 * Use this for tasks that take separate proxy fields (AntiCloudflareTask etc.) —
 * the explicit form removes ambiguity in CapSolver's string parser, which has
 * been observed to fail with "custom proxy connect failed" for valid proxies
 * passed as colon-separated strings.
 */
export function proxyToCapsolverParts(p) {
  if (!p || !p.server) return null;
  try {
    const u = new URL(p.server);
    const proxyType = (u.protocol || 'http:').replace(':', '').toLowerCase();
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const parts = {
      proxyType,
      proxyAddress: u.hostname,
      proxyPort: parseInt(port, 10)
    };
    if (p.username) parts.proxyLogin = p.username;
    if (p.password) parts.proxyPassword = p.password;
    return parts;
  } catch {
    return null;
  }
}
