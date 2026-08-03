import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeStep } from './execute-step.js';

/**
 * Minimal stand-in for a session. `goto` only touches page.goto/page.url,
 * forceHttpHosts, and the route interceptor (which no-ops when neither
 * ad-blocking nor forceHttp is on).
 */
function fakeSession() {
  const calls = { goto: [] };
  return {
    sessionId: 'test',
    forceHttp: false,
    blockAds: false,
    forceHttpHosts: new Set(),
    context: { unroute: async () => {}, route: async () => {} },
    page: {
      goto: async (url) => { calls.goto.push(url); },
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
