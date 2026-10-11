import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseDoc, stringifyDoc } from './frontmatter';
import { scrub } from './scrub';
import { HubError, assertName, type Ctx } from './types';

function scrubDeep(v: unknown): unknown {
  if (typeof v === 'string') return scrub(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, scrubDeep(val)]));
  }
  return v;
}

const isHubRoot = (dir: string): boolean => existsSync(join(dir, '.git')) || existsSync(join(dir, 'config', 'team.yml'));

// Walks from the target's directory upward and refuses any symlinked ancestor. It stops at the hub
// root (the first directory holding .git or config/team.yml), so links above the hub, such as
// macOS /tmp, are not checked.
function assertNoSymlinkAncestors(path: string): void {
  for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) {
    let exists = true;
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        throw new HubError('SYMLINK', `refusing to write through a symlinked directory: ${dir} (point hubDir at the real, non-symlink path)`);
      }
    } catch (err) {
      if (err instanceof HubError) throw err;
      exists = false; // not created yet
    }
    if (exists && isHubRoot(dir)) return;
    if (dirname(dir) === dir) return;
  }
}

// The only way hub files are written: no symlink in any ancestor (up to the hub root) or as the
// final component, so a committed symlink can never redirect a write.
export function writeGuarded(path: string, content: string, opts: { exclusive?: boolean } = {}): void {
  assertNoSymlinkAncestors(path);
  mkdirSync(dirname(path), { recursive: true });
  assertNoSymlinkAncestors(path);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (opts.exclusive ? constants.O_EXCL : constants.O_TRUNC);
  let fd: number;
  try {
    fd = openSync(path, flags, 0o666);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new HubError('SYMLINK', `refusing to write through a symlink: ${path}`);
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

export function writeDoc(
  path: string,
  data: Record<string, unknown>,
  body: string,
  opts: { exclusive?: boolean } = {},
): void {
  const clean = scrubDeep(data) as Record<string, unknown>;
  writeGuarded(path, stringifyDoc(clean, scrub(body)), opts);
}

export function readDoc(path: string): { data: Record<string, unknown>; body: string } {
  return parseDoc(readFileSync(path, 'utf8'));
}

export function listMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMd(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

export function personDir(ctx: Ctx, name: string = ctx.user.name): string {
  assertName(name);
  return join(ctx.hubDir, 'people', name);
}

export function insideHub(hubDir: string, rel: string): string {
  const root = resolve(hubDir);
  const full = resolve(root, rel);
  if (!full.startsWith(root + sep)) throw new HubError('BAD_PATH', `path escapes the hub: ${rel}`);
  return full;
}
