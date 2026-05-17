import { resolveCaptchaConfig, createSolver } from './config.js';
import { proxyToCapsolverParts } from './utils.js';
import { waitForCloudflareCookie, injectCaptchaToken } from './page-helpers.js';

export const CF_STRATEGY_NAMES = ['wait', 'flaresolverr', 'capsolver', '2captcha', 'anti-captcha'];
export const CF_DEFAULT_AUTO_ORDER = ['wait', 'flaresolverr', 'capsolver', '2captcha', 'anti-captcha'];

/**
 * Try Cloudflare Challenge strategies and return the first success.
 *
 * params.strategy can be:
 *   "auto"      → CF_DEFAULT_AUTO_ORDER (default)
 *   string      → run only that one strategy
 *   string[]    → run the given strategies in the supplied order
 *
 * Each strategy is a function returning { strategy, cookies, userAgent?, allCookies? }
 * or throwing.
 */
export async function solveCloudflareChallenge({ session, page, context, pageUrl, params }) {
  const input = params.strategy ?? 'auto';
  let order;
  if (Array.isArray(input)) {
    if (!input.length) throw new Error('solveCaptcha: strategy array is empty');
    order = input;
  } else if (input === 'auto') {
    order = CF_DEFAULT_AUTO_ORDER;
  } else {
    order = [input];
  }
  for (const name of order) {
    if (!CF_STRATEGY_NAMES.includes(name)) {
      throw new Error(`solveCaptcha: unknown strategy "${name}". Allowed: ${CF_STRATEGY_NAMES.join(', ')}, or "auto"`);
    }
  }

  const hostname = new URL(pageUrl).hostname;
  const waitTimeoutMs = params.waitTimeoutMs ?? 15000;
  const widgetWaitTimeoutMs = params.widgetWaitTimeoutMs ?? 20000;

  const tryWait = async () => {
    const cookie = await waitForCloudflareCookie(context, hostname, waitTimeoutMs);
    if (!cookie) throw new Error(`cf_clearance did not appear within ${waitTimeoutMs}ms`);
    return { strategy: 'wait', cookies: { cf_clearance: cookie.value }, allCookies: [cookie] };
  };

  const tryFlareSolverr = async () => {
    const url = process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191';
    const fsSolver = createSolver({ provider: 'flaresolverr', url });
    if (!fsSolver) throw new Error('FlareSolverr URL not configured');
    const r = await fsSolver.solve('cloudflare-challenge', { pageUrl, proxy: session.proxy });
    return { strategy: 'flaresolverr', cookies: r.cookies, userAgent: r.userAgent, allCookies: r.allCookies };
  };

  const tryCapSolver = async () => {
    const cfg = resolveCaptchaConfig({ provider: 'capsolver' });
    if (!cfg.apiKey) throw new Error('CapSolver apiKey not configured');
    const proxyParts = proxyToCapsolverParts(session.proxy);
    if (!proxyParts) throw new Error('CapSolver requires a session proxy');
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const capSolver = createSolver(cfg);
    const r = await capSolver.solve('cloudflare-challenge', { pageUrl, proxy: proxyParts, userAgent });
    if (!r?.cookies?.cf_clearance) throw new Error(`CapSolver returned no cf_clearance: ${JSON.stringify(r)}`);
    return { strategy: 'capsolver', cookies: r.cookies, userAgent: r.userAgent || userAgent };
  };

  // Generic Turnstile-widget fallback used by 2Captcha and Anti-Captcha:
  // extract siteKey from the page, solve Turnstile via the chosen provider,
  // inject the token, then wait for the host page itself to set cf_clearance.
  const tryTurnstileWidget = async (providerName) => {
    const cfg = resolveCaptchaConfig({ provider: providerName });
    if (!cfg.apiKey) throw new Error(`${providerName} apiKey not configured`);
    const widget = await page.evaluate(() => {
      const el = document.querySelector('.cf-turnstile[data-sitekey]')
        || document.querySelector('[data-sitekey]');
      if (!el) return null;
      return {
        siteKey: el.getAttribute('data-sitekey'),
        action: el.getAttribute('data-action') || undefined,
        cdata: el.getAttribute('data-cdata') || undefined
      };
    });
    if (!widget?.siteKey) {
      throw new Error(`No Turnstile widget on page — ${providerName} strategy only works for interactive CF challenges`);
    }
    const solver = createSolver(cfg);
    const r = await solver.solve('turnstile', {
      siteKey: widget.siteKey, pageUrl, action: widget.action, cdata: widget.cdata
    });
    if (!r?.token) throw new Error(`${providerName} returned no Turnstile token`);
    await injectCaptchaToken(page, 'turnstile', r.token);
    const cookie = await waitForCloudflareCookie(context, hostname, widgetWaitTimeoutMs);
    if (!cookie) throw new Error('Turnstile token injected but cf_clearance did not appear');
    return { strategy: providerName, cookies: { cf_clearance: cookie.value }, allCookies: [cookie] };
  };

  const strategies = {
    wait: tryWait,
    flaresolverr: tryFlareSolverr,
    capsolver: tryCapSolver,
    '2captcha': () => tryTurnstileWidget('2captcha'),
    'anti-captcha': () => tryTurnstileWidget('anti-captcha')
  };

  if (order.length === 1) {
    return await strategies[order[0]]();
  }

  const errors = [];
  for (const name of order) {
    try {
      const t = Date.now();
      console.log(`[session:${session.sessionId}] CF chain: trying "${name}"`);
      const r = await strategies[name]();
      console.log(`[session:${session.sessionId}] CF chain: "${name}" succeeded in ${Date.now() - t}ms`);
      return r;
    } catch (e) {
      console.log(`[session:${session.sessionId}] CF chain: "${name}" failed: ${e.message}`);
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`All CF strategies failed — ${errors.join(' | ')}`);
}
