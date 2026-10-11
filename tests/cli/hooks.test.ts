import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { detachedSummarySpawner, detachedSync, runHook, type HookDeps } from '../../src/cli/hooks';
import { HubError } from '../../src/core/types';
import { makeCtx } from '../helpers';

const deps = (over: Partial<HookDeps> = {}): HookDeps => ({
  env: {}, loadCtx: () => makeCtx(), check: async () => '', spawnSummary: () => {}, timeoutMs: 1000, ...over,
});
const ctxOf = (out: string) => JSON.parse(out).hookSpecificOutput;

describe('runHook', () => {
  it('session-start always reports the session id, plus the brief', async () => {
    const out = await runHook('session-start', JSON.stringify({ session_id: 'abc' }), deps({ check: async () => '[rixflow] 1 new request from pm' }));
    expect(ctxOf(out).hookEventName).toBe('SessionStart');
    expect(ctxOf(out).additionalContext).toContain('[rixflow] session abc');
    expect(ctxOf(out).additionalContext).toContain('1 new request from pm');
  });
  it('prompt prints nothing when there is nothing new', async () => {
    expect(await runHook('prompt', '{}', deps())).toBe('');
    const out = await runHook('prompt', '{}', deps({ check: async () => '[rixflow] x' }));
    expect(ctxOf(out).hookEventName).toBe('UserPromptSubmit');
  });
  it('does nothing inside a summarizer child', async () => {
    const out = await runHook('session-start', '{"session_id":"a"}', deps({ env: { RIXFLOW_CHILD: '1' }, loadCtx: () => { throw new Error('must not load'); } }));
    expect(out).toBe('');
  });
  it('does nothing when the hub is not set up or stdin is junk', async () => {
    const notInit = deps({ loadCtx: () => { throw new HubError('NOT_INITIALIZED', 'x'); } });
    expect(await runHook('session-start', '{"session_id":"a"}', notInit)).toBe('');
    expect(await runHook('session-start', 'not json', deps())).toBe('');
  });
  it('a slow check still yields the session note but no brief', async () => {
    const slow = deps({ check: () => new Promise(() => {}), timeoutMs: 30 });
    expect(ctxOf(await runHook('session-start', '{"session_id":"a"}', slow)).additionalContext).toBe('[rixflow] session a');
    expect(await runHook('prompt', '{}', slow)).toBe('');
  });
  it('a throwing check never escapes', async () => {
    const bad = deps({ check: async () => { throw new Error('boom'); } });
    expect(ctxOf(await runHook('session-start', '{"session_id":"a"}', bad)).additionalContext).toBe('[rixflow] session a');
    expect(await runHook('prompt', '{}', bad)).toBe('');
  });
  it('unknown events and non-object payloads print nothing', async () => {
    expect(await runHook('bogus', '{}', deps())).toBe('');
    expect(await runHook('session-start', 'null', deps())).toBe('');
    expect(await runHook('session-start', '[1]', deps())).toBe('');
  });
  it('precompact and session-end start a detached summary', async () => {
    const calls: string[][] = [];
    const d = deps({ spawnSummary: (a) => calls.push(a) });
    const payload = JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: '/p/acme' });
    expect(await runHook('precompact', payload, d)).toBe('');
    expect(await runHook('session-end', payload, d)).toBe('');
    expect(calls).toEqual([
      ['summary', '--session', 's', '--transcript', '/t.jsonl', '--trigger', 'precompact', '--cwd', '/p/acme'],
      ['summary', '--session', 's', '--transcript', '/t.jsonl', '--trigger', 'session-end', '--cwd', '/p/acme'],
    ]);
  });
  it('a throwing spawn still prints nothing', async () => {
    const d = deps({ spawnSummary: () => { throw new Error('ENOENT'); } });
    const payload = JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl' });
    expect(await runHook('session-end', payload, d)).toBe('');
  });
  it('does not summarize when the hub is not set up', async () => {
    const spawnSummary = vi.fn();
    const d = deps({ spawnSummary, loadCtx: () => { throw new HubError('NOT_INITIALIZED', 'x'); } });
    await runHook('session-end', JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl' }), d);
    expect(spawnSummary).not.toHaveBeenCalled();
  });
});

describe('detachedSummarySpawner', () => {
  it('spawns fully detached without the child guard and unrefs', () => {
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ unref, on: vi.fn() }));
    const env = { PATH: '/bin', RIXFLOW_CHILD: '1', KEEP: 'x' };
    detachedSummarySpawner('/cli/hub.cjs', env, spawnFn as never)(['summary', '--session', 's']);
    const [cmd, args, opts] = spawnFn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(['/cli/hub.cjs', 'summary', '--session', 's']);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.env).toEqual({ PATH: '/bin', KEEP: 'x' });
    expect(unref).toHaveBeenCalledOnce();
  });
});

describe('detachedSync', () => {
  const fakeChild = () => {
    const child = Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }), unref: vi.fn() });
    const spawnFn = vi.fn(() => child);
    return { child, spawnFn };
  };
  const ok = { status: 'ok', detail: '', pending: 0, conflicts: [] };

  it('runs `sync --json` in its own detached process and returns its result', async () => {
    const { child, spawnFn } = fakeChild();
    const env = { PATH: '/bin' };
    const p = detachedSync('/cli/hub.cjs', env, spawnFn as never)();
    const [cmd, args, opts] = spawnFn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(['/cli/hub.cjs', 'sync', '--json']);
    expect(opts).toMatchObject({ detached: true, stdio: ['ignore', 'pipe', 'ignore'], env });
    expect(child.unref).toHaveBeenCalledOnce();
    child.stdout.emit('data', JSON.stringify(ok).slice(0, 10));
    child.stdout.emit('data', JSON.stringify(ok).slice(10));
    child.emit('close', 0);
    await expect(p).resolves.toEqual(ok);
  });

  it('passes on null (hub not set up) and rejects bad output or a failed spawn', async () => {
    const a = fakeChild();
    const pa = detachedSync('/c', {}, a.spawnFn as never)();
    a.child.stdout.emit('data', 'null\n');
    a.child.emit('close', 0);
    await expect(pa).resolves.toBeNull();

    for (const text of ['', 'garbage', '{"status":"nope","detail":"","pending":0,"conflicts":[]}', '{"status":"ok"}']) {
      const b = fakeChild();
      const pb = detachedSync('/c', {}, b.spawnFn as never)();
      b.child.stdout.emit('data', text);
      b.child.emit('close', 1);
      await expect(pb).rejects.toThrow();
    }

    const c = fakeChild();
    const pc = detachedSync('/c', {}, c.spawnFn as never)();
    c.child.emit('error', new Error('ENOENT'));
    await expect(pc).rejects.toThrow('ENOENT');
  });
});
