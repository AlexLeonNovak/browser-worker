import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeStep } from './execute-step.js';

/**
 * Minimal stand-in for a session. `goto` / `setContent` only touch the matching
 * page method, forceHttpHosts, and the route interceptor (which no-ops when
 * neither ad-blocking nor forceHttp is on). `calls.order` records the sequence.
 */
function fakeSession() {
  const calls = { goto: [], setContent: [], order: [] };
  return {
    sessionId: 'test',
    forceHttp: false,
    blockAds: false,
    forceHttpHosts: new Set(),
    context: { unroute: async () => {}, route: async () => { calls.order.push('route'); } },
    page: {
      goto: async (url) => { calls.goto.push(url); calls.order.push(`goto:${url}`); },
      setContent: async (html, opts) => { calls.setContent.push({ html, opts }); calls.order.push('setContent'); },
      url: () => calls.goto.at(-1) ?? 'about:blank'
    },
    calls
  };
}

describe('executeStep — goto', () => {

  it('navigates and reports the resulting url', async () => {
    const s = fakeSession();
    const r = await executeStep(s, { action: 'goto', params: { url: 'https://example.com' } });
    assert.deepEqual(r, { url: 'https://example.com' });
    assert.deepEqual(s.calls.goto, ['https://example.com']);
  });

  // The runner only marks a step failed when it throws. Returning an { error }
  // object instead made a bad navigation read as ok:true, so stopOnError never
  // fired and later steps ran against about:blank.
  it('THROWS on an invalid url rather than returning an error object', async () => {
    const s = fakeSession();
    await assert.rejects(
      () => executeStep(s, { action: 'goto', params: { url: 'not-a-url' } }),
      /Invalid URL: not-a-url/
    );
    assert.deepEqual(s.calls.goto, [], 'must not navigate when the url is rejected');
  });

  it('throws when url is missing entirely', async () => {
    const s = fakeSession();
    await assert.rejects(
      () => executeStep(s, { action: 'goto', params: {} }),
      /Invalid URL/
    );
  });

  it('registers an http:// host for the forceHttp downgrade list', async () => {
    const s = fakeSession();
    await executeStep(s, { action: 'goto', params: { url: 'http://Legacy.Example.COM/page' } });
    assert.ok(s.forceHttpHosts.has('legacy.example.com'));
  });

  it('does not register an https:// host', async () => {
    const s = fakeSession();
    await executeStep(s, { action: 'goto', params: { url: 'https://example.com' } });
    assert.equal(s.forceHttpHosts.size, 0);
  });

  // setupRoutes failing is not a bad URL; it must surface as a failed step and
  // keep its own message instead of being relabelled "Invalid URL".
  it('propagates a route-interception failure unchanged', async () => {
    const s = fakeSession();
    s.blockAds = true; // makes setupRoutes actually touch context.route
    s.context.route = async () => { throw new Error('route table exploded'); };
    await assert.rejects(
      () => executeStep(s, { action: 'goto', params: { url: 'https://example.com' } }),
      /route table exploded/
    );
  });
});

describe('executeStep — setContent', () => {

  it('loads the html and reports its size in bytes, not characters', async () => {
    const s = fakeSession();
    const html = '<p>héllo</p>'; // é is two bytes in UTF-8
    const r = await executeStep(s, { action: 'setContent', params: { html } });
    assert.deepEqual(r, { bytes: 13 });
    assert.equal(s.calls.setContent[0].html, html);
  });

  it('defaults to waitUntil "load" and a 30 s timeout, not goto\'s hour', async () => {
    const s = fakeSession();
    await executeStep(s, { action: 'setContent', params: { html: '<p>x</p>' } });
    assert.deepEqual(s.calls.setContent[0].opts, { waitUntil: 'load', timeout: 30000 });
  });

  it('passes waitUntil and timeout through', async () => {
    const s = fakeSession();
    await executeStep(s, { action: 'setContent', params: { html: '<p>x</p>', waitUntil: 'networkidle', timeout: 5000 } });
    assert.deepEqual(s.calls.setContent[0].opts, { waitUntil: 'networkidle', timeout: 5000 });
  });

  // Same reason as goto: a returned { error } reads as ok:true and slips past stopOnError.
  it('throws when html is missing', async () => {
    const s = fakeSession();
    await assert.rejects(
      () => executeStep(s, { action: 'setContent', params: {} }),
      /html must be a string/
    );
    assert.deepEqual(s.calls.setContent, []);
  });

  it('throws when html is not a string', async () => {
    const s = fakeSession();
    await assert.rejects(
      () => executeStep(s, { action: 'setContent', params: { html: { body: 'x' } } }),
      /html must be a string/
    );
    assert.deepEqual(s.calls.setContent, []);
  });

  // Images and fonts the html pulls in must go through blockAds / forceHttp,
  // even when setContent is the session's first step and no goto set routes up.
  it('wires the route interceptor before loading', async () => {
    const s = fakeSession();
    s.blockAds = true;
    await executeStep(s, { action: 'setContent', params: { html: '<img src="https://example.com/a.png">' } });
    assert.ok(s.calls.order.indexOf('route') < s.calls.order.indexOf('setContent'));
  });

  // setContent writes into the current document. Without a reset, a previous
  // page's pending loads hold back "load" until timeout and its timers keep
  // mutating the new DOM.
  it('starts from a blank page so the previous document cannot leak in', async () => {
    const s = fakeSession();
    await executeStep(s, { action: 'goto', params: { url: 'https://example.com' } });
    await executeStep(s, { action: 'setContent', params: { html: '<p>x</p>' } });
    assert.deepEqual(s.calls.order, ['goto:https://example.com', 'goto:about:blank', 'setContent']);
  });
});
