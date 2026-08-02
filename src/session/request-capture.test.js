import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { armCapture, getCaptured, disarmCapture } from './request-capture.js';

/** Minimal stand-in for a Playwright Page — only the request event is used. */
function fakeSession() {
  const handlers = new Set();
  return {
    sessionId: 'test',
    page: {
      on: (evt, fn) => { if (evt === 'request') handlers.add(fn); },
      off: (evt, fn) => { if (evt === 'request') handlers.delete(fn); }
    },
    emit: (url, method = 'GET', headers = {}) => {
      for (const fn of handlers) fn({ url: () => url, method: () => method, headers: () => headers });
    },
    handlerCount: () => handlers.size
  };
}

const MESSAGES = 'api\\.example\\.com/v1/messages';

describe('armCapture', () => {

  it('records a request whose url matches the pattern', () => {
    const s = fakeSession();
    armCapture(s, { urlPattern: MESSAGES });
    s.emit('https://api.example.com/v1/messages?per_page=10', 'GET', { authorization: 'Bearer x' });

    const { requests } = getCaptured(s);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers.authorization, 'Bearer x');
    assert.equal(requests[0].method, 'GET');
  });

  it('ignores a request whose url does not match', () => {
    const s = fakeSession();
    armCapture(s, { urlPattern: MESSAGES });
    s.emit('https://api.example.com/v1/users?page=1');
    assert.deepEqual(getCaptured(s).requests, []);
  });

  it('filters by method when one is given', () => {
    const s = fakeSession();
    armCapture(s, { urlPattern: MESSAGES, method: 'GET' });
    s.emit('https://api.example.com/v1/messages', 'POST');
    assert.deepEqual(getCaptured(s).requests, []);
  });

  it('compares the method case-insensitively', () => {
    const s = fakeSession();
    armCapture(s, { urlPattern: MESSAGES, method: 'get' });
    s.emit('https://api.example.com/v1/messages', 'GET');
    assert.equal(getCaptured(s).requests.length, 1);
  });

  it('accepts any method when none is given', () => {
    const s = fakeSession();
    armCapture(s, { urlPattern: MESSAGES });
    s.emit('https://api.example.com/v1/messages', 'POST');
    assert.equal(getCaptured(s).requests.length, 1);
  });

  it('stops recording at max', () => {
    const s = fakeSession();
    armCapture(s, { urlPattern: MESSAGES, max: 2 });
    for (let i = 0; i < 5; i++) s.emit(`https://api.example.com/v1/messages?p=${i}`);
    assert.equal(getCaptured(s).requests.length, 2);
  });

  it('re-arming drops the previous listener and clears the buffer', () => {
    const s = fakeSession();
    armCapture(s, { urlPattern: MESSAGES });
    s.emit('https://api.example.com/v1/messages');
    assert.equal(getCaptured(s).requests.length, 1);

    armCapture(s, { urlPattern: 'api\\.example\\.com/v1/users' });
    assert.equal(s.handlerCount(), 1, 'the old listener must be removed, not stacked');
    assert.deepEqual(getCaptured(s).requests, []);

    s.emit('https://api.example.com/v1/messages');
    assert.deepEqual(getCaptured(s).requests, [], 'the old pattern must no longer match');
    s.emit('https://api.example.com/v1/users');
    assert.equal(getCaptured(s).requests.length, 1);
  });

  it('throws when urlPattern is missing', () => {
    assert.throws(() => armCapture(fakeSession(), {}), /urlPattern/);
  });

  it('throws on an invalid regex instead of matching nothing silently', () => {
    assert.throws(() => armCapture(fakeSession(), { urlPattern: '([' }), /invalid urlPattern/);
  });

  it('returns what it armed', () => {
    const r = armCapture(fakeSession(), { urlPattern: MESSAGES, method: 'get', max: 3 });
    assert.deepEqual(r, { armed: MESSAGES, method: 'GET', max: 3 });
  });
});

describe('getCaptured', () => {
  it('returns an empty list on a session that was never armed', () => {
    assert.deepEqual(getCaptured(fakeSession()).requests, []);
  });

  it('does not drain — reading twice returns the same requests', () => {
    const s = fakeSession();
    armCapture(s, { urlPattern: MESSAGES });
    s.emit('https://api.example.com/v1/messages');
    assert.equal(getCaptured(s).requests.length, 1);
    assert.equal(getCaptured(s).requests.length, 1);
  });
});

describe('disarmCapture', () => {
  it('removes the listener', () => {
    const s = fakeSession();
    armCapture(s, { urlPattern: MESSAGES });
    disarmCapture(s);
    assert.equal(s.handlerCount(), 0);
    s.emit('https://api.example.com/v1/messages');
    assert.deepEqual(getCaptured(s).requests, []);
  });

  it('is a no-op on a session that was never armed', () => {
    assert.doesNotThrow(() => disarmCapture(fakeSession()));
  });
});
