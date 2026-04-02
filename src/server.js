import express from 'express';
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const BROWSERLESS_URL   = process.env.BROWSERLESS_URL;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

/**
 * Constructs the Browserless WebSocket URL with provided options.
 */
function getBrowserlessWsUrl(options = {}) {
  if (!BROWSERLESS_URL) throw new Error('BROWSERLESS_URL not set');
  const url = new URL(BROWSERLESS_URL);
  
  const { blockAds = false, stealth = true, disableSecurity = false, ttl = 30000 } = options;
  
  // To support session extension, we set a high timeout on Browserless side (e.g., 1 hour).
  // The worker will manage the actual lifecycle and call browser.close() explicitly.
  const browserlessTimeout = Math.max(ttl, 3600000); // Minimum 1 hour buffer
  
  url.searchParams.set('timeout', browserlessTimeout.toString());
  url.searchParams.set('blockAds', blockAds.toString());
  
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox'
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
  
  const launchArgs = { stealth, args };
  url.searchParams.set('launch', JSON.stringify(launchArgs));
  
  if (BROWSERLESS_TOKEN) url.searchParams.set('token', BROWSERLESS_TOKEN);
  return url.toString();
}

// session id -> { sessionId, browser, context, page, ttl, timer }
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
  clearTimeout(session.timer);
  try { 
    // Explicitly closing the browser tells Browserless to release resources immediately
    await session.browser.close(); 
  } catch (e) {}
  sessions.delete(sessionId);
  console.log(`[session:${sessionId}] closed`);
}

/**
 * Creates a new browser session.
 */
async function createSession(options = {}) {
  const { ttl = 30000, stealth = true, blockAds = false, forceHttp = false, disableSecurity = false } = options;
  const wsUrl = getBrowserlessWsUrl({ stealth, blockAds, disableSecurity, ttl });

  const browser = await chromium.connectOverCDP(wsUrl);
  
  // If the browser process is killed externally (e.g. by Browserless timeout)
  browser.on('disconnected', () => {
    if (sessions.has(sessionId)) {
      console.warn(`[session:${sessionId}] Browser disconnected unexpectedly`);
      sessions.delete(sessionId);
    }
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: disableSecurity,
    javaScriptEnabled: true,
    bypassCSP: disableSecurity,
    extraHTTPHeaders: { 'Upgrade-Insecure-Requests': '0' }
  });

  if (forceHttp) {
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('https://')) {
        const httpUrl = url.replace('https://', 'http://');
        try {
          const response = await route.fetch({ url: httpUrl });
          await route.fulfill({ response });
          return;
        } catch (e) {}
      }
      route.continue();
    });
  }

  if (stealth) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });
  }

  const page = await context.newPage();
  const sessionId = randomUUID();
  const sessionObj = { sessionId, browser, context, page, ttl };
  sessions.set(sessionId, sessionObj);
  resetTimer(sessionId);

  console.log(`[session:${sessionId}] created (ttl=${ttl}ms, disableSecurity=${disableSecurity}, forceHttp=${forceHttp})`);
  return sessionObj;
}

/**
 * Executes a single step in the browser.
 */
async function executeStep(session, step) {
  const { action, params = {} } = step;
  const { page, context, sessionId } = session;
  console.log(`[session:${sessionId}] action: ${action}`, params);

  switch (action) {
    case 'goto':
      await page.goto(params.url, { waitUntil: params.waitUntil ?? 'domcontentloaded', timeout: params.timeout ?? 60000 });
      return { url: page.url() };
    case 'reload':
      await page.reload({ waitUntil: params.waitUntil ?? 'domcontentloaded' });
      return { url: page.url() };
    case 'getUrl':
      return { url: page.url() };
    case 'getContent':
      return { html: await page.content() };
    case 'click':
      await page.click(params.selector, { timeout: params.timeout ?? 30_000 });
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
    stealth = true, 
    blockAds = false, 
    forceHttp = false, 
    disableSecurity = false, 
    steps = [], 
    stopOnError = true 
  } = req.body;

  if (!steps.length) return res.status(400).json({ ok: false, error: 'steps required' });

  let session = sessionId ? sessions.get(sessionId) : null;
  if (sessionId && !session) return res.status(404).json({ ok: false, error: 'Session expired' });

  if (!session) {
    const sessionTtl = ttl || 30000;
    try {
      session = await createSession({ ttl: sessionTtl, stealth, blockAds, forceHttp, disableSecurity });
    } catch (err) {
      return res.status(503).json({ ok: false, error: err.message });
    }
  } else if (ttl) {
    session.ttl = ttl;
    console.log(`[session:${session.sessionId}] TTL updated to ${ttl}ms`);
  }

  const results = [];
  let error = null;
  for (const step of steps) {
    try {
      const result = await executeStep(session, step);
      results.push({ action: step.action, ok: true, result });
    } catch (e) {
      results.push({ action: step.action, ok: false, error: e.message });
      error = e.message;
      if (stopOnError) break;
    }
  }

  resetTimer(session.sessionId);
  res.json({ ok: !error, sessionId: session.sessionId, results, finalUrl: session.page.url() });
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
