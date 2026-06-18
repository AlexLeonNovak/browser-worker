import { chromium } from 'patchright';
import { randomUUID } from 'crypto';
import { DEFAULT_USER_AGENT } from '../captcha/index.js';
import { turnstileInterceptInit } from '../captcha/turnstile-intercept.js';
import { sessions, resetTimer } from './manager.js';

/**
 * Launches a Chrome browser + context for a new session and registers it in the map.
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

  const page = await context.newPage();

  // Normalize forceHttp: true = all domains, array = only these domains
  const forceHttpHosts = Array.isArray(forceHttp) ? new Set(forceHttp) : new Set();

  const sessionObj = { sessionId, browser, context, page, ttl, blockAds, forceHttp, forceHttpHosts, captchaConfig, proxy, interceptTurnstile };
  sessions.set(sessionId, sessionObj);
  resetTimer(sessionId);

  console.log(`[session:${sessionId}] created`);
  return sessionObj;
}
