import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { writeGuarded } from './hubfs';
import { scrub } from './scrub';
import { HubError, assertName } from './types';

type Env = Record<string, string | undefined>;

const NETWORK_OPS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote']);

function subcommand(args: string[]): string | undefined {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += args[i] === '-c' || args[i] === '-C' ? 2 : 1;
  return args[i];
}

// True when the command runs OpenSSH itself (ssh, /usr/bin/ssh, ssh.exe), not a wrapper such as plink.
function isPlainSsh(command: string): boolean {
  return /(^|[\/\\])ssh(\.exe)?$/i.test(command.trim().split(/\s+/)[0] ?? '');
}

// BatchMode: never prompt. ConnectTimeout: an unreachable host fails in 10 s instead of holding a
// tool (and the hub lock) for the TCP timeout. A user's own value for either option is kept.
function withBatchMode(command: string): string {
  let out = command;
  if (!/BatchMode/i.test(out)) out += ' -o BatchMode=yes';
  if (!/ConnectTimeout/i.test(out)) out += ' -o ConnectTimeout=10';
  return out;
}

// Hooks and the MCP server share Claude Code's terminal, so git must never prompt there:
// GIT_TERMINAL_PROMPT=0 always, and ssh runs in BatchMode for network operations. A user's own
// GIT_SSH_COMMAND / core.sshCommand is kept; BatchMode is only appended when it is plain ssh.
// `configuredSsh` is the value of core.sshCommand (null when unset).
export function gitInvocation(
  args: string[],
  env: Env,
  configuredSsh: string | null,
  interactive = false,
): { args: string[]; env: Env } {
  if (interactive) return { args, env };
  const out: Env = { ...env, GIT_TERMINAL_PROMPT: '0' };
  if (!NETWORK_OPS.has(subcommand(args) ?? '')) return { args, env: out };
  if (env.GIT_SSH_COMMAND) {
    if (isPlainSsh(env.GIT_SSH_COMMAND)) out.GIT_SSH_COMMAND = withBatchMode(env.GIT_SSH_COMMAND);
    return { args, env: out };
  }
  if (env.GIT_SSH) return { args, env: out };
  if (configuredSsh) {
    return isPlainSsh(configuredSsh) ? { args: ['-c', `core.sshCommand=${withBatchMode(configuredSsh)}`, ...args], env: out } : { args, env: out };
  }
  return { args: ['-c', `core.sshCommand=${withBatchMode('ssh')}`, ...args], env: out };
}

function execGit(args: string[], cwd: string, env: Env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: env as NodeJS.ProcessEnv, maxBuffer: 20_000_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve(String(stdout));
    });
  });
}

export class Git {
  constructor(
    readonly cwd: string,
    readonly env: NodeJS.ProcessEnv = process.env,
    // Only `hub init`'s own clone may prompt (for an ssh passphrase or https credentials).
    readonly opts: { interactive?: boolean } = {},
  ) {}

  async run(args: string[]): Promise<string> {
    let configuredSsh: string | null = null;
    if (!this.opts.interactive && NETWORK_OPS.has(subcommand(args) ?? '') && !this.env.GIT_SSH_COMMAND && !this.env.GIT_SSH) {
      configuredSsh = (await execGit(['config', '--get', 'core.sshCommand'], this.cwd, this.env).catch(() => '')).trim() || null;
    }
    const inv = gitInvocation(args, this.env, configuredSsh, this.opts.interactive);
    return execGit(inv.args, this.cwd, inv.env);
  }

  async tryRun(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
    try {
      return { ok: true, out: await this.run(args), err: '' };
    } catch (e) {
      return { ok: false, out: '', err: String((e as { stderr?: string }).stderr ?? e) };
    }
  }
}

// One scrubbed line (max 200 chars) for a status detail: whitespace and control characters
// collapse, so the text can be shown in a brief or tool result as is.
export function detailLine(text: string): string {
  const one = scrub(String(text)).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > 200 ? `${one.slice(0, 197)}...` : one;
}

// The first meaningful line of git's stderr (skipping "To <url>" progress lines).
function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('To ')) ?? '';
}

// The only paths the tooling writes for `user`. Commits never stage anything else, so a stray
// file (Obsidian's .obsidian/, Finder's .DS_Store) can never block the user's own writes.
export function ownedPaths(user: string): string[] {
  assertName(user);
  return [`people/${user}`, 'inbox', 'shared', '.gitignore'];
}

// Stages and commits only the changed files under `paths` (git commit --only), so anything else
// already in the index, such as a stray staged by an older version, stays out of the commit.
// Tracked files that match an ignore rule (a .DS_Store committed before the hub had a .gitignore)
// are left out too: Finder rewriting one must never block the user's own writes. Nothing to
// commit is a no-op, never an error.
export async function commitAll(git: Git, message: string, paths: string[]): Promise<boolean> {
  const unmerged = await unmergedFiles(git);
  if (unmerged.length > 0) {
    throw new HubError('SYNC_FAILED', `unmerged files, resolve them before committing: ${unmerged.join(', ')}`);
  }
  if (paths.length === 0) return false;
  const status = await git.run(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', ...paths]);
  const ignoredTracked = new Set(
    (await git.run(['ls-files', '-z', '--cached', '--ignored', '--exclude-standard', '--', ...paths])).split('\0').filter(Boolean),
  );
  const changed = status.split('\0').filter((e) => e.length > 3).map((e) => e.slice(3)).filter((p) => !ignoredTracked.has(p));
  if (changed.length === 0) return false;
  await git.run(['add', '-A', '--', ...changed]);
  const staged = await git.run(['diff', '--cached', '--name-only', '--', ...changed]);
  if (!staged.trim()) return false;
  await git.run(['commit', '-q', '-m', message, '--', ...changed]);
  return true;
}

// Team setup changes from the wizard menu: commits only what changed under config/.
export async function commitConfig(git: Git, message: string): Promise<boolean> {
  return commitAll(git, message, ['config']);
}

// ok: pushed, or nothing was pending. offline: the remote could not be reached (or there is none).
// rejected: reachable, but every push was refused. blocked: a commit or rebase failed (a hook,
// unmerged files). locked: another RixFlow process holds the hub lock; the write is saved locally.
export const SYNC_STATUSES = ['ok', 'offline', 'rejected', 'blocked', 'locked'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export interface SyncResult {
  status: SyncStatus;
  detail: string;
  pending: number;
  conflicts: string[];
}

 // `detail` of an offline result for a hub that has no remote at all (pending = local commits).
export const NO_REMOTE_DETAIL = 'no remote configured';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Throws HubError SYNC_FAILED when a rebase cannot be completed. A rebase that was already in
// progress is aborted only when the caller holds the hub lock (so it cannot belong to a live process).
export async function sync(
  git: Git,
  user: string,
  opts: { retries?: number; sleep?: (ms: number) => Promise<void>; holdsLock?: boolean } = {},
): Promise<SyncResult> {
  assertName(user);
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  if (!(await git.run(['remote'])).trim()) {
    return { status: 'offline', detail: NO_REMOTE_DETAIL, pending: await pendingCount(git), conflicts: [] };
  }
  const conflicts: string[] = [];
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const fetched = await git.tryRun(['fetch', '-q', 'origin']);
    if (!fetched.ok) {
      return { status: 'offline', detail: detailLine(firstLine(fetched.err)), pending: await pendingCount(git), conflicts };
    }
    const hasUpstream = (await git.tryRun(['rev-parse', '--verify', '-q', 'origin/main'])).ok;
    if (hasUpstream) conflicts.push(...(await rebaseOntoUpstream(git, user, !!opts.holdsLock)));
    const pending = await pendingCount(git);
    if (hasUpstream && pending === 0) return { status: 'ok', detail: '', pending: 0, conflicts };
    const pushed = await git.tryRun(['push', '-q', 'origin', 'HEAD:main']);
    if (pushed.ok) return { status: 'ok', detail: '', pending: 0, conflicts };
    lastError = pushed.err;
    if (attempt < retries) await sleep(250 * 2 ** attempt);
  }
  return { status: 'rejected', detail: detailLine(firstLine(lastError)), pending: await pendingCount(git), conflicts };
}

export async function pendingCount(git: Git): Promise<number> {
  const ahead = await git.tryRun(['rev-list', '--count', 'origin/main..HEAD']);
  if (ahead.ok) return Number(ahead.out.trim());
  const all = await git.tryRun(['rev-list', '--count', 'HEAD']);
  return all.ok ? Number(all.out.trim()) : 0;
}

const MAX_CONFLICT_ROUNDS = 50;

async function unmergedFiles(git: Git): Promise<string[]> {
  return (await git.run(['diff', '-z', '--name-only', '--diff-filter=U'])).split('\0').filter(Boolean);
}

async function rebaseInProgress(git: Git): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const p = (await git.run(['rev-parse', '--git-path', name])).trim();
    if (existsSync(resolve(git.cwd, p))) return true;
  }
  return false;
}

async function rebaseOntoUpstream(git: Git, user: string, holdsLock: boolean): Promise<string[]> {
  if (await rebaseInProgress(git)) {
    if (!holdsLock) throw new HubError('SYNC_FAILED', 'a rebase is already in progress in the hub');
    await git.tryRun(['rebase', '--abort']);
  }
  try {
    return await resolveRebase(git, user);
  } catch (e) {
    await git.tryRun(['rebase', '--abort']);
    throw e;
  }
}

async function resolveRebase(git: Git, user: string): Promise<string[]> {
  const conflicts: string[] = [];
  let result = await git.tryRun(['rebase', '-q', '--autostash', 'origin/main']);
  for (let round = 0; !result.ok; round++) {
    const files = await unmergedFiles(git);
    if (files.length === 0 || round >= MAX_CONFLICT_ROUNDS) {
      throw new HubError('SYNC_FAILED', result.err || 'rebase made no progress');
    }
    for (const file of files) {
      const local = await git.tryRun(['show', `:3:${file}`]);
      if (local.ok) {
        const copy = `${file.replace(/\.md$/, '')}.conflict-${user}.md`;
        if (posix.dirname(copy) !== posix.dirname(file)) throw new HubError('SYNC_FAILED', `bad conflict path: ${copy}`);
        writeGuarded(join(git.cwd, copy), scrub(local.out));
        await git.run(['add', '--', copy]);
      }
      const upstream = await git.tryRun(['show', `:2:${file}`]);
      if (upstream.ok) {
        writeGuarded(join(git.cwd, file), scrub(upstream.out));
        await git.run(['add', '--', file]);
      } else {
        await git.run(['rm', '-q', '--cached', '--ignore-unmatch', '--', file]);
      }
      conflicts.push(file);
    }
    const noEditor = new Git(git.cwd, { ...git.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' });
    result = await noEditor.tryRun(['-c', 'core.editor=true', 'rebase', '--continue']);
  }
  if ((await unmergedFiles(git)).length > 0) {
    throw new HubError('SYNC_FAILED', 'autostash conflict: unmerged files remain after rebase');
  }
  return conflicts;
}
