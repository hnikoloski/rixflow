import { randomBytes } from 'node:crypto';
import { closeSync, constants, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// One lock per clone, held around commit + rebase + push, so hooks, MCP tools and the
// summarizer (separate processes) never run git on the same clone at the same time.
export const LOCK_STALE_MS = 60_000;
const POLL_MS = 100;

export const lockPath = (hubDir: string): string => join(hubDir, '.git', 'rixflow.lock');

interface LockInfo {
  pid?: unknown;
  ts?: unknown;
  token?: unknown;
}

function readLock(path: string): LockInfo | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return v !== null && typeof v === 'object' ? (v as LockInfo) : {};
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Stale: older than LOCK_STALE_MS, or its owner process is gone. A lock file that cannot be
// parsed (an owner still writing it, or junk) is judged by its mtime alone.
function isStale(path: string, now: number): boolean {
  const info = readLock(path);
  let ts = typeof info?.ts === 'number' ? info.ts : NaN;
  if (!Number.isFinite(ts)) {
    try {
      ts = statSync(path).mtimeMs;
    } catch {
      return true; // gone already
    }
  }
  if (now - ts > LOCK_STALE_MS) return true;
  const pid = info?.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
}

// Returns a release function, or null when another live process holds the lock.
// O_EXCL makes creation atomic; a stale lock is removed once and creation retried.
export function tryLock(hubDir: string, now: () => number = Date.now): (() => void) | null {
  const path = lockPath(hubDir);
  const token = randomBytes(8).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (attempt === 0 && isStale(path, now())) {
        rmSync(path, { force: true });
        continue;
      }
      return null;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: now(), token }));
    } finally {
      closeSync(fd);
    }
    // Removes the lock only while it is still ours (a stale-lock takeover may have replaced it).
    return () => {
      if (readLock(path)?.token === token) rmSync(path, { force: true });
    };
  }
  return null;
}

// Polls for up to waitMs. waitMs 0 tries once (hooks: skip the sync when the lock is held).
export async function acquireLock(
  hubDir: string,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<(() => void) | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = tryLock(hubDir);
    if (release || Date.now() >= deadline) return release;
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
}
