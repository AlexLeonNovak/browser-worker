import { resolveCaptchaConfig } from '../captcha/index.js';
import { resolveProxyConfig } from '../proxy.js';
import { sessions, resetTimer } from '../session/manager.js';
import { createSession } from '../session/create.js';
import { executeStep } from '../session/execute-step.js';

const VALID_PROVIDERS = ['2captcha', 'capsolver', 'anti-captcha', 'flaresolverr'];

/**
 * POST /execute — create-or-reuse a session, run a list of step actions, return results.
 */
export default function registerExecuteRoute(app) {
  app.post('/execute', async (req, res) => {
    const {
      sessionId,
      ttl,
      headless = true,
      proxy: bodyProxy,
      captchaSolver = null,
      userAgent,
      blockAds = false,
      forceHttp = false,
      disableSecurity = false,
      addCSS = '',
      addJS = '',
      steps = [],
      stopOnError = true
    } = req.body;

    if (!steps.length) return res.status(400).json({ ok: false, error: 'steps required' });

    if (bodyProxy !== null && bodyProxy !== undefined) {
      if (typeof bodyProxy !== 'object' || !bodyProxy.server || typeof bodyProxy.server !== 'string') {
        return res.status(400).json({ ok: false, error: 'proxy must be an object with a "server" string (e.g. "http://host:port"), or null to opt out of the env default' });
      }
    }

    const proxy = resolveProxyConfig(bodyProxy);

    if (captchaSolver !== null) {
      if (typeof captchaSolver !== 'object') {
        return res.status(400).json({ ok: false, error: 'captchaSolver must be an object' });
      }
      if (captchaSolver.provider && !VALID_PROVIDERS.includes(captchaSolver.provider)) {
        return res.status(400).json({ ok: false, error: `captchaSolver.provider must be one of ${VALID_PROVIDERS.join(', ')}` });
      }
    }

    const captchaConfig = resolveCaptchaConfig(captchaSolver);

    let session = sessionId ? sessions.get(sessionId) : null;
    if (sessionId && !session) return res.status(404).json({ ok: false, error: 'Session expired' });

    if (!session) {
      const sessionTtl = ttl || 30000;
      try {
        session = await createSession({ ttl: sessionTtl, headless, proxy, captchaConfig, userAgent, blockAds, forceHttp, disableSecurity, addCSS, addJS });
      } catch (err) {
        return res.status(503).json({ ok: false, error: err.message });
      }
    } else {
      if (ttl) {
        session.ttl = ttl;
        console.log(`[session:${session.sessionId}] TTL updated to ${ttl}ms`);
      }
      if (captchaSolver) {
        session.captchaConfig = captchaConfig;
        console.log(`[session:${session.sessionId}] captchaSolver updated to ${captchaConfig.provider}`);
      }
    }

    const results = [];
    let error = null;
    for (const step of steps) {
      session.busy = true;
      try {
        console.log(`[session:${session.sessionId}] action: ${step.action}`, step.params);
        const result = await executeStep(session, step);
        console.log(`[session:${session.sessionId}] result: ${step.action}`, result);
        results.push({ action: step.action, ok: true, result });
      } catch (e) {
        results.push({ action: step.action, ok: false, error: e.message });
        error = e.message;
        if (stopOnError) break;
      } finally {
        session.busy = false;
      }
    }

    resetTimer(session.sessionId);

    let finalUrl = null;
    try {
      finalUrl = session?.page && !session.page.isClosed() ? session.page.url() : null;
    } catch {}

    res.json({
      ok: !error,
      sessionId: session.sessionId,
      results,
      finalUrl,
      error: !!error ? error : undefined
    });
  });
}
