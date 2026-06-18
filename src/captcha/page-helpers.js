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
