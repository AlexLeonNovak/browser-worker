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

/**
 * Auto-detect siteKey from the page's DOM for a given captcha type.
 * Returns null if nothing matches — caller should fall back to an explicit siteKey.
 */
export async function autoDetectSiteKey(page, type) {
  if (type === TURNSTILE) {
    return await page.evaluate(() => {
      const el = document.querySelector('.cf-turnstile[data-sitekey]')
        || document.querySelector('div[data-sitekey][data-action]')
        || document.querySelector('[data-sitekey]');
      return el ? el.getAttribute('data-sitekey') : null;
    });
  }
  if (type === RECAPTCHA_V2 || type === RECAPTCHA_V3) {
    return await page.evaluate(() => {
      const el = document.querySelector('.g-recaptcha[data-sitekey]')
        || document.querySelector('[data-sitekey]');
      return el ? el.getAttribute('data-sitekey') : null;
    });
  }
  if (type === HCAPTCHA) {
    return await page.evaluate(() => {
      const el = document.querySelector('.h-captcha[data-sitekey]')
        || document.querySelector('[data-sitekey]');
      return el ? el.getAttribute('data-sitekey') : null;
    });
  }
  return null;
}

/**
 * Injects a solved captcha token into the page DOM and tries to invoke the
 * registered callback so the host page proceeds normally.
 */
export async function injectCaptchaToken(page, type, token) {
  if (type === TURNSTILE) {
    await page.evaluate((t) => {
      document.querySelectorAll('[name="cf-turnstile-response"]').forEach(el => { el.value = t; });
      document.querySelectorAll('.cf-turnstile').forEach(el => {
        const cb = el.getAttribute('data-callback');
        if (cb && typeof window[cb] === 'function') {
          try { window[cb](t); } catch {}
        }
      });
    }, token);
    return;
  }
  if (type === RECAPTCHA_V2 || type === RECAPTCHA_V3) {
    await page.evaluate((t) => {
      document.querySelectorAll('[name="g-recaptcha-response"], #g-recaptcha-response').forEach(el => { el.value = t; });
      document.querySelectorAll('textarea#g-recaptcha-response').forEach(el => { el.value = t; });
      document.querySelectorAll('.g-recaptcha').forEach(el => {
        const cb = el.getAttribute('data-callback');
        if (cb && typeof window[cb] === 'function') {
          try { window[cb](t); } catch {}
        }
      });
    }, token);
    return;
  }
  if (type === HCAPTCHA) {
    await page.evaluate((t) => {
      document.querySelectorAll('[name="h-captcha-response"], [name="g-recaptcha-response"]').forEach(el => { el.value = t; });
      document.querySelectorAll('.h-captcha').forEach(el => {
        const cb = el.getAttribute('data-callback');
        if (cb && typeof window[cb] === 'function') {
          try { window[cb](t); } catch {}
        }
      });
    }, token);
    return;
  }
  throw new Error(`Cannot inject token for unknown captcha type: ${type}`);
}
