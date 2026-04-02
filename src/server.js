import express from 'express';
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

// Browserless WebSocket URL and token from environment
const BROWSERLESS_URL   = process.env.BROWSERLESS_URL;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const BROWSERLESS_TIMEOUT = process.env.BROWSERLESS_TIMEOUT || 600000; // 10 minutes

function getBrowserlessWsUrl() {
  if (!BROWSERLESS_URL) throw new Error('BROWSERLESS_URL not set');
  const url = new URL(BROWSERLESS_URL);
  url.searchParams.set('timeout', BROWSERLESS_TIMEOUT);
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

async function createSession(ttl = 300_000, stealth = true) {
  const wsUrl = getBrowserlessWsUrl();

  const browser = await chromium.connectOverCDP(wsUrl);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    locale: 'en-US',
  });

  if (stealth) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }

  const page = await context.newPage();
  page.on('requestfailed', req => {
    console.log('[requestfailed]', req.url(), req.failure()?.errorText);
  });

  page.on('console', msg => {
    console.log('[browser console]', msg.type(), msg.text());
  });

  page.on('response', res => {
    if (res.status() >= 400) {
      console.log('[http]', res.status(), res.url());
    }
  });
  // await page.setViewportSize({ width: 1920, height: 1080 });
  const sessionId = randomUUID();

  const sessionObj = { sessionId, browser, context, page, ttl };
  sessions.set(sessionId, sessionObj);
  resetTimer(sessionId, ttl);

  console.log(`[session:${sessionId}] created via Browserless (ttl=${ttl}ms). Active: ${sessions.size}`);
  return sessionObj;
}

async function executeStep(session, step) {
  const { action, params = {} } = step;
  const { page, context, sessionId } = session;

  console.log(`[session:${sessionId}] step: ${action}`, params);

  switch (action) {
    case 'goto':
      await page.goto(params.url, { waitUntil: params.waitUntil ?? 'domcontentloaded' });
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
      if (params.state === false) await page.uncheck(params.selector);
      else await page.check(params.selector);
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
        state:   params.state   ?? 'visible',
        timeout: params.timeout ?? 30_000,
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
      await page.setViewportSize({ width: 1920, height: 1080 });
      const opts = { type: 'png', fullPage: params.fullPage ?? false };
      const buf  = params.selector
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
      throw new Error(`Unknown action: "${action}"`);
  }
}

async function executeSteps(session, steps, stopOnError = true) {
  const results = [];
  const { sessionId } = session;

  console.log(`[session:${sessionId}] executing ${steps.length} steps (stopOnError=${stopOnError})`);
  
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    try {
      const result = await executeStep(session, step);
      results.push({
        action: step.action,
        ok: true,
        result,
      });
    } catch (err) {
      console.error(`[session:${sessionId}] step ${i} (${step.action}) failed: ${err.message}`);
      results.push({
        action: step.action,
        ok: false,
        error: err.message,
      });
      if (stopOnError) {
        console.warn(`[session:${sessionId}] stopping on error`);
        return { completed: i, results, error: err.message };
      }
    }
  }
  
  console.log(`[session:${sessionId}] completed ${steps.length} steps`);
  return { completed: steps.length, results, error: null };
}

// ── POST /execute ─────────────────────────────────────────────────────────────
app.post('/execute', async (req, res) => {
  const { sessionId, ttl = 300_000, stealth = true, steps = [], stopOnError = true } = req.body;

  console.log(`[POST /execute] request from user (sessionId=${sessionId || 'new'}, steps=${steps.length})`);

  if (!steps.length) {
    console.error(`[POST /execute] error: steps array is empty`);
    return res.status(400).json({ ok: false, error: 'steps array is required' });
  }

  let session = null;
  let created = false;

  // If sessionId provided, check if session exists
  if (sessionId) {
    session = sessions.get(sessionId);
    if (!session) {
      console.warn(`[POST /execute] session ${sessionId} not found`);
      return res.status(404).json({
        ok: false,
        error: 'Session not found or expired',
        sessionId,
      });
    }
  }

  // If no session, create a new one
  if (!session) {
    try {
      session = await createSession(ttl, stealth);
      created = true;
    } catch (err) {
      console.error(`[POST /execute] cannot create session: ${err.message}`);
      return res.status(503).json({
        ok: false,
        error: `Cannot connect to Browserless: ${err.message}`,
      });
    }
  }

  // Execute all steps
  const { completed, results, error } = await executeSteps(session, steps, stopOnError);

  // Reset TTL after execution
  resetTimer(session.sessionId, session.ttl);

  const response = {
    ok: !error,
    sessionId: session.sessionId,
    created,
    completedSteps: completed,
    totalSteps: steps.length,
    results,
    finalUrl: session.page.url(),
  };

  if (error) {
    response.error = error;
  }

  console.log(`[POST /execute] finished (ok=${!error}, steps=${completed}/${steps.length})`);
  res.status(error ? 500 : 200).json(response);
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
