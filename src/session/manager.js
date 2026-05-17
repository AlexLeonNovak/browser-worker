/**
 * Shared session registry. The Map is a module-level singleton — every importer
 * gets the same reference, so route handlers and lifecycle code stay in sync.
 */
export const sessions = new Map();

/**
 * Resets the session expiration timer.
 */
export function resetTimer(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    console.log(`[session:${sessionId}] TTL expired (${session.ttl}ms)`);
    closeSession(sessionId);
  }, session.ttl);
}

/**
 * Closes the browser session and removes it from the sessions map.
 */
export async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.closing) return;

  session.closing = true;

  clearTimeout(session.timer);

  try { await session.browser.close(); } catch {}

  sessions.delete(sessionId);
  console.log(`[session:${sessionId}] closed`);
}
