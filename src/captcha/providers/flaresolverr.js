import { CLOUDFLARE_CHALLENGE } from '../constants.js';

/**
 * FlareSolverr is a self-hosted Cloudflare bypass — it runs its own headless
 * browser, waits for the challenge to pass, and returns cookies + UA.
 * Free, no API key, but requires a running flaresolverr container.
 *
 * Only supports cloudflare-challenge type. Other captchas fall back to the
 * configured 2captcha/capsolver/anti-captcha provider.
 */
export class FlareSolverrSolver {
  constructor(url) {
    this.url = url.replace(/\/$/, '');
    this.name = 'flaresolverr';
  }

  async solve(type, params) {
    if (type !== CLOUDFLARE_CHALLENGE) {
      throw new Error(`FlareSolverr only supports "cloudflare-challenge" (got "${type}")`);
    }
    return await this._solveCfChallenge(params);
  }

  async _solveCfChallenge({ pageUrl, proxy, maxTimeoutMs = 60000 }) {
    const body = {
      cmd: 'request.get',
      url: pageUrl,
      maxTimeout: maxTimeoutMs
    };
    if (proxy && proxy.server) {
      const proxyEntry = { url: proxy.server };
      if (proxy.username) proxyEntry.username = proxy.username;
      if (proxy.password) proxyEntry.password = proxy.password;
      body.proxy = proxyEntry;
    }

    const res = await fetch(`${this.url}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (json.status !== 'ok') {
      throw new Error(`FlareSolverr failed: ${json.message || JSON.stringify(json)}`);
    }
    const solution = json.solution || {};
    const cookieList = solution.cookies || [];
    const cookiesMap = cookieList.reduce((acc, c) => { acc[c.name] = c.value; return acc; }, {});
    if (!cookiesMap.cf_clearance) {
      throw new Error('FlareSolverr returned no cf_clearance cookie — page may not have been behind Cloudflare');
    }
    return {
      token: null,
      cookies: cookiesMap,
      userAgent: solution.userAgent || null,
      allCookies: cookieList
    };
  }
}
