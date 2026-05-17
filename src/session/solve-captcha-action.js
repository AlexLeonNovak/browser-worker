import {
  SUPPORTED_TYPES as CAPTCHA_TYPES,
  createSolver,
  autoDetectSiteKey,
  injectCaptchaToken,
  solveCloudflareChallenge
} from '../captcha/index.js';

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
  const t0 = Date.now();

  if (type === 'cloudflare-challenge') {
    console.log(`[session:${session.sessionId}] solveCaptcha cloudflare-challenge (strategy=${params.strategy || 'auto'}): url=${pageUrl}`);
    const r = await solveCloudflareChallenge({ session, page, context, pageUrl, params });
    const elapsed = Date.now() - t0;
    if (inject) {
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
