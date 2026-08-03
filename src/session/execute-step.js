import { setupRoutes } from './route-interceptor.js';
import { solveCaptchaAction } from './solve-captcha-action.js';
import { httpRequestAction } from './http-request-action.js';
import { armCapture, getCaptured } from './request-capture.js';

/**
 * Dispatches a single step to the matching browser action.
 * Unknown action names fall through to page[action] if such a method exists.
 */
export async function executeStep(session, step) {
  const { action, params = {} } = step;
  const { page, context } = session;

  switch (action) {
    case 'goto': {
      let targetUrl;
      try {
        targetUrl = new URL(params.url);
      } catch {
        // Throw rather than return an { error } object: the runner marks a step
        // failed only when it throws (routes/execute.js), so a returned error
        // reads as ok:true, slips past stopOnError, and the remaining steps run
        // against about:blank.
        throw new Error(`Invalid URL: ${params.url}`);
      }
      // Auto-detect: if URL uses http://, add hostname to forceHttpHosts
      if (targetUrl.protocol === 'http:') {
        session.forceHttpHosts.add(targetUrl.hostname.toLowerCase());
      }
      // Deliberately outside the try above: a route-interception failure is not a
      // bad URL, and it must surface as a failed step rather than be relabelled.
      await setupRoutes(session);
      await page.goto(params.url, { waitUntil: params.waitUntil ?? 'domcontentloaded', timeout: params.timeout ?? 3600000 });
      return { url: page.url() };
    }
    case 'reload':
      await page.reload({ waitUntil: params.waitUntil ?? 'domcontentloaded' });
      return { url: page.url() };
    case 'getUrl':
      return { url: page.url() };
    case 'getContent': {
      if (!params.shadow) return { html: await page.content() };
      // shadow:true — serialize open shadow roots inline as declarative shadow DOM
      // (<template shadowrootmode>). Closed roots are invisible to page-side JS and
      // are NOT included unless pierceShadow force-opens them; patchright's
      // locator-level closed-root piercing does not apply to this in-page serialize.
      const html = await page.evaluate(() => {
        const collect = (root) => {
          const roots = [];
          const walk = (node) => {
            const els = node.querySelectorAll ? node.querySelectorAll('*') : [];
            for (const el of els) {
              if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
            }
          };
          walk(root);
          return roots;
        };
        const doc = document.documentElement;
        // Native getHTML (Chrome 125+) serializes the passed shadow roots correctly,
        // including nested ones, as <template shadowrootmode="open">.
        if (typeof doc.getHTML === 'function') {
          return '<!DOCTYPE html>\n' + doc.getHTML({ shadowRoots: collect(document) });
        }
        // Fallback for older engines: manual recursive serialization (open roots only).
        const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const serChildren = (node) => {
          let out = '';
          for (const child of node.childNodes) {
            if (child.nodeType === 3) out += esc(child.nodeValue);
            else if (child.nodeType === 8) out += '<!--' + child.nodeValue + '-->';
            else if (child.nodeType === 1) out += serEl(child);
          }
          return out;
        };
        const serEl = (el) => {
          const tag = el.localName;
          let attrs = '';
          for (const a of el.attributes) attrs += ' ' + a.name + '="' + esc(a.value) + '"';
          let out = '<' + tag + attrs + '>';
          if (el.shadowRoot) out += '<template shadowrootmode="open">' + serChildren(el.shadowRoot) + '</template>';
          if (VOID.has(tag)) return out;
          return out + serChildren(el) + '</' + tag + '>';
        };
        return '<!DOCTYPE html>\n' + serEl(doc);
      });
      return { html };
    }
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
    case 'getSessionStorage':
      // storageState never carries sessionStorage — Playwright does not serialize
      // it — so a site that keeps its token there needs this exported separately.
      // Storage is per-origin: run this only once the page is ON that origin.
      return { value: await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]))) };
    case 'setSessionStorage':
      await page.evaluate((d) => { for (const k of Object.keys(d)) sessionStorage.setItem(k, d[k]); }, params.value ?? {});
      return { set: Object.keys(params.value ?? {}).length };
    case 'getStorageState':
      // Cookies + localStorage, and indexedDB on request. sessionStorage is never
      // included — Playwright does not serialize it.
      return { storageState: await context.storageState(params.indexedDB ? { indexedDB: true } : undefined) };
    case 'captureRequests':
      return armCapture(session, params);
    case 'getCapturedRequests':
      return getCaptured(session);
    case 'solveCaptcha':
      return await solveCaptchaAction(session, params);
    case 'httpRequest':
      return await httpRequestAction(session, params);
    default:
      if (typeof page[action] === 'function') {
        const result = await page[action](params);
        return { result };
      }
      throw new Error(`Unknown action: "${action}"`);
  }
}
