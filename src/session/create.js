import { randomUUID } from 'crypto';
import { DEFAULT_USER_AGENT } from '../captcha/index.js';
import { turnstileInterceptInit } from '../captcha/turnstile-intercept.js';
import { sessions, resetTimer } from './manager.js';
import { browserKey, acquireBrowser, releaseBrowser } from './browser-pool.js';

/**
 * Takes a browser from the pool, opens a context + page for a new session and
 * registers it in the map.
 */
export async function createSession(options = {}) {
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
    interceptTurnstile = false,
    storageState = null,
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

  // The proxy is a launch option, and part of the pool key — see browser-pool.js.
  const key = browserKey({ headless, disableSecurity, proxy });
  console.log(`[session:${sessionId}] Acquiring Google Chrome (headless=${headless}, proxy=${proxy ? proxy.server : 'none'})...`);
  const browser = await acquireBrowser(key, {
    headless,
    channel: 'chrome',
    args,
    ...(proxy ? { proxy } : {})
  });

  // Everything past the acquire must hand the browser back on failure. The pool
  // refcounts, so a leaked ref pins a whole Chrome for the life of the process.
  let context, page;
  try {
    context = await browser.newContext({
      userAgent,
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: disableSecurity,
      javaScriptEnabled: true,
      bypassCSP: disableSecurity,
      // `Upgrade-Insecure-Requests: 0` asks the browser not to auto-upgrade
      // http:// to https://. It is not a CORS-safelisted header, so sending it on
      // every request forces a preflight on cross-origin XHR and breaks any API
      // whose Access-Control-Allow-Headers does not list it — the page just sees
      // a network error. Send it only when a session actually asked for forceHttp;
      // the real downgrade is done by the route interceptor either way.
      ...(forceHttp ? { extraHTTPHeaders: { 'Upgrade-Insecure-Requests': '0' } } : {}),
      ...(storageState ? { storageState } : {})
    });

    // Must be injected before the page's own scripts run so the shim is in place
    // when the site calls turnstile.render(). addInitScript runs at document-start.
    if (interceptTurnstile) {
      await context.addInitScript(turnstileInterceptInit);
    }

    if (addCSS) {
      await context.addInitScript(({ css }) => {
        const style = document.createElement('style');
        style.textContent = css;
        document.documentElement.appendChild(style);
      }, { css: addCSS });
    }

    if (addJS) {
      await context.addInitScript((js) => {
        const script = document.createElement('script');
        script.textContent = js;
        document.documentElement.appendChild(script);
      }, addJS);
    }

    page = await context.newPage();
  } catch (err) {
    if (context) await context.close().catch(() => {});
    releaseBrowser(key);
    throw err;
  }

  // Normalize forceHttp: true = all domains, array = only these domains
  const forceHttpHosts = Array.isArray(forceHttp) ? new Set(forceHttp) : new Set();

  const sessionObj = { sessionId, browserKey: key, browser, context, page, ttl, blockAds, forceHttp, forceHttpHosts, captchaConfig, proxy, interceptTurnstile };
  sessions.set(sessionId, sessionObj);
  resetTimer(sessionId);

  console.log(`[session:${sessionId}] created`);
  return sessionObj;
}
