import { setupRoutes } from './route-interceptor.js';
import { solveCaptchaAction } from './solve-captcha-action.js';

/**
 * Dispatches a single step to the matching browser action.
 * Unknown action names fall through to page[action] if such a method exists.
 */
export async function executeStep(session, step) {
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
    case 'solveCaptcha':
      return await solveCaptchaAction(session, params);
    default:
      if (typeof page[action] === 'function') {
        const result = await page[action](params);
        return { result };
      }
      throw new Error(`Unknown action: "${action}"`);
  }
}
