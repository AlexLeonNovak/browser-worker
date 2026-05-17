import { sessions, closeSession } from '../session/manager.js';

/**
 * Mounts: GET /health, GET /sessions, GET /sessions/:id, DELETE /sessions/:id
 */
export default function registerSessionRoutes(app) {
  app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size }));

  app.get('/sessions', (req, res) => {
    const list = [...sessions.entries()].map(([id, s]) => ({
      sessionId: id,
      ttl: s.ttl,
      url: s.page.url()
    }));
    res.json({ count: list.length, sessions: list });
  });

  app.get('/sessions/:id', (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
    res.json({ ok: true, sessionId: req.params.id, url: s.page.url(), ttl: s.ttl });
  });

  app.delete('/sessions/:id', async (req, res) => {
    if (!sessions.has(req.params.id)) return res.status(404).json({ ok: false, error: 'Session not found' });
    await closeSession(req.params.id);
    res.json({ ok: true });
  });
}
