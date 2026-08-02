import express from 'express';
import { sessions, closeAllSessions } from './session/manager.js';
import { closeAllBrowsers, poolSize } from './session/browser-pool.js';
import { createAuthMiddleware } from './auth.js';
import registerExecuteRoute from './routes/execute.js';
import registerSessionRoutes from './routes/sessions.js';

const app = express();
app.use(express.json());
app.use(createAuthMiddleware());

registerExecuteRoute(app);
registerSessionRoutes(app);

const PORT = process.env.PORT || 3001;
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 15000);

const server = app.listen(PORT, () => {
  const mask = (v) => v ? 'configured' : '—';
  console.log(`Worker ready on :${PORT}`);
  if (!process.env.WORKER_TOKEN) {
    console.warn('!'.repeat(72));
    console.warn('! WORKER_TOKEN is not set — the API is UNAUTHENTICATED.');
    console.warn('! /execute runs arbitrary JS and arbitrary fetch inside the browser,');
    console.warn('! with its cookie jar and its proxy. Set WORKER_TOKEN before exposing this.');
    console.warn('!'.repeat(72));
  }
  console.log(`[env] WORKER_TOKEN=${mask(process.env.WORKER_TOKEN)}`);
  console.log(`[env] MAX_SESSIONS=${process.env.MAX_SESSIONS || '5 (default)'}`);
  console.log(`[env] BROWSER_IDLE_MS=${process.env.BROWSER_IDLE_MS || '60000 (default)'}`);
  console.log(`[env] PROXY_SERVER=${process.env.PROXY_SERVER || '—'}`);
  console.log(`[env] PROXY_USERNAME=${process.env.PROXY_USERNAME ? '(set)' : '—'}`);
  console.log(`[env] PROXY_PASSWORD=${process.env.PROXY_PASSWORD ? '(set)' : '—'}`);
  console.log(`[env] FLARESOLVERR_URL=${process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191 (default)'}`);
  console.log(`[env] CAPTCHA_PROVIDER=${process.env.CAPTCHA_PROVIDER || '2captcha (default)'}`);
  console.log(`[env] CAPTCHA_API_KEY_2CAPTCHA=${mask(process.env.CAPTCHA_API_KEY_2CAPTCHA)}`);
  console.log(`[env] CAPTCHA_API_KEY_CAPSOLVER=${mask(process.env.CAPTCHA_API_KEY_CAPSOLVER)}`);
  console.log(`[env] CAPTCHA_API_KEY_ANTI_CAPTCHA=${mask(process.env.CAPTCHA_API_KEY_ANTI_CAPTCHA)}`);
});

const heartbeat = setInterval(() => {
  console.log(`[PROCESS] alive sessions=${sessions.size} browsers=${poolSize()} uptime=${Math.round(process.uptime())}s`);
}, 60000);

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

process.on('exit', (code) => {
  console.error(`[PROCESS] exit with code ${code}`);
});

/**
 * Redeploys are routine on an always-on deployment, and a long job holds one
 * session across many calls. Stop accepting, let in-flight steps finish, then tear
 * down — so the caller sees a completed step list rather than a severed socket.
 */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    console.error(`[PROCESS] ${signal} again — exiting now`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[PROCESS] ${signal} received — draining (grace ${SHUTDOWN_GRACE_MS}ms)`);

  clearInterval(heartbeat);
  server.close();

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < deadline && [...sessions.values()].some((s) => s.busy)) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const stillBusy = [...sessions.values()].filter((s) => s.busy).length;
  if (stillBusy) console.warn(`[PROCESS] grace expired with ${stillBusy} busy session(s) — closing anyway`);

  await closeAllSessions();
  await closeAllBrowsers();
  console.log('[PROCESS] drained — bye');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
