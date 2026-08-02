import { releaseBrowser } from './browser-pool.js';
import { disarmCapture } from './request-capture.js';

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
 * Closes the session's context and removes it from the sessions map. The browser
 * itself goes back to the pool — it is shared with other sessions and closing it
 * here would take them down with it.
 */
export async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.closing) return;

  session.closing = true;

  clearTimeout(session.timer);
  disarmCapture(session);

  try { await session.context.close(); } catch {}
  releaseBrowser(session.browserKey);

  sessions.delete(sessionId);
  console.log(`[session:${sessionId}] closed`);
}

/** Closes every live session. Used on shutdown. */
export async function closeAllSessions() {
  await Promise.all([...sessions.keys()].map(closeSession));
}
