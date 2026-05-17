export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Converts a Playwright-style proxy object to the "ip:port[:user:pass]" string
 * format expected by CapSolver's proxy field.
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
