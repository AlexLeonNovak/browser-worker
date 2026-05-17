import { sleep } from '../utils.js';
import {
  TURNSTILE, RECAPTCHA_V2, RECAPTCHA_V3, HCAPTCHA, CLOUDFLARE_CHALLENGE
} from '../constants.js';

/**
 * Anti-Captcha — uses the same task-based v2 API shape as CapSolver but with
 * "Recaptcha" (no capital C) naming and `cData` (capital D) on Turnstile.
 * Does not return cf_clearance directly — for cloudflare-challenge use it via
 * the Turnstile-widget fallback in solveCloudflareChallenge().
 */
export class AntiCaptchaSolver {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.base = 'https://api.anti-captcha.com';
    this.name = 'anti-captcha';
  }

  async solve(type, params) {
    const taskId = await this._submit(type, params);
    return await this._poll(taskId);
  }

  async _submit(type, { siteKey, pageUrl, action, cdata, score }) {
    let task;

    if (type === TURNSTILE) {
      task = {
        type: 'TurnstileTaskProxyless',
        websiteURL: pageUrl,
        websiteKey: siteKey
      };
      if (action) task.action = action;
      if (cdata) task.cData = cdata;
    } else if (type === RECAPTCHA_V2) {
      task = {
        type: 'RecaptchaV2TaskProxyless',
        websiteURL: pageUrl,
        websiteKey: siteKey
      };
    } else if (type === RECAPTCHA_V3) {
      task = {
        type: 'RecaptchaV3TaskProxyless',
        websiteURL: pageUrl,
        websiteKey: siteKey,
        pageAction: action || 'verify',
        minScore: score != null ? parseFloat(score) : 0.3
      };
    } else if (type === HCAPTCHA) {
      task = {
        type: 'HCaptchaTaskProxyless',
        websiteURL: pageUrl,
        websiteKey: siteKey
      };
    } else if (type === CLOUDFLARE_CHALLENGE) {
      throw new Error('Anti-Captcha does not return cf_clearance directly. Use type:"turnstile" for the widget on the challenge page, or switch provider to "capsolver"/"flaresolverr".');
    } else {
      throw new Error(`Unsupported captcha type for Anti-Captcha: ${type}`);
    }

    const res = await fetch(`${this.base}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: this.apiKey, task })
    });
    const json = await res.json();
    if (json.errorId !== 0) {
      throw new Error(`Anti-Captcha createTask failed: ${json.errorDescription || json.errorCode || JSON.stringify(json)}`);
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
        throw new Error(`Anti-Captcha getTaskResult failed: ${json.errorDescription || json.errorCode || JSON.stringify(json)}`);
      }
      if (json.status === 'ready') {
        const s = json.solution || {};
        return {
          token: s.token || s.gRecaptchaResponse || null,
          userAgent: s.userAgent || null
        };
      }
    }
    throw new Error('Anti-Captcha solve timeout');
  }
}
