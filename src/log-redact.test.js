import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { summarize, safeUrl, scrub } from './log-redact.js';

// What console.log would actually print for the summary.
const printed = (v) => inspect(v, { depth: 10 });

describe('summarize — step params', () => {
  it('keeps the selector of a fill but never its value', () => {
    const out = printed(summarize({ selector: 'input[type="password"]', value: 'hunter2pw' }));
    assert.match(out, /input\[type="password"\]/);
    assert.doesNotMatch(out, /hunter2pw/);
  });

  it('hides type text', () => {
    assert.doesNotMatch(printed(summarize({ selector: '#pw', text: 'typed-secret' })), /typed-secret/);
  });

  it('hides httpRequest headers and body, keeps method and url path', () => {
    const out = printed(summarize({
      url: 'https://api.example.com/v1/messages?page=2',
      method: 'POST',
      headers: { authorization: 'Bearer abc.def.ghi', 'x-client-id': 'xyz-123' },
      body: { password: 'body-secret' }
    }));
    assert.match(out, /POST/);
    assert.match(out, /api\.example\.com\/v1\/messages/);
    for (const s of ['abc.def.ghi', 'xyz-123', 'body-secret']) assert.doesNotMatch(out, new RegExp(s));
  });

  it('hides cookies, storage and evaluate scripts', () => {
    const out = printed(summarize({
      cookies: [{ name: 'sid', value: 'cookie-secret' }],
      value: { token: 'session-secret' },
      script: 'localStorage.setItem("t", "script-secret")'
    }));
    for (const s of ['cookie-secret', 'session-secret', 'script-secret']) assert.doesNotMatch(out, new RegExp(s));
  });

  it('keeps numbers and booleans, which carry no secret and help debugging', () => {
    assert.deepEqual(summarize({ ms: 500, state: false, timeout: 1000 }), { ms: 500, state: false, timeout: 1000 });
  });

  it('passes non-objects through without throwing', () => {
    assert.equal(summarize(undefined), undefined);
    assert.equal(summarize(null), null);
    assert.equal(summarize('a-bare-string-result'), '<string 20>');
  });
});

describe('summarize — step results', () => {
  it('hides captured request headers (bearer + client id)', () => {
    const out = printed(summarize({
      requests: [{ url: 'https://x', method: 'GET', headers: { authorization: 'Bearer captured-token', 'x-client-id': 'captured-id' } }]
    }));
    assert.doesNotMatch(out, /captured-token|captured-id/);
    assert.match(out, /array 1/);
  });

  it('hides storageState, cookies, html and screenshots', () => {
    const out = printed(summarize({
      storageState: { cookies: [{ value: 'ss-secret' }] },
      cookies: [{ value: 'c-secret' }],
      html: '<html>page</html>',
      screenshot: 'iVBORw0KGgo-base64'
    }));
    for (const s of ['ss-secret', 'c-secret', 'page', 'iVBORw0KGgo']) assert.doesNotMatch(out, new RegExp(s));
  });

  it('keeps the harmless result fields of click / goto / httpRequest', () => {
    assert.deepEqual(summarize({ clicked: '#login' }), { clicked: '#login' });
    assert.deepEqual(summarize({ url: 'https://app.example.com/home' }), { url: 'https://app.example.com/home' });
    const r = summarize({ status: 200, ok: true, headers: { 'set-cookie': 'h-secret' }, body: 'b-secret' });
    assert.equal(r.status, 200);
    assert.doesNotMatch(printed(r), /h-secret|b-secret/);
  });
});

describe('summarize — createSession options', () => {
  it('hides proxy credentials, the captcha api key and storageState', () => {
    const out = printed(summarize({
      ttl: 30000,
      headless: true,
      proxy: { server: 'http://proxy:8080', username: 'puser', password: 'proxy-secret' },
      captchaConfig: { provider: '2captcha', apiKey: 'captcha-key-secret' },
      storageState: { cookies: [{ value: 'restored-cookie' }] },
      addJS: 'window.k = "js-secret"'
    }));
    assert.match(out, /30000/);
    for (const s of ['proxy-secret', 'puser', 'captcha-key-secret', 'restored-cookie', 'js-secret']) {
      assert.doesNotMatch(out, new RegExp(s));
    }
  });
});

describe('safeUrl', () => {
  it('drops the query string and fragment', () => {
    const u = safeUrl('https://x.io/a/b?token=s3cr3t&x=1#access_token=frag');
    assert.equal(u, 'https://x.io/a/b?…');
    assert.doesNotMatch(u, /s3cr3t|frag/);
  });

  it('drops user:password from the authority', () => {
    assert.equal(safeUrl('http://user:pw-secret@proxy.io:8080'), 'http://***@proxy.io:8080');
  });

  it('leaves a plain url untouched and never throws on odd input', () => {
    assert.equal(safeUrl('https://x.io/a'), 'https://x.io/a');
    assert.equal(safeUrl('not a url'), 'not a url');
    assert.equal(safeUrl(42), '<number>');
  });
});

describe('scrub', () => {
  it('removes every string the step was given from an error message', () => {
    const msg = 'page.fill: Timeout\n  - fill("hunter2pw") on input[type="password"]';
    const out = scrub(msg, { selector: 'zz-not-in-msg', value: 'hunter2pw' });
    assert.doesNotMatch(out, /hunter2pw/);
    assert.match(out, /\[redacted\]/);
  });

  it('reaches nested values such as header values', () => {
    const out = scrub('failed with Bearer tok-999', { headers: { authorization: 'Bearer tok-999' } });
    assert.doesNotMatch(out, /tok-999/);
  });

  it('keeps values shorter than 4 chars, which would shred the message', () => {
    assert.equal(scrub('state: on', { value: 'on' }), 'state: on');
  });

  it('copes with no params and non-string messages', () => {
    assert.equal(scrub('plain', undefined), 'plain');
    assert.equal(scrub(undefined, { value: 'abcd' }), undefined);
  });
});

describe('call sites', () => {
  // Pins the wiring: the leak was a console.log handing a raw object to the log.
  it('never logs raw step params, step results or session options', async () => {
    const { readFile } = await import('node:fs/promises');
    const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
    const execute = await read('./routes/execute.js');
    const create = await read('./session/create.js');
    assert.match(execute, /summarize\(step\.params\)/);
    assert.match(execute, /summarize\(result\)/);
    assert.match(execute, /scrub\(e\.message, step\.params\)/);
    assert.match(create, /summarize\(options\)/);
    const rawLog = /console\.(log|warn|error)\([^;]*,\s*(step\.params|result|options)\);/;
    assert.doesNotMatch(execute, rawLog);
    assert.doesNotMatch(create, rawLog);
  });
});
