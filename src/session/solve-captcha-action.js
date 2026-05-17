import {
  SUPPORTED_TYPES as CAPTCHA_TYPES,
  createSolver,
  autoDetectSiteKey,
  injectCaptchaToken,
  solveCloudflareChallenge
} from '../captcha/index.js';

/**
 * Cloudflare binds cf_clearance to the User-Agent it was issued for.
 * When a solver (flaresolverr / capsolver) returns its own UA, the browser
 * must adopt it for the cookie to survive reload — otherwise CF re-issues
 * the challenge. setUserAgentOverride changes both navigator.userAgent and
 * the outgoing HTTP header.
 */
async function syncUserAgent(session, page, userAgent) {
  if (!userAgent) return;
  if (session.activeUserAgent === userAgent) return;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.setUserAgentOverride', { userAgent });
    session.activeUserAgent = userAgent;
    console.log(`[session:${session.sessionId}] UA synced → ${userAgent}`);
  } catch (e) {
    console.warn(`[session:${session.sessionId}] UA sync failed: ${e.message}`);
  }
}

/**
 * Implements the `solveCaptcha` action. Two branches:
 *
 *   - cloudflare-challenge → multi-strategy flow, returns cookies
 *   - token-based types    → run configured solver, inject token
 */
export async function solveCaptchaAction(session, params) {
  const { page, context } = session;
  const { type, siteKey, action: cfAction, cdata, score, url, inject = true } = params;

  if (!type || !CAPTCHA_TYPES.includes(type)) {
    throw new Error(`solveCaptcha: "type" must be one of ${CAPTCHA_TYPES.join(', ')}`);
  }
  const pageUrl = url || page.url();
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
    throw new Error(`solveCaptcha: invalid pageUrl "${pageUrl}". The preceding goto probably failed (page is on about:blank). Check the previous step's error or pass an explicit "url" param.`);
  }
  const t0 = Date.now();

  if (type === 'cloudflare-challenge') {
    console.log(`[session:${session.sessionId}] solveCaptcha cloudflare-challenge (strategy=${params.strategy || 'auto'}): url=${pageUrl}`);
    const r = await solveCloudflareChallenge({ session, page, context, pageUrl, params });
    const elapsed = Date.now() - t0;
    if (inject) {
      // Adopt the solver's UA BEFORE adding cookies — Cloudflare validates the
      // request UA against the one cf_clearance was issued for, so the next
      // request (e.g. reload) must already use it.
      await syncUserAgent(session, page, r.userAgent);
      if (r.allCookies && r.allCookies.length) {
        const cookies = r.allCookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || new URL(pageUrl).hostname,
          path: c.path || '/',
          ...(c.expires != null ? { expires: c.expires } : {}),
          ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
          ...(c.secure != null ? { secure: c.secure } : {}),
          ...(c.sameSite ? { sameSite: c.sameSite } : {})
        }));
        await context.addCookies(cookies);
      } else {
        const u = new URL(pageUrl);
        await context.addCookies([{
          name: 'cf_clearance',
          value: r.cookies.cf_clearance,
          domain: u.hostname,
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None'
        }]);
      }
    }
    console.log(`[session:${session.sessionId}] cloudflare-challenge solved via "${r.strategy}" in ${elapsed}ms`);
    return {
      solved: true,
      type,
      strategy: r.strategy,
      elapsedMs: elapsed,
      cookies: r.cookies,
      userAgent: r.userAgent
    };
  }

  // Token-based captchas: turnstile, recaptcha v2/v3, hcaptcha — need configured solver.
  const solver = createSolver(session.captchaConfig);
  if (!solver) {
    throw new Error('solveCaptcha: no captcha solver configured. Set CAPTCHA_API_KEY_2CAPTCHA / CAPTCHA_API_KEY_CAPSOLVER in env, or pass captchaSolver in /execute body.');
  }
  let resolvedSiteKey = siteKey;
  if (!resolvedSiteKey) {
    resolvedSiteKey = await autoDetectSiteKey(page, type);
  }
  if (!resolvedSiteKey) {
    throw new Error(`solveCaptcha: siteKey not provided and could not be auto-detected for ${type}`);
  }
  console.log(`[session:${session.sessionId}] solveCaptcha via ${solver.name}: type=${type}, siteKey=${resolvedSiteKey}, url=${pageUrl}`);
  const result = await solver.solve(type, { siteKey: resolvedSiteKey, pageUrl, action: cfAction, cdata, score });
  const token = result?.token;
  const elapsed = Date.now() - t0;
  if (!token) {
    throw new Error(`${solver.name} returned no token: ${JSON.stringify(result)}`);
  }
  console.log(`[session:${session.sessionId}] solveCaptcha solved in ${elapsed}ms (tokenLen=${token.length})`);
  if (inject) {
    await injectCaptchaToken(page, type, token);
  }
  return { solved: true, type, provider: solver.name, elapsedMs: elapsed, tokenLength: token.length, token };
}
