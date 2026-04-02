import express from 'express';
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

// Browserless WebSocket endpoint from env
const BROWSERLESS_URL   = process.env.BROWSERLESS_URL;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

function getBrowserlessWsUrl() {
  if (!BROWSERLESS_URL) throw new Error('BROWSERLESS_URL not set');
  const url = new URL(BROWSERLESS_URL);
  if (BROWSERLESS_TOKEN) url.searchParams.set('token', BROWSERLESS_TOKEN);
  return url.toString();
}

// sessionId → { browser, context, page, ttl, timer }
const sessions = new Map();

function resetTimer(sessionId, ttl) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(async () => {
    console.log(`[session:${sessionId}] TTL expired`);
    await closeSession(sessionId);
  }, ttl);
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  clearTimeout(session.timer);
  try { await session.browser.close(); } catch {}
  sessions.delete(sessionId);
  console.log(`[session:${sessionId}] closed. Active: ${sessions.size}`);
}

// ── POST /sessions ────────────────────────────────────────────────────────────
app.post('/sessions', async (req, res) => {
  const ttl    = req.body.ttl    ?? 300_000;
  const stealth = req.body.stealth ?? true;

  try {
    const wsUrl = getBrowserlessWsUrl();

    // Connect to Browserless via CDP — browser runs in Browserless
    const browser = await chromium.connectOverCDP(wsUrl);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    if (stealth) {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
    }

    const page      = await context.newPage();
    const sessionId = randomUUID();

    sessions.set(sessionId, { browser, context, page, ttl });
    resetTimer(sessionId, ttl);

    console.log(`[session:${sessionId}] created via Browserless (ttl=${ttl}ms). Active: ${sessions.size}`);
    res.status(201).json({ sessionId, createdAt: new Date().toISOString(), ttl });

  } catch (err) {
    console.error('Failed to connect to Browserless:', err.message);
    res.status(503).json({ ok: false, error: `Cannot connect to Browserless: ${err.message}` });
  }
});

// ── POST /sessions/:id/step ───────────────────────────────────────────────────
app.post('/sessions/:id/step', async (req, res) => {
  const { id } = req.params;
  const { action, params = {}, resetTtl = true } = req.body;
  const session = sessions.get(id);

  if (!session) return res.status(404).json({ ok: false, error: 'Session not found or expired' });

  const { page } = session;
  if (resetTtl) resetTimer(id, session.ttl);

  try {
    let result;
    switch (action) {
      case 'goto':
        await page.goto(params.url, { waitUntil: params.waitUntil ?? 'domcontentloaded' });
        result = { url: page.url() };
        break;
      case 'reload':
        await page.reload({ waitUntil: params.waitUntil ?? 'domcontentloaded' });
        result = { url: page.url() };
        break;
      case 'getUrl':
        result = { url: page.url() };
        break;
      case 'getContent':
        result = { html: await page.content() };
        break;
      case 'click':
        await page.click(params.selector, { timeout: params.timeout ?? 30_000 });
        result = { clicked: params.selector };
        break;
      case 'fill':
        await page.fill(params.selector, params.value);
        result = { filled: params.selector };
        break;
      case 'type':
        await page.type(params.selector, params.text, { delay: params.delay ?? 30 });
        result = { typed: params.selector };
        break;
      case 'select':
        await page.selectOption(params.selector, params.value);
        result = { selected: params.value };
        break;
      case 'check':
        if (params.state === false) await page.uncheck(params.selector);
        else await page.check(params.selector);
        result = { checked: params.selector };
        break;
      case 'keyboard':
        await page.keyboard.press(params.key);
        result = { pressed: params.key };
        break;
      case 'hover':
        await page.hover(params.selector);
        result = { hovered: params.selector };
        break;
      case 'wait':
        await page.waitForTimeout(params.ms ?? 1000);
        result = { waited: params.ms };
        break;
      case 'waitForSelector':
        await page.waitForSelector(params.selector, {
          state:   params.state   ?? 'visible',
          timeout: params.timeout ?? 30_000,
        });
        result = { found: params.selector };
        break;
      case 'waitForNavigation':
        await page.waitForLoadState(params.waitUntil ?? 'networkidle');
        result = { url: page.url() };
        break;
      case 'evaluate':
        result = { value: await page.evaluate(params.script) };
        break;
      case 'getText':
        result = { text: await page.textContent(params.selector) };
        break;
      case 'getAttribute':
        result = { value: await page.getAttribute(params.selector, params.attr) };
        break;
      case 'screenshot': {
        const opts = { type: 'png', fullPage: params.fullPage ?? false };
        const buf  = params.selector
          ? await page.locator(params.selector).screenshot(opts)
          : await page.screenshot(opts);
        result = { screenshot: buf.toString('base64') };
        break;
      }
      case 'getCookies':
        result = { cookies: await session.context.cookies() };
        break;
      case 'setCookies':
        await session.context.addCookies(params.cookies);
        result = { set: params.cookies.length };
        break;
      case 'getLocalStorage':
        result = { value: await page.evaluate((k) => localStorage.getItem(k), params.key) };
        break;
      default:
        return res.status(400).json({ ok: false, error: `Unknown action: "${action}"` });
    }
    res.json({ ok: true, action, result });
  } catch (err) {
    console.error(`[session:${id}] action="${action}" error:`, err.message);
    res.status(500).json({ ok: false, action, error: err.message });
  }
});

// ── POST /sessions/:id/extend ─────────────────────────────────────────────────
app.post('/sessions/:id/extend', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
  const newTtl = req.body.ttl ?? session.ttl;
  session.ttl  = newTtl;
  resetTimer(req.params.id, newTtl);
  res.json({ ok: true, sessionId: req.params.id, ttl: newTtl });
});

// ── GET /sessions ─────────────────────────────────────────────────────────────
app.get('/sessions', (req, res) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    sessionId: id, ttl: s.ttl, url: s.page.url(),
  }));
  res.json({ count: list.length, sessions: list });
});

// ── GET /sessions/:id ─────────────────────────────────────────────────────────
app.get('/sessions/:id', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, sessionId: req.params.id, url: s.page.url(), ttl: s.ttl });
});

// ── DELETE /sessions/:id ──────────────────────────────────────────────────────
app.delete('/sessions/:id', async (req, res) => {
  if (!sessions.has(req.params.id)) return res.status(404).json({ ok: false, error: 'Session not found' });
  await closeSession(req.params.id);
  res.json({ ok: true, closed: req.params.id });
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    activeSessions: sessions.size,
    browserless: BROWSERLESS_URL ?? 'not configured',
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`browser-worker :${PORT} → Browserless: ${BROWSERLESS_URL ?? '⚠️  BROWSERLESS_URL not set'}`)
);
