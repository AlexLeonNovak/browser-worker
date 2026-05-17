import express from 'express';
import { sessions } from './session/manager.js';
import registerExecuteRoute from './routes/execute.js';
import registerSessionRoutes from './routes/sessions.js';

const app = express();
app.use(express.json());

registerExecuteRoute(app);
registerSessionRoutes(app);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Worker ready on :${PORT}`));

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
