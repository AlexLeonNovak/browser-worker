import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processStats } from './process-stats.js';

function fakeProc(states) {
  const dir = mkdtempSync(join(tmpdir(), 'proc-'));
  states.forEach((state, i) => {
    mkdirSync(join(dir, String(i + 1)));
    writeFileSync(join(dir, String(i + 1), 'status'), `Name:\tchrome\nState:\t${state}\nPid:\t${i + 1}\n`);
  });
  mkdirSync(join(dir, 'self')); // non-numeric entries are not processes
  writeFileSync(join(dir, 'uptime'), '1 1');
  return dir;
}

describe('processStats', () => {
  it('counts processes and zombies', () => {
    const dir = fakeProc(['S (sleeping)', 'Z (zombie)', 'R (running)', 'Z (zombie)']);
    assert.deepEqual(processStats(dir), { procs: 4, zombies: 2 });
  });

  it('skips a pid that vanished before its status was read', () => {
    const dir = fakeProc(['S (sleeping)']);
    mkdirSync(join(dir, '99')); // no status file
    assert.deepEqual(processStats(dir), { procs: 1, zombies: 0 });
  });

  it('returns null without /proc', () => {
    assert.equal(processStats('/nonexistent-proc-dir'), null);
  });
});
