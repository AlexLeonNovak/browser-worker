import express from 'express';
import { sessions } from './session/manager.js';
import registerExecuteRoute from './routes/execute.js';
import registerSessionRoutes from './routes/sessions.js';

const app = express();
app.use(express.json());

registerExecuteRoute(app);
registerSessionRoutes(app);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  const mask = (v) => v ? 'configured' : '—';
  console.log(`Worker ready on :${PORT}`);
  console.log(`[env] PROXY_SERVER=${process.env.PROXY_SERVER || '—'}`);
  console.log(`[env] PROXY_USERNAME=${process.env.PROXY_USERNAME ? '(set)' : '—'}`);
  console.log(`[env] PROXY_PASSWORD=${process.env.PROXY_PASSWORD ? '(set)' : '—'}`);
  console.log(`[env] FLARESOLVERR_URL=${process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191 (default)'}`);
  console.log(`[env] CAPTCHA_PROVIDER=${process.env.CAPTCHA_PROVIDER || '2captcha (default)'}`);
  console.log(`[env] CAPTCHA_API_KEY_2CAPTCHA=${mask(process.env.CAPTCHA_API_KEY_2CAPTCHA)}`);
  console.log(`[env] CAPTCHA_API_KEY_CAPSOLVER=${mask(process.env.CAPTCHA_API_KEY_CAPSOLVER)}`);
  console.log(`[env] CAPTCHA_API_KEY_ANTI_CAPTCHA=${mask(process.env.CAPTCHA_API_KEY_ANTI_CAPTCHA)}`);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

process.on('beforeExit', (code) => {
  console.error(`[FATAL] process.beforeExit code=${code}`);
});

process.on('exit', (code) => {
  console.error(`[PROCESS] exit with code ${code}`);
});

process.on('SIGTERM', () => {
  console.error('[PROCESS] SIGTERM received');
});

process.on('SIGINT', () => {
  console.error('[PROCESS] SIGINT received');
});

setInterval(() => {
  console.log(`[PROCESS] alive sessions=${sessions.size} uptime=${Math.round(process.uptime())}s`);
}, 60000);
