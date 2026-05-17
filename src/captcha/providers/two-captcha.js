import { sleep } from '../utils.js';
import {
  TURNSTILE, RECAPTCHA_V2, RECAPTCHA_V3, HCAPTCHA, CLOUDFLARE_CHALLENGE
} from '../constants.js';

export class TwoCaptchaSolver {
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
