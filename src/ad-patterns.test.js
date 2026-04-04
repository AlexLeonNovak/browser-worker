import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAdPatterns, adPatterns } from './ad-patterns.js';

describe('resolveAdPatterns', () => {

  it('returns null for false', () => {
    assert.strictEqual(resolveAdPatterns(false), null);
  });

  it('returns null for undefined', () => {
    assert.strictEqual(resolveAdPatterns(undefined), null);
  });

  it('returns null for null', () => {
    assert.strictEqual(resolveAdPatterns(null), null);
  });

  it('returns default patterns for true', () => {
    const result = resolveAdPatterns(true);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, adPatterns.length);
    assert.ok(result.includes('google-analytics.com'));
    assert.ok(result.includes('/ads/'));
  });

  it('extends defaults with array input', () => {
    const result = resolveAdPatterns(['my-ads.com', '/custom/']);
    assert.ok(Array.isArray(result));
    assert.ok(result.length > adPatterns.length);
    assert.ok(result.includes('google-analytics.com')); // default
    assert.ok(result.includes('my-ads.com'));           // custom
    assert.ok(result.includes('/custom/'));             // custom
  });

  it('extends defaults with { custom: [...] }', () => {
    const result = resolveAdPatterns({ custom: ['foo.com', 'bar.net'] });
    assert.ok(Array.isArray(result));
    assert.ok(result.includes('doubleclick.net'));  // default
    assert.ok(result.includes('foo.com'));          // custom
    assert.ok(result.includes('bar.net'));          // custom
  });

  it('disables defaults with { useDefaults: false }', () => {
    const result = resolveAdPatterns({ useDefaults: false });
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  });

  it('custom only with { useDefaults: false, custom: [...] }', () => {
    const result = resolveAdPatterns({ useDefaults: false, custom: ['only-me.com'] });
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 1);
    assert.ok(result.includes('only-me.com'));
    assert.ok(!result.includes('google-analytics.com')); // no defaults
  });

  it('does not mutate original defaults array', () => {
    const before = adPatterns.length;
    resolveAdPatterns(['extra.com']);
    assert.strictEqual(adPatterns.length, before);
  });

  it('handles empty custom array gracefully', () => {
    const result = resolveAdPatterns({ custom: [] });
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, adPatterns.length); // defaults only
  });

  it('handles empty custom with useDefaults: false', () => {
    const result = resolveAdPatterns({ useDefaults: false, custom: [] });
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  });
});
