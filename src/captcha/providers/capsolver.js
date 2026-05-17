import { sleep } from '../utils.js';
import {
  TURNSTILE, RECAPTCHA_V2, RECAPTCHA_V3, HCAPTCHA, CLOUDFLARE_CHALLENGE
} from '../constants.js';

export class CapSolverSolver {
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
