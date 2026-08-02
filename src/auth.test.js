import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenMatches, extractToken, createAuthMiddleware } from './auth.js';

const TOKEN = 's3cret-token';

/** Runs the middleware and reports which of next() / res.status().json() it took. */
function run(mw, { path = '/execute', headers = {} } = {}) {
  const out = { nexted: false, status: null, body: null };
  const res = {
    status(code) { out.status = code; return this; },
    json(body) { out.body = body; return this; }
  };
  mw({ path, headers }, res, () => { out.nexted = true; });
  return out;
}

describe('tokenMatches', () => {
  it('accepts the exact token', () => {
    assert.equal(tokenMatches(TOKEN, TOKEN), true);
  });

  it('rejects a wrong token of the same length', () => {
    assert.equal(tokenMatches(TOKEN, 'x'.repeat(TOKEN.length)), false);
  });

  it('rejects a token of a different length without throwing', () => {
    assert.equal(tokenMatches(TOKEN, 'short'), false);
    assert.equal(tokenMatches(TOKEN, TOKEN + 'extra'), false);
  });

  it('rejects null / empty', () => {
    assert.equal(tokenMatches(TOKEN, null), false);
    assert.equal(tokenMatches(TOKEN, ''), false);
  });
});

describe('extractToken', () => {
  it('reads x-worker-token', () => {
    assert.equal(extractToken({ 'x-worker-token': TOKEN }), TOKEN);
  });

  it('reads an Authorization: Bearer header', () => {
    assert.equal(extractToken({ authorization: `Bearer ${TOKEN}` }), TOKEN);
  });

  it('accepts a lowercase bearer scheme', () => {
    assert.equal(extractToken({ authorization: `bearer ${TOKEN}` }), TOKEN);
  });

  it('prefers x-worker-token when both are present', () => {
    assert.equal(extractToken({ 'x-worker-token': TOKEN, authorization: 'Bearer other' }), TOKEN);
  });

  it('returns null when there is nothing to read', () => {
    assert.equal(extractToken({}), null);
    assert.equal(extractToken({ authorization: 'Basic abc' }), null);
  });
});

describe('createAuthMiddleware', () => {
  it('passes a request carrying the right token', () => {
    const r = run(createAuthMiddleware(TOKEN), { headers: { 'x-worker-token': TOKEN } });
    assert.equal(r.nexted, true);
  });

  it('401s a request with no token', () => {
    const r = run(createAuthMiddleware(TOKEN));
    assert.equal(r.nexted, false);
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { ok: false, error: 'unauthorized' });
  });

  it('401s a request with a wrong token', () => {
    const r = run(createAuthMiddleware(TOKEN), { headers: { 'x-worker-token': 'nope' } });
    assert.equal(r.status, 401);
  });

  it('lets /health through unauthenticated so the healthcheck keeps working', () => {
    const r = run(createAuthMiddleware(TOKEN), { path: '/health' });
    assert.equal(r.nexted, true);
    assert.equal(r.status, null);
  });

  it('passes everything through when no token is configured', () => {
    const r = run(createAuthMiddleware(''), { path: '/execute' });
    assert.equal(r.nexted, true);
  });
});
