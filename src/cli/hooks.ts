import { spawn, type SpawnOptions } from 'node:child_process';
import { SYNC_STATUSES, type SyncResult } from '../core/git';
import type { Ctx } from '../core/types';

export interface HookDeps {
  env: Record<string, string | undefined>;
  loadCtx: () => Ctx;
  check: (ctx: Ctx, trigger: 'session' | 'prompt') => Promise<string>;
  spawnSummary: (args: string[]) => void;
  timeoutMs: number;
}

const DETAILS = ' (details: /rixflow:plate or /rixflow:inbox)';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function context(hookEventName: string, additionalContext: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } });
}

// Returns the stdout text; '' means print nothing. Never throws.
export async function runHook(event: string, stdin: string, deps: HookDeps): Promise<string> {
  if (deps.env.RIXFLOW_CHILD === '1') return '';
  try {
    const parsed: unknown = stdin.trim() ? JSON.parse(stdin) : {};
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const payload = parsed as Record<string, unknown>;
    const ctx = deps.loadCtx();
    if (event === 'session-start') {
      const brief = await withTimeout(deps.check(ctx, 'session'), deps.timeoutMs).catch(() => '');
      const note = payload.session_id ? `[rixflow] session ${String(payload.session_id)}` : '';
      const text = [note, brief ? brief + DETAILS : ''].filter(Boolean).join('\n');
      return text ? context('SessionStart', text) : '';
    }
    if (event === 'prompt') {
      const brief = await withTimeout(deps.check(ctx, 'prompt'), deps.timeoutMs).catch(() => '');
      return brief ? context('UserPromptSubmit', brief + DETAILS) : '';
    }
    if ((event === 'precompact' || event === 'session-end') && payload.session_id && payload.transcript_path) {
      deps.spawnSummary([
        'summary', '--session', String(payload.session_id), '--transcript', String(payload.transcript_path),
        '--trigger', event, '--cwd', String(payload.cwd ?? process.cwd()),
      ]);
    }
    return '';
  } catch {
    return '';
  }
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => { unref(): void; on?: (e: string, l: () => void) => unknown };

// The summary worker runs fully detached and WITHOUT the RIXFLOW_CHILD guard:
// the guard would make it skip its own work. runClaude sets the guard on the
// `claude -p` child it starts, which is what stops hook recursion.
export function detachedSummarySpawner(
  cliPath: string,
  env: Record<string, string | undefined> = process.env,
  spawnFn: SpawnFn = spawn as unknown as SpawnFn,
): (args: string[]) => void {
  return (args) => {
    const childEnv = { ...env };
    delete childEnv.RIXFLOW_CHILD;
    const child = spawnFn(process.execPath, [cliPath, ...args], { detached: true, stdio: 'ignore', env: childEnv as NodeJS.ProcessEnv });
    child.on?.('error', () => {}); // a failed spawn must not crash the hook
    child.unref();
  };
}

function parseSyncResult(text: string): SyncResult | null {
  const v: unknown = JSON.parse(text);
  if (v === null) return null;
  const r = v as Partial<SyncResult>;
  if (
    typeof r !== 'object' || !(SYNC_STATUSES as readonly string[]).includes(r.status as string) || typeof r.detail !== 'string' ||
    typeof r.pending !== 'number' || !Array.isArray(r.conflicts) || !r.conflicts.every((c) => typeof c === 'string')
  ) throw new Error('unreadable sync result');
  return r as SyncResult;
}

type SyncChild = {
  stdout: { setEncoding(e: string): unknown; on(e: 'data', l: (c: string) => void): unknown } | null;
  on(e: 'error' | 'close', l: (e?: unknown) => void): unknown;
  unref(): void;
};

// Runs `hub sync --json` in its own detached process. A caller that stops waiting (the status
// budget, a hook timeout) and exits leaves that sync to finish holding the hub lock, instead of
// cutting git off mid-rebase. Rejects on a failed spawn or unreadable output.
export function detachedSync(
  cliPath: string,
  env: Record<string, string | undefined> = process.env,
  spawnFn: (command: string, args: string[], options: SpawnOptions) => SyncChild = spawn as unknown as never,
): () => Promise<SyncResult | null> {
  return () => new Promise((resolve, reject) => {
    const child = spawnFn(process.execPath, [cliPath, 'sync', '--json'], {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: env as NodeJS.ProcessEnv,
    });
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c) => (out += c));
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(parseSyncResult(out));
      } catch (e) {
        reject(e);
      }
    });
    child.unref();
  });
}
