import { readdirSync, readFileSync } from 'node:fs';

/**
 * Counts processes in /proc and how many of them are zombies (State: Z).
 *
 * Logged in the heartbeat so a reaping regression shows up as a growing
 * `zombies=` number long before the container hits its pids limit and
 * Chrome can no longer fork (2026-10: 32 days of uptime, then every launch
 * failed with `browserType.launch: … has been closed`).
 *
 * Returns null where there is no /proc (macOS dev boxes).
 */
export function processStats(procDir = '/proc') {
  let entries;
  try {
    entries = readdirSync(procDir);
  } catch {
    return null;
  }
  let procs = 0;
  let zombies = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let status;
    try {
      status = readFileSync(`${procDir}/${name}/status`, 'utf8');
    } catch {
      continue; // exited between readdir and read
    }
    procs++;
    if (/^State:\s+Z/m.test(status)) zombies++;
  }
  return { procs, zombies };
}
