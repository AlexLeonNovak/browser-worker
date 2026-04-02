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
  
  // Use ttl as the timeout for Browserless session
  url.searchParams.set('timeout', ttl.toString());
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
function resetTimer(sessionId, ttl) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => closeSession(sessionId), ttl);
}

/**
 * Closes the browser session and removes it from the sessions map.
 */
async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  try { await session.browser.close(); } catch (e) {}
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
  resetTimer(sessionId, ttl);

  console.log(`[session:${sessionId}] created (ttl=${ttl}, disableSecurity=${disableSecurity}, forceHttp=${forceHttp})`);
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
    case 'getContent':
      return { html: await page.content() };
    case 'screenshot':
      const buf = await page.screenshot({ fullPage: params.fullPage ?? false });
      return { screenshot: buf.toString('base64') };
    case 'click':
      await page.click(params.selector, { timeout: params.timeout ?? 30000 });
      return { clicked: params.selector };
    case 'fill':
      await page.fill(params.selector, params.value);
      return { filled: params.selector };
    case 'wait':
      await page.waitForTimeout(params.ms ?? 1000);
      return { waited: params.ms };
    case 'evaluate':
      return { value: await page.evaluate(params.script) };
    case 'getCookies':
      return { cookies: await context.cookies() };
    default:
      if (typeof page[action] === 'function') return await page[action](params);
      throw new Error(`Unknown action: "${action}"`);
  }
}

/**
 * Main execution endpoint.
 */
app.post('/execute', async (req, res) => {
  const { 
    sessionId, 
    ttl = 30000, 
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
    try {
      session = await createSession({ ttl, stealth, blockAds, forceHttp, disableSecurity });
    } catch (err) {
      return res.status(503).json({ ok: false, error: err.message });
    }
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

  resetTimer(session.sessionId, ttl);
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
