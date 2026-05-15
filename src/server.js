import express from 'express';
import { chromium } from 'patchright';
import { randomUUID } from 'crypto';
import { resolveAdPatterns } from './ad-patterns.js';
import {
  SUPPORTED_TYPES as CAPTCHA_TYPES,
  DEFAULT_USER_AGENT,
  resolveCaptchaConfig,
  createSolver,
  autoDetectSiteKey,
  injectCaptchaToken,
  proxyToCapsolverString,
  waitForCloudflareCookie
} from './captcha-solver.js';

const CF_STRATEGIES = ['auto', 'wait', 'flaresolverr', 'capsolver', '2captcha'];

/**
 * Try each Cloudflare Challenge strategy in turn and return the first success.
 * Each strategy is a function returning { strategy, cookies, userAgent?, allCookies? }
 * or throwing.
 */
async function solveCloudflareChallenge({ session, page, context, pageUrl, params }) {
  const strategy = params.strategy || 'auto';
  if (!CF_STRATEGIES.includes(strategy)) {
    throw new Error(`solveCaptcha: strategy must be one of ${CF_STRATEGIES.join(', ')}`);
  }
  const hostname = new URL(pageUrl).hostname;
  const waitTimeoutMs = params.waitTimeoutMs ?? 15000;

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
    const cfg = session.captchaConfig?.provider === 'capsolver'
      ? session.captchaConfig
      : { provider: 'capsolver', apiKey: process.env.CAPTCHA_API_KEY_CAPSOLVER };
    if (!cfg.apiKey) throw new Error('CapSolver apiKey not configured');
    const proxyStr = proxyToCapsolverString(session.proxy);
    if (!proxyStr) throw new Error('CapSolver requires a session proxy');
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const capSolver = createSolver(cfg);
    const r = await capSolver.solve('cloudflare-challenge', { pageUrl, proxy: proxyStr, userAgent });
    if (!r?.cookies?.cf_clearance) throw new Error(`CapSolver returned no cf_clearance: ${JSON.stringify(r)}`);
    return { strategy: 'capsolver', cookies: r.cookies, userAgent: r.userAgent || userAgent };
  };

  const try2CaptchaTurnstile = async () => {
    const cfg = session.captchaConfig?.provider === '2captcha'
      ? session.captchaConfig
      : { provider: '2captcha', apiKey: process.env.CAPTCHA_API_KEY_2CAPTCHA };
    if (!cfg.apiKey) throw new Error('2Captcha apiKey not configured');
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
      throw new Error('No Turnstile widget on page — 2captcha strategy only works for interactive CF challenges');
    }
    const twoCaptchaSolver = createSolver(cfg);
    const r = await twoCaptchaSolver.solve('turnstile', {
      siteKey: widget.siteKey, pageUrl, action: widget.action, cdata: widget.cdata
    });
    if (!r?.token) throw new Error('2Captcha returned no Turnstile token');
    await injectCaptchaToken(page, 'turnstile', r.token);
    const cookie = await waitForCloudflareCookie(context, hostname, 20000);
    if (!cookie) throw new Error('Turnstile token injected but cf_clearance did not appear');
    return { strategy: '2captcha', cookies: { cf_clearance: cookie.value }, allCookies: [cookie] };
  };

  const strategies = {
    wait: tryWait,
    flaresolverr: tryFlareSolverr,
    capsolver: tryCapSolver,
    '2captcha': try2CaptchaTurnstile
  };

  if (strategy !== 'auto') {
    return await strategies[strategy]();
  }

  const order = ['wait', 'flaresolverr', 'capsolver', '2captcha'];
  const errors = [];
  for (const name of order) {
    try {
      const t = Date.now();
      console.log(`[session:${session.sessionId}] CF auto: trying "${name}"`);
      const r = await strategies[name]();
      console.log(`[session:${session.sessionId}] CF auto: "${name}" succeeded in ${Date.now() - t}ms`);
      return r;
    } catch (e) {
      console.log(`[session:${session.sessionId}] CF auto: "${name}" failed: ${e.message}`);
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`All CF strategies failed — ${errors.join(' | ')}`);
}

const app = express();
app.use(express.json());

// session id -> { sessionId, browser, context, page, ttl, timer, forceHttpHosts: Set<string>, blockAds, forceHttp }
const sessions = new Map();

/**
 * Resets the session expiration timer.
 */
function resetTimer(sessionId) {
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
async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.closing) return;

  session.closing = true;

  clearTimeout(session.timer);

  try { await session.browser.close(); } catch {}

  sessions.delete(sessionId);
  console.log(`[session:${sessionId}] closed`);
}

/**
 * Creates a new browser session with AdBlocking, CSS/JS injection, and Force HTTP.
 */
async function createSession(options = {}) {
  console.log('Creating new session with options:', options);
  const {
    ttl = 30000,
    headless = true,
    proxy = null,
    captchaConfig = null,
    userAgent = DEFAULT_USER_AGENT,
    blockAds = false,
    forceHttp = false,
    disableSecurity = false,
    addCSS = '',
    addJS = ''
  } = options;

  const sessionId = randomUUID();
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu-memory-buffer-video-frames',
    '--disable-gpu-memory-buffer-compositor-resources',
    '--disable-background-networking',
    '--mute-audio',
  ];

  if (disableSecurity) {
    args.push(
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--ignore-certificate-errors',
      '--ignore-certificate-errors-spki-list',
      '--disable-features=SafeBrowsing,LocalNetworkAccessChecks',
      '--disable-hsts',
      '--disable-site-isolation-trials'
    );
  }

  console.log(`[session:${sessionId}] Launching Google Chrome (headless=${headless}, proxy=${proxy ? proxy.server : 'none'})...`);
  const browser = await chromium.launch({
    headless,
    channel: 'chrome',
    args,
  });

  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: disableSecurity,
    javaScriptEnabled: true,
    bypassCSP: disableSecurity,
    extraHTTPHeaders: { 'Upgrade-Insecure-Requests': '0' },
    ...(proxy ? { proxy } : {})
  });

  // --- CSS Injection ---
  if (addCSS) {
    await context.addInitScript(({ css }) => {
      const style = document.createElement('style');
      style.textContent = css;
      document.documentElement.appendChild(style);
    }, { css: addCSS });
  }

  // --- JS Injection ---
  if (addJS) {
    await context.addInitScript((js) => {
      const script = document.createElement('script');
      script.textContent = js;
      document.documentElement.appendChild(script);
    }, addJS);
  }

  const page = await context.newPage();

  // Normalize forceHttp: true = all domains, array = only these domains
  const forceHttpHosts = Array.isArray(forceHttp) ? new Set(forceHttp) : new Set();

  const sessionObj = { sessionId, browser, context, page, ttl, blockAds, forceHttp, forceHttpHosts, captchaConfig, proxy };
  sessions.set(sessionId, sessionObj);
  resetTimer(sessionId);

  console.log(`[session:${sessionId}] created`);
  return sessionObj;
}

async function setupRoutes(session) {
  const { context, sessionId, forceHttp, forceHttpHosts, blockAds } = session;

  // Remove existing routes to prevent duplicates on session reuse
  await context.unroute('**/*');

  const patterns = resolveAdPatterns(blockAds);
  const adBlockingEnabled = patterns !== null;
  const forceHttpActive = forceHttp === true || forceHttpHosts.size > 0;

  if (!forceHttpActive && !adBlockingEnabled) {
    return;
  }

  await context.route('**/*', async (route) => {
    const urlStr = route.request().url();
    const urlLower = urlStr.toLowerCase();

    // AdBlock
    const isAd = adBlockingEnabled && patterns.some(p => urlLower.includes(p));
    if (isAd) {
      console.log(`[session:${sessionId}] AdBlock: ${urlStr}`);
      return route.abort();
    }
    let url = null;
    try { url = new URL(urlStr); } catch {}
    const hostname = url?.hostname?.toLowerCase();

    // ForceHTTP — check if this hostname should be forced
    const shouldForceHttp = forceHttp === true || (hostname && forceHttpHosts.has(hostname));
    if (shouldForceHttp && url.protocol === 'https:') {
      const httpUrl = urlStr.replace(/^https:/, 'http:');
      console.log(`[session:${sessionId}] ForceHTTP: ${urlStr} → ${httpUrl}`);
      try {
        const response = await route.fetch({ url: httpUrl });
        await route.fulfill({ response });
        return;
      } catch (e) {
        console.log(`[session:${sessionId}] ForceHTTP failed: ${e.message}`);
      }
    }

    route.continue();
  });

  const hostInfo = forceHttp === true ? 'all hosts' : `hosts: ${[...forceHttpHosts].join(', ') || 'none'}`;
  console.log(`[session:${sessionId}] Routes setup — forceHttp: ${hostInfo}, adBlock: ${adBlockingEnabled}`);
}

/**
 * Executes a single step in the browser.
 */
async function executeStep(session, step) {
  const { action, params = {} } = step;
  const { page, context } = session;

  switch (action) {
      case 'goto': {
        try {
          const targetUrl = new URL(params.url);
          // Auto-detect: if URL uses http://, add hostname to forceHttpHosts
          if (targetUrl.protocol === 'http:') {
            session.forceHttpHosts.add(targetUrl.hostname.toLowerCase());
          }
          await setupRoutes(session);
        } catch (e) {
          return { error: `Invalid URL: ${params.url}` };
        }
        await page.goto(params.url, { waitUntil: params.waitUntil ?? 'domcontentloaded', timeout: params.timeout ?? 3600000 });
        return { url: page.url() };
      }
      case 'reload':
        await page.reload({ waitUntil: params.waitUntil ?? 'domcontentloaded' });
        return { url: page.url() };
      case 'getUrl':
        return { url: page.url() };
      case 'getContent':
        return { html: await page.content() };
      case 'click':
        await page.click(params.selector, { timeout: params.timeout ?? 30000 });
        return { clicked: params.selector };
      case 'fill':
        await page.fill(params.selector, params.value);
        return { filled: params.selector };
      case 'type':
        await page.type(params.selector, params.text, { delay: params.delay ?? 30 });
        return { typed: params.selector };
      case 'select':
        await page.selectOption(params.selector, params.value);
        return { selected: params.value };
      case 'check':
        params.state === false ? await page.uncheck(params.selector) : await page.check(params.selector);
        return { checked: params.selector };
      case 'keyboard':
        await page.keyboard.press(params.key);
        return { pressed: params.key };
      case 'hover':
        await page.hover(params.selector);
        return { hovered: params.selector };
      case 'wait':
        await page.waitForTimeout(params.ms ?? 1000);
        return { waited: params.ms };
      case 'waitForSelector':
        await page.waitForSelector(params.selector, {
          state: params.state ?? 'visible',
          timeout: params.timeout ?? 30_000
        });
        return { found: params.selector };
      case 'waitForNavigation':
        await page.waitForLoadState(params.waitUntil ?? 'networkidle');
        return { url: page.url() };
      case 'evaluate':
        return { value: await page.evaluate(params.script) };
      case 'getText':
        return { text: await page.textContent(params.selector) };
      case 'getAttribute':
        return { value: await page.getAttribute(params.selector, params.attr) };
      case 'screenshot': {
        const opts = { type: 'png', fullPage: params.fullPage ?? false };
        const buf = params.selector
          ? await page.locator(params.selector).screenshot(opts)
          : await page.screenshot(opts);
        return { screenshot: buf.toString('base64') };
      }
      case 'getCookies':
        return { cookies: await context.cookies() };
      case 'setCookies':
        await context.addCookies(params.cookies);
        return { set: params.cookies.length };
      case 'getLocalStorage':
        return { value: await page.evaluate((k) => localStorage.getItem(k), params.key) };
      case 'solveCaptcha': {
        const { type, siteKey, action: cfAction, cdata, score, url, inject = true } = params;
        if (!type || !CAPTCHA_TYPES.includes(type)) {
          throw new Error(`solveCaptcha: "type" must be one of ${CAPTCHA_TYPES.join(', ')}`);
        }
        const pageUrl = url || page.url();
        const t0 = Date.now();

        // Cloudflare Challenge — special multi-strategy flow (wait / flaresolverr / capsolver / 2captcha)
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
      default:
        if (typeof page[action] === 'function') {
          const result = await page[action](params);
          return { result };
        }
        throw new Error(`Unknown action: "${action}"`);
    }
}

/**
 * Main execution endpoint.
 */
app.post('/execute', async (req, res) => {
  const {
    sessionId,
    ttl,
    headless = true,
    proxy = null,
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

  if (proxy !== null) {
    if (typeof proxy !== 'object' || !proxy.server || typeof proxy.server !== 'string') {
      return res.status(400).json({ ok: false, error: 'proxy must be an object with a "server" string (e.g. "http://host:port")' });
    }
  }

  if (captchaSolver !== null) {
    if (typeof captchaSolver !== 'object' || !captchaSolver.apiKey) {
      return res.status(400).json({ ok: false, error: 'captchaSolver must be an object with at least an "apiKey" string' });
    }
    if (captchaSolver.provider && !['2captcha', 'capsolver'].includes(captchaSolver.provider)) {
      return res.status(400).json({ ok: false, error: 'captchaSolver.provider must be "2captcha" or "capsolver"' });
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

/**
 * Health check endpoint.
 */
app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size }));

/**
 * List all active sessions.
 */
app.get('/sessions', (req, res) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    sessionId: id,
    ttl: s.ttl,
    url: s.page.url()
  }));
  res.json({ count: list.length, sessions: list });
});

/**
 * Get a specific session.
 */
app.get('/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, sessionId: req.params.id, url: s.page.url(), ttl: s.ttl });
});

/**
 * Delete a specific session.
 */
app.delete('/sessions/:id', async (req, res) => {
  if (!sessions.has(req.params.id)) return res.status(404).json({ ok: false, error: 'Session not found' });
  await closeSession(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Worker ready on :${PORT}`));

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

process.on('beforeExit', (code) => {
  console.error(`[FATAL] process.beforeExit code=${code}`);
});

process.on('exit', (code) => {
  console.error(`[PROCESS] exit with code ${code}`);
});

process.on('SIGTERM', () => {
  console.error('[PROCESS] SIGTERM received');
});

process.on('SIGINT', () => {
  console.error('[PROCESS] SIGINT received');
});

setInterval(() => {
  console.log(`[PROCESS] alive sessions=${sessions.size} uptime=${Math.round(process.uptime())}s`);
}, 60000);