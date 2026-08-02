import { chromium } from 'patchright';

/**
 * Browser pool — one Chrome shared by every session that needs the same launch
 * config, one context per session.
 *
 * A run that logs into many accounts in sequence used to pay for a full Chrome
 * launch per account. Contexts already give the isolation that mattered
 * (separate cookie jar, storage, cache), so the browser is the part worth sharing.
 *
 * The proxy is part of the pool key rather than a context option on purpose:
 * Chromium only honours a context-level proxy when the browser was launched with
 * a global one (the `proxy: { server: 'per-context' }` idiom), and contexts that
 * then decline a proxy end up pointed at that placeholder. Keying on the proxy
 * keeps it a launch option and sidesteps the whole thing.
 *
 * Idle browsers are closed after BROWSER_IDLE_MS rather than at zero refs — a
 * sequential run closes each session before opening the next, and closing on the
 * spot would relaunch every time.
 */

const IDLE_MS = Number(process.env.BROWSER_IDLE_MS || 60000);

/** key -> { browserPromise, browser, refs, idleTimer } */
const pool = new Map();

export function browserKey({ headless, disableSecurity, proxy }) {
  return JSON.stringify({
    headless: headless !== false,
    disableSecurity: !!disableSecurity,
    proxy: proxy || null
  });
}

export async function acquireBrowser(key, launchOptions) {
  let entry = pool.get(key);

  if (!entry) {
    entry = { refs: 0, idleTimer: null, browser: null, browserPromise: null };
    pool.set(key, entry);
    // Assigned before the first await so concurrent acquires share one launch.
    entry.browserPromise = chromium.launch(launchOptions).then((browser) => {
      entry.browser = browser;
      browser.on('disconnected', () => {
        if (pool.get(key) !== entry) return;
        clearTimeout(entry.idleTimer);
        pool.delete(key);
        console.log(`[pool] browser disconnected — dropped (${pool.size} in pool)`);
      });
      console.log(`[pool] launched browser (${pool.size} in pool)`);
      return browser;
    }).catch((err) => {
      if (pool.get(key) === entry) pool.delete(key);
      throw err;
    });
  }

  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  entry.refs++;

  try {
    return await entry.browserPromise;
  } catch (err) {
    entry.refs--;
    throw err;
  }
}

export function releaseBrowser(key) {
  const entry = pool.get(key);
  if (!entry) return;

  entry.refs--;
  if (entry.refs > 0) return;

  entry.idleTimer = setTimeout(() => {
    if (pool.get(key) === entry) pool.delete(key);
    entry.browser?.close().catch(() => {});
    console.log(`[pool] idle browser closed (${pool.size} in pool)`);
  }, IDLE_MS);
  // Must not hold the process open on shutdown.
  entry.idleTimer.unref?.();
}

export async function closeAllBrowsers() {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.all(entries.map(async (entry) => {
    clearTimeout(entry.idleTimer);
    const browser = entry.browser ?? await entry.browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
  }));
}

export const poolSize = () => pool.size;
