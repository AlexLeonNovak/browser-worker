const TURNSTILE = 'turnstile';
const RECAPTCHA_V2 = 'recaptcha-v2';
const RECAPTCHA_V3 = 'recaptcha-v3';
const HCAPTCHA = 'hcaptcha';
const CLOUDFLARE_CHALLENGE = 'cloudflare-challenge';

export const SUPPORTED_TYPES = [TURNSTILE, RECAPTCHA_V2, RECAPTCHA_V3, HCAPTCHA, CLOUDFLARE_CHALLENGE];

// CapSolver's AntiCloudflareTask only accepts Chrome-on-Windows UAs.
// Using this as the session default also keeps cf_clearance valid (the cookie
// is bound to the UA used during the solve).
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Converts a Playwright-style proxy object to the "ip:port[:user:pass]" string
 * format expected by CapSolver's proxy field.
 */
export function proxyToCapsolverString(p) {
  if (!p || !p.server) return null;
  try {
    const u = new URL(p.server);
    const host = u.hostname;
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (p.username && p.password) return `${host}:${port}:${p.username}:${p.password}`;
    return `${host}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Resolves captcha solver config from optional per-request body and ENV defaults.
 * Returns { provider, apiKey } — apiKey may be undefined if nothing is configured.
 */
export function resolveCaptchaConfig(bodyConfig) {
  if (bodyConfig && typeof bodyConfig === 'object' && bodyConfig.apiKey) {
    return {
      provider: bodyConfig.provider || process.env.CAPTCHA_PROVIDER || '2captcha',
      apiKey: bodyConfig.apiKey
    };
  }
  const provider = process.env.CAPTCHA_PROVIDER || '2captcha';
  const apiKey = provider === 'capsolver'
    ? process.env.CAPTCHA_API_KEY_CAPSOLVER
    : process.env.CAPTCHA_API_KEY_2CAPTCHA;
  return { provider, apiKey };
}

export function createSolver(config) {
  if (!config || !config.apiKey) return null;
  if (config.provider === '2captcha') return new TwoCaptchaSolver(config.apiKey);
  if (config.provider === 'capsolver') return new CapSolverSolver(config.apiKey);
  throw new Error(`Unknown captcha provider: ${config.provider}`);
}

class TwoCaptchaSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.base = 'https://2captcha.com';
    this.name = '2captcha';
  }

  async solve(type, params) {
    const taskId = await this._submit(type, params);
    return await this._poll(taskId);
  }

  async _submit(type, { siteKey, pageUrl, action, cdata, score }) {
    const body = new URLSearchParams({ key: this.apiKey, json: '1' });

    if (type === TURNSTILE) {
      body.set('method', 'turnstile');
      body.set('sitekey', siteKey);
      body.set('pageurl', pageUrl);
      if (action) body.set('action', action);
      if (cdata) body.set('data', cdata);
    } else if (type === RECAPTCHA_V2) {
      body.set('method', 'userrecaptcha');
      body.set('googlekey', siteKey);
      body.set('pageurl', pageUrl);
    } else if (type === RECAPTCHA_V3) {
      body.set('method', 'userrecaptcha');
      body.set('version', 'v3');
      body.set('googlekey', siteKey);
      body.set('pageurl', pageUrl);
      if (action) body.set('action', action);
      if (score != null) body.set('min_score', String(score));
    } else if (type === HCAPTCHA) {
      body.set('method', 'hcaptcha');
      body.set('sitekey', siteKey);
      body.set('pageurl', pageUrl);
    } else if (type === CLOUDFLARE_CHALLENGE) {
      throw new Error('2Captcha does not return cf_clearance directly. Use type:"turnstile" with action/cdata params, or switch provider to "capsolver".');
    } else {
      throw new Error(`Unsupported captcha type for 2Captcha: ${type}`);
    }

    const res = await fetch(`${this.base}/in.php`, { method: 'POST', body });
    const json = await res.json();
    if (json.status !== 1) {
      throw new Error(`2Captcha submit failed: ${json.request || JSON.stringify(json)}`);
    }
    return json.request;
  }

  async _poll(taskId, maxAttempts = 40, intervalMs = 5000) {
    await sleep(10000);
    for (let i = 0; i < maxAttempts; i++) {
      const res = await fetch(`${this.base}/res.php?key=${this.apiKey}&action=get&id=${taskId}&json=1`);
      const json = await res.json();
      if (json.status === 1) return { token: json.request };
      if (json.request === 'CAPCHA_NOT_READY') {
        await sleep(intervalMs);
        continue;
      }
      throw new Error(`2Captcha solve failed: ${json.request || JSON.stringify(json)}`);
    }
    throw new Error('2Captcha solve timeout');
  }
}

class CapSolverSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.base = 'https://api.capsolver.com';
    this.name = 'capsolver';
  }

  async solve(type, params) {
    const taskId = await this._submit(type, params);
    return await this._poll(taskId);
  }

  async _submit(type, { siteKey, pageUrl, action, cdata, score, proxy, userAgent, html }) {
    let task;

    if (type === TURNSTILE) {
      task = {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: siteKey
      };
      if (action || cdata) {
        task.metadata = {};
        if (action) task.metadata.action = action;
        if (cdata) task.metadata.cdata = cdata;
      }
    } else if (type === RECAPTCHA_V2) {
      task = {
        type: 'ReCaptchaV2TaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: siteKey
      };
    } else if (type === RECAPTCHA_V3) {
      task = {
        type: 'ReCaptchaV3TaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: siteKey,
        pageAction: action || 'verify',
        minScore: score != null ? parseFloat(score) : 0.3
      };
    } else if (type === HCAPTCHA) {
      task = {
        type: 'HCaptchaTaskProxyLess',
        websiteURL: pageUrl,
        websiteKey: siteKey
      };
    } else if (type === CLOUDFLARE_CHALLENGE) {
      if (!proxy) throw new Error('cloudflare-challenge requires a session proxy — set "proxy" on the session.');
      if (!userAgent) throw new Error('cloudflare-challenge requires userAgent.');
      task = {
        type: 'AntiCloudflareTask',
        websiteURL: pageUrl,
        proxy,
        userAgent
      };
      if (html) task.html = html;
    } else {
      throw new Error(`Unsupported captcha type for CapSolver: ${type}`);
    }

    const res = await fetch(`${this.base}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this.apiKey, task })
    });
    const json = await res.json();
    if (json.errorId !== 0) {
      throw new Error(`CapSolver createTask failed: ${json.errorDescription || json.errorCode || JSON.stringify(json)}`);
    }
    return json.taskId;
  }

  async _poll(taskId, maxAttempts = 40, intervalMs = 3000) {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(intervalMs);
      const res = await fetch(`${this.base}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey, taskId })
      });
      const json = await res.json();
      if (json.errorId !== 0) {
        throw new Error(`CapSolver getTaskResult failed: ${json.errorDescription || json.errorCode || JSON.stringify(json)}`);
      }
      if (json.status === 'ready') {
        const s = json.solution || {};
        return {
          token: s.token || s.gRecaptchaResponse || s.captchaToken || null,
          cookies: s.cookies || null,
          userAgent: s.userAgent || null
        };
      }
    }
    throw new Error('CapSolver solve timeout');
  }
}

/**
 * Auto-detect siteKey from the page's DOM for a given captcha type.
 * Returns null if nothing matches — caller should fall back to an explicit siteKey.
 */
export async function autoDetectSiteKey(page, type) {
  if (type === TURNSTILE) {
    return await page.evaluate(() => {
      const el = document.querySelector('.cf-turnstile[data-sitekey]')
        || document.querySelector('div[data-sitekey][data-action]')
        || document.querySelector('[data-sitekey]');
      return el ? el.getAttribute('data-sitekey') : null;
    });
  }
  if (type === RECAPTCHA_V2 || type === RECAPTCHA_V3) {
    return await page.evaluate(() => {
      const el = document.querySelector('.g-recaptcha[data-sitekey]')
        || document.querySelector('[data-sitekey]');
      return el ? el.getAttribute('data-sitekey') : null;
    });
  }
  if (type === HCAPTCHA) {
    return await page.evaluate(() => {
      const el = document.querySelector('.h-captcha[data-sitekey]')
        || document.querySelector('[data-sitekey]');
      return el ? el.getAttribute('data-sitekey') : null;
    });
  }
  return null;
}

/**
 * Injects a solved captcha token into the page DOM and tries to invoke the
 * registered callback so the host page proceeds normally.
 */
export async function injectCaptchaToken(page, type, token) {
  if (type === TURNSTILE) {
    await page.evaluate((t) => {
      document.querySelectorAll('[name="cf-turnstile-response"]').forEach(el => { el.value = t; });
      document.querySelectorAll('.cf-turnstile').forEach(el => {
        const cb = el.getAttribute('data-callback');
        if (cb && typeof window[cb] === 'function') {
          try { window[cb](t); } catch {}
        }
      });
    }, token);
    return;
  }
  if (type === RECAPTCHA_V2 || type === RECAPTCHA_V3) {
    await page.evaluate((t) => {
      document.querySelectorAll('[name="g-recaptcha-response"], #g-recaptcha-response').forEach(el => { el.value = t; });
      document.querySelectorAll('textarea#g-recaptcha-response').forEach(el => { el.value = t; });
      document.querySelectorAll('.g-recaptcha').forEach(el => {
        const cb = el.getAttribute('data-callback');
        if (cb && typeof window[cb] === 'function') {
          try { window[cb](t); } catch {}
        }
      });
    }, token);
    return;
  }
  if (type === HCAPTCHA) {
    await page.evaluate((t) => {
      document.querySelectorAll('[name="h-captcha-response"], [name="g-recaptcha-response"]').forEach(el => { el.value = t; });
      document.querySelectorAll('.h-captcha').forEach(el => {
        const cb = el.getAttribute('data-callback');
        if (cb && typeof window[cb] === 'function') {
          try { window[cb](t); } catch {}
        }
      });
    }, token);
    return;
  }
  throw new Error(`Cannot inject token for unknown captcha type: ${type}`);
}
