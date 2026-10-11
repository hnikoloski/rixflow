import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Keeps the pre-commit copy (<configDir>/hub.cjs) in step with the running bundle after a plugin
// update, so ownership and secret rules never drift. Only an existing copy is refreshed (creating
// it is init's job). Best effort: returns whether it replaced the copy and never throws.
export function refreshHookCopy(configDir: string, runningCli: string | null): boolean {
  try {
    if (!runningCli) return false;
    const copy = join(configDir, 'hub.cjs');
    if (!existsSync(copy) || resolve(copy) === resolve(runningCli)) return false;
    const next = readFileSync(runningCli);
    const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    if (digest(next) === digest(readFileSync(copy))) return false;
    const tmp = `${copy}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, next, { mode: 0o644 });
      renameSync(tmp, copy);
    } finally {
      rmSync(tmp, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}
