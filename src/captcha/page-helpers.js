import { sleep } from './utils.js';
import {
  TURNSTILE, RECAPTCHA_V2, RECAPTCHA_V3, HCAPTCHA
} from './constants.js';

/**
 * Polls the context cookie jar until `cf_clearance` for `hostname` shows up,
 * or timeout. Returns the full cookie object or null on timeout.
 */
export async function waitForCloudflareCookie(context, hostname, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const hostMatches = (cookieDomain) => {
    if (!cookieDomain) return false;
    const d = cookieDomain.replace(/^\./, '');
    return hostname === d || hostname.endsWith('.' + d);
  };
  while (Date.now() < deadline) {
    const cookies = await context.cookies();
    const cf = cookies.find(c => c.name === 'cf_clearance' && hostMatches(c.domain));
    if (cf) return cf;
    await sleep(500);
  }
  return null;
}

// Selector priority lists per captcha type. We resolve them through Playwright
// locators (not page.evaluate(document.querySelector)), so patchright pierces
// both OPEN and CLOSED shadow roots — raw in-page querySelector pierces neither.
const SITEKEY_SELECTORS = {
  [TURNSTILE]: ['.cf-turnstile[data-sitekey]', 'div[data-sitekey][data-action]', '[data-sitekey]'],
  [RECAPTCHA_V2]: ['.g-recaptcha[data-sitekey]', '[data-sitekey]'],
  [RECAPTCHA_V3]: ['.g-recaptcha[data-sitekey]', '[data-sitekey]'],
  [HCAPTCHA]: ['.h-captcha[data-sitekey]', '[data-sitekey]']
};

/**
 * Auto-detect siteKey from the page's DOM for a given captcha type.
 * Returns null if nothing matches — caller should fall back to an explicit siteKey.
 * Locator-based so it sees widgets inside (open or closed) shadow roots.
 */
export async function autoDetectSiteKey(page, type) {
  const selectors = SITEKEY_SELECTORS[type];
  if (!selectors) return null;
  for (const sel of selectors) {
    const loc = page.locator(sel);
    // count() never auto-waits, so a missing preferred selector doesn't stall on a timeout.
    if (await loc.count() === 0) continue;
    const siteKey = await loc.first().getAttribute('data-sitekey');
    if (siteKey) return siteKey;
  }
  if (type === TURNSTILE) {
    // 1) explicit-render widget captured by the interceptTurnstile shim, mirrored
    //    onto a hidden DOM node (readable from the isolated evaluate world).
    const fromBridge = await page.evaluate(() => {
      const el = document.getElementById('__cf_turnstile_bridge');
      return el ? (el.getAttribute('data-sitekey') || null) : null;
    });
    if (fromBridge) return fromBridge;
    // 2) fallback: scan same-origin JS bundles for a Turnstile sitekey literal
    //    (the sitekey passed to turnstile.render() is a static string in the build).
    const fromScripts = await page.evaluate(async () => {
      const srcs = [...document.querySelectorAll('script[src]')]
        .map(s => s.src).filter(s => s.startsWith(location.origin));
      for (const u of srcs) {
        try {
          const t = await fetch(u).then(r => r.text());
          const m = t.match(/0x4[A-Za-z0-9]{8,}/);
          if (m) return m[0];
        } catch (e) { /* ignore unreachable bundle */ }
      }
      return null;
    });
    if (fromScripts) return fromScripts;
  }
  return null;
}

// Write `token` into every matching response field, then fire each widget's
// data-callback. evaluateAll runs on the locator's resolved element set, so
// (via patchright) it reaches fields/widgets inside open or closed shadow roots.
async function injectInto(page, responseSelector, widgetSelector, token) {
  await page.locator(responseSelector).evaluateAll(
    (els, t) => els.forEach(el => { el.value = t; }),
    token
  );
  await page.locator(widgetSelector).evaluateAll((els, t) => {
    els.forEach(el => {
      const cb = el.getAttribute('data-callback');
      if (cb && typeof window[cb] === 'function') {
        try { window[cb](t); } catch {}
      }
    });
  }, token);
}

/**
 * Injects a solved captcha token into the page DOM and tries to invoke the
 * registered callback so the host page proceeds normally.
 */
export async function injectCaptchaToken(page, type, token) {
  if (type === TURNSTILE) {
    await injectInto(page, '[name="cf-turnstile-response"]', '.cf-turnstile', token);
    // Explicit-render widgets deliver the token through the render() callback (no
    // data-callback attribute), which usually drives framework state. The callback
    // lives in the page MAIN world, unreachable from the isolated evaluate world, so
    // fire it via a <script> bridge that runs in the main world.
    await page.evaluate((t) => {
      const s = document.createElement('script');
      s.textContent =
        '(function(){try{var st=window.__cfTurnstile;if(st){st.token=' + JSON.stringify(t) +
        ';if(st.params&&typeof st.params.callback==="function"){st.params.callback(' + JSON.stringify(t) + ');}}}catch(e){}})();';
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    }, token);
    return;
  }
  if (type === RECAPTCHA_V2 || type === RECAPTCHA_V3) {
    await injectInto(
      page,
      '[name="g-recaptcha-response"], #g-recaptcha-response, textarea#g-recaptcha-response',
      '.g-recaptcha',
      token
    );
    return;
  }
  if (type === HCAPTCHA) {
    await injectInto(page, '[name="h-captcha-response"], [name="g-recaptcha-response"]', '.h-captcha', token);
    return;
  }
  throw new Error(`Cannot inject token for unknown captcha type: ${type}`);
}
