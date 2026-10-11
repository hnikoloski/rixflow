import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git, NO_REMOTE_DETAIL, commitAll, ownedPaths, gitInvocation, sync } from '../../src/core/git';
import { LOCK_STALE_MS, lockPath, tryLock } from '../../src/core/lock';
import { describeSync, persist, persistHub, syncHub } from '../../src/core/runtime';
import { runCheck } from '../../src/core/check';
import { sendMessage } from '../../src/core/messages';
import { mergeHubGitignore } from '../../src/core/template';
import { fakeAsana } from '../fixtures/asana';
import { makeCtx } from '../helpers';
import { hubWithRemote } from '../gitHub';

const noSleep = async () => {};

function hook(dir: string, name: string, body: string) {
  const p = join(dir, 'hooks', name);
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

describe('SyncStatus from persist and syncHub (I1, I2)', () => {
  it('a rejected push is "rejected" with the pending count and the push error, never "synced"', async () => {
    const { person, remote } = await hubWithRemote();
    const me = person('me');
    hook(remote, 'pre-receive', 'echo "denied by policy https://u:pw@x.example.com/" >&2; exit 1');
    sendMessage(me, { to: 'pm', type: 'question', body: 'hi' });
    const r = await persist(me, 'message', { sleep: noSleep });
    expect(r.status).toBe('rejected');
    expect(r.pending).toBe(1);
    expect(r.detail).toContain('denied by policy');
    expect(r.detail).not.toContain('u:pw@');
    expect(r.detail).not.toContain('\n');
    const text = describeSync(r);
    expect(text).toMatch(/^saved locally \(push rejected, 1 pending: .*denied by policy/);
    expect(text).not.toMatch(/^synced/);
  });

  it('a commit blocked by the pre-commit hook is "blocked" with one scrubbed line, not a throw', async () => {
    const { person } = await hubWithRemote();
    const me = person('me');
    hook(join(me.hubDir, '.git'), 'pre-commit', 'printf "RixFlow: commit blocked\\n  - people/me/x.md: possible secret (https://a:b@c.d/)\\n" >&2; exit 1');
    sendMessage(me, { to: 'pm', type: 'question', body: 'hi' });
    const r = await persist(me, 'message', { sleep: noSleep });
    expect(r.status).toBe('blocked');
    expect(r.detail).toContain('commit blocked');
    expect(r.detail).toContain('possible secret');
    expect(r.detail).not.toContain('a:b@');
    expect(r.detail).not.toContain('\n');
    expect(describeSync(r)).toMatch(/^saved locally \(sync failing: /);
    const viaHook = await syncHub(me);
    expect(viaHook?.status).toBe('blocked');
  });

  it('unmerged state is "blocked"', async () => {
    const { person } = await hubWithRemote();
    const me = person('me');
    const g = new Git(me.hubDir);
    // Leave a conflicted cherry-pick behind on a file the user owns.
    writeFileSync(join(me.hubDir, 'people/me/_index.md'), 'a\n');
    await g.run(['commit', '-q', '-am', 'a']);
    await g.run(['checkout', '-q', '-b', 'other', 'HEAD~1']);
    writeFileSync(join(me.hubDir, 'people/me/_index.md'), 'b\n');
    await g.run(['commit', '-q', '-am', 'b']);
    await g.run(['checkout', '-q', 'main']);
    await g.tryRun(['cherry-pick', 'other']);
    const r = await persist(me, 'x', { sleep: noSleep });
    expect(r.status).toBe('blocked');
    expect(r.detail).toContain('unmerged');
  });

  it('an unreachable remote is "offline"; a hub that is not a git repo is "blocked"', async () => {
    const { person } = await hubWithRemote();
    const me = person('me');
    await new Git(me.hubDir).run(['remote', 'set-url', 'origin', join(me.hubDir, '..', 'missing.git')]);
    sendMessage(me, { to: 'pm', type: 'question', body: 'hi' });
    const r = await persist(me, 'm', { sleep: noSleep });
    expect(r).toMatchObject({ status: 'offline', pending: 1 });
    expect(describeSync(r)).toBe('saved locally (hub offline, 1 pending)');
    const plain = await persist(makeCtx(), 'm');
    expect(plain.status).toBe('blocked');
    expect(describeSync(plain)).toContain('not a git repo');
  });

  it('a successful sync is "ok" and described as synced', async () => {
    const { person } = await hubWithRemote();
    const me = person('me');
    sendMessage(me, { to: 'pm', type: 'question', body: 'hi' });
    const r = await persist(me, 'm', { sleep: noSleep });
    expect(r).toEqual({ status: 'ok', detail: '', pending: 0, conflicts: [] });
    expect(describeSync(r)).toBe('synced');
  });
});

describe('session brief reports sync health (I1)', () => {
  const result = (status: string, pending = 0, detail = '') => async () => ({ status, detail, pending, conflicts: [] }) as never;
  it('reports blocked, rejected and offline, but not locked or ok', async () => {
    const ctx = makeCtx();
    const run = (sync: () => Promise<never>) => runCheck(ctx, { asana: fakeAsana([]), sync }, 'session');
    expect(await run(result('offline', 3))).toBe('[rixflow] hub offline, 3 pending');
    expect(await run(result('blocked', 0, 'RixFlow: commit blocked - x: possible secret (https://a:b@c/)'))).toBe(
      '[rixflow] hub sync failing: RixFlow: commit blocked - x: possible secret (https://[redacted]@c/)',
    );
    expect(await run(result('rejected', 2, 'remote: denied'))).toBe('[rixflow] hub push rejected, 2 pending');
    expect(await run(result('offline', 0))).toBe('[rixflow] hub offline, 0 pending');
    expect(await run(result('locked'))).toBe('');
    expect(await run(result('ok'))).toBe('');
  });
  it('offline with nothing pending: never on prompts, once per calendar day at session start', async () => {
    const ctx = makeCtx();
    const deps = { asana: fakeAsana([]), sync: result('offline', 0) };
    const at = (iso: string) => ({ ...ctx, now: () => new Date(iso) });
    expect(await runCheck(at('2026-10-08T09:00:00Z'), deps, 'prompt')).toBe('');
    expect(await runCheck(at('2026-10-08T10:00:00Z'), deps, 'session')).toBe('[rixflow] hub offline, 0 pending');
    expect(await runCheck(at('2026-10-08T15:00:00Z'), deps, 'session')).toBe('');
    expect(await runCheck(at('2026-10-09T08:00:00Z'), deps, 'session')).toBe('[rixflow] hub offline, 0 pending');
    const pendingDeps = { asana: fakeAsana([]), sync: result('offline', 2) };
    expect(await runCheck(at('2026-10-09T09:00:00Z'), pendingDeps, 'session')).toBe('[rixflow] hub offline, 2 pending');
    expect(await runCheck(at('2026-10-09T09:10:00Z'), pendingDeps, 'prompt')).toBe('[rixflow] hub offline, 2 pending');
    expect(await runCheck(at('2026-10-09T09:20:00Z'), { asana: fakeAsana([]), sync: result('blocked', 0, 'x') }, 'prompt')).toBe('[rixflow] hub sync failing: x');
  });

  it('a hub without a remote gets its own wording once per day, and counts local commits', async () => {
    const ctx = makeCtx();
    const deps = { asana: fakeAsana([]), sync: async () => ({ status: 'offline', detail: NO_REMOTE_DETAIL, pending: 4, conflicts: [] }) as never };
    const at = (iso: string) => ({ ...ctx, now: () => new Date(iso) });
    expect(await runCheck(at('2026-10-08T10:00:00Z'), deps, 'session')).toBe('[rixflow] hub has no remote; nothing is shared');
    expect(await runCheck(at('2026-10-08T10:10:00Z'), deps, 'prompt')).toBe('');
    expect(await runCheck(at('2026-10-08T11:00:00Z'), deps, 'session')).toBe('');
    expect(await runCheck(at('2026-10-09T11:00:00Z'), deps, 'session')).toBe('[rixflow] hub has no remote; nothing is shared');
    const root = mkdtempSync(join(tmpdir(), 'noremote-'));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    writeFileSync(join(root, 'a'), 'a');
    execFileSync('git', ['-C', root, 'add', 'a']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'a']);
    const r = await sync(new Git(root), 'me');
    expect(r).toEqual({ status: 'offline', detail: NO_REMOTE_DETAIL, pending: 1, conflicts: [] });
    expect(describeSync(r)).toBe('saved locally (hub has no remote; nothing is shared)');
  });

  it('reports it on prompts at most once per interval', async () => {
    const ctx = makeCtx();
    const deps = { asana: fakeAsana([]), sync: result('rejected', 1) };
    const at = (iso: string) => ({ ...ctx, now: () => new Date(iso) });
    expect(await runCheck(at('2026-10-08T10:00:00Z'), deps, 'prompt')).toBe('[rixflow] hub push rejected, 1 pending');
    expect(await runCheck(at('2026-10-08T10:02:00Z'), deps, 'prompt')).toBe('');
    expect(await runCheck(at('2026-10-08T10:06:00Z'), deps, 'prompt')).toBe('[rixflow] hub push rejected, 1 pending');
  });
});

describe('cross-process lock (I3)', () => {
  it('is exclusive, released only by its owner, and taken over when stale or dead', () => {
    const root = mkdtempSync(join(tmpdir(), 'lock-'));
    mkdirSync(join(root, '.git'));
    const release = tryLock(root);
    expect(release).not.toBeNull();
    expect(tryLock(root)).toBeNull();
    release!();
    expect(existsSync(lockPath(root))).toBe(false);
    // stale by age
    writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, ts: Date.now() - LOCK_STALE_MS - 1000, token: 'x' }));
    const r2 = tryLock(root);
    expect(r2).not.toBeNull();
    r2!();
    // stale by a dead pid
    const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    writeFileSync(lockPath(root), JSON.stringify({ pid: Number(dead), ts: Date.now(), token: 'x' }));
    const r3 = tryLock(root);
    expect(r3).not.toBeNull();
    // a release after someone else took over does not delete their lock
    writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'someone-else' }));
    r3!();
    expect(existsSync(lockPath(root))).toBe(true);
  });

  it('hooks skip the sync while the lock is held; tools wait, then report locked without retrying the write', async () => {
    const { person, remoteFiles } = await hubWithRemote();
    const me = person('me');
    const release = tryLock(me.hubDir)!;
    const msg = sendMessage(me, { to: 'pm', type: 'question', body: 'hi' });
    const head = execFileSync('git', ['-C', me.hubDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    expect((await syncHub(me))?.status).toBe('locked');
    const started = Date.now();
    const r = await persist(me, 'm', { waitMs: 300 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(r.status).toBe('locked');
    expect(describeSync(r)).toBe('saved locally, will sync on next action');
    expect(execFileSync('git', ['-C', me.hubDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(head);
    expect(readdirSync(join(me.hubDir, 'inbox/pm')).filter((f) => f.endsWith('.md'))).toHaveLength(1);
    release();
    expect((await persist(me, 'm')).status).toBe('ok');
    expect(remoteFiles()).toContain(msg.path.slice(me.hubDir.length + 1));
  });

  it('N concurrent persists in one clone all land once and leave a clean tree', async () => {
    const { person, remoteFiles, git } = await hubWithRemote();
    const me = person('me');
    const ids: string[] = [];
    const results = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      const m = sendMessage({ ...me, now: () => new Date(`2026-10-08T10:0${i}:00Z`) }, { to: 'pm', type: 'question', body: `q${i}` });
      ids.push(m.id);
      return persist(me, `message ${i}`, { waitMs: 15_000 });
    }));
    expect(results.map((r) => r.status).filter((s) => s !== 'ok')).toEqual([]);
    expect((await persist(me, 'final')).status).toBe('ok');
    const onRemote = remoteFiles().filter((f) => f.startsWith('inbox/pm/') && f.endsWith('.md'));
    expect(onRemote.sort()).toEqual(ids.map((id) => `inbox/pm/${id}.md`).sort());
    expect(git(['-C', me.hubDir, 'status', '--porcelain'])).toBe('');
    expect(existsSync(lockPath(me.hubDir))).toBe(false);
    expect(existsSync(join(me.hubDir, '.git/index.lock'))).toBe(false);
  });

  it('sync does not abort a pre-existing rebase unless it holds the lock', async () => {
    const { person } = await hubWithRemote();
    const a = person('me');
    const b = person('pm');
    const ga = new Git(a.hubDir);
    const gb = new Git(b.hubDir);
    writeFileSync(join(a.hubDir, 'shared/x.md'), 'a\n');
    await ga.run(['add', '-A']); await ga.run(['commit', '-q', '-m', 'a']); await ga.run(['push', '-q', 'origin', 'HEAD:main']);
    writeFileSync(join(b.hubDir, 'shared/x.md'), 'b\n');
    await gb.run(['add', '-A']); await gb.run(['commit', '-q', '-m', 'b']); await gb.run(['fetch', '-q', 'origin']);
    expect((await gb.tryRun(['rebase', 'origin/main'])).ok).toBe(false);
    await expect(sync(gb, 'pm', { sleep: noSleep })).rejects.toThrow(/rebase/);
    expect(existsSync(join(b.hubDir, '.git/rebase-merge'))).toBe(true);
    const r = await sync(gb, 'pm', { sleep: noSleep, holdsLock: true });
    expect(r.status).toBe('ok');
    expect(existsSync(join(b.hubDir, '.git/rebase-merge'))).toBe(false);
  });

  it('init merges the .gitignore and pushes it under the lock', async () => {
    const { person, remoteFiles, git } = await hubWithRemote();
    const me = person('me');
    git(['-C', me.hubDir, 'rm', '-q', '.gitignore']);
    git(['-C', me.hubDir, 'commit', '-q', '-m', 'old']);
    expect(mergeHubGitignore(me.hubDir)).toBe(true);
    expect((await persistHub(me.hubDir, 'me', 'chore: ignore editor files')).status).toBe('ok');
    expect(remoteFiles()).toContain('.gitignore');
    expect(mergeHubGitignore(me.hubDir)).toBe(false);
  });
});

describe('git never prompts (I4)', () => {
  it('always disables terminal prompts and forces ssh BatchMode for network ops', () => {
    const base: Record<string, string | undefined> = { PATH: '/bin' };
    expect(gitInvocation(['status'], base, null).env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(gitInvocation(['status'], base, null).args).toEqual(['status']);
    const B = '-o BatchMode=yes -o ConnectTimeout=10';
    expect(gitInvocation(['fetch', '-q', 'origin'], base, null).args).toEqual(['-c', `core.sshCommand=ssh ${B}`, 'fetch', '-q', 'origin']);
    expect(gitInvocation(['-c', 'x=y', 'push'], base, null).args[1]).toBe(`core.sshCommand=ssh ${B}`);
    expect(gitInvocation(['clone', 'u', 'd'], base, 'ssh -i ~/.ssh/k').args.slice(0, 2)).toEqual(['-c', `core.sshCommand=ssh -i ~/.ssh/k ${B}`]);
    expect(gitInvocation(['fetch'], { ...base, GIT_SSH_COMMAND: 'ssh -o ConnectTimeout=3' }, null).env.GIT_SSH_COMMAND).toBe('ssh -o ConnectTimeout=3 -o BatchMode=yes');
    expect(gitInvocation(['pull'], base, 'plink -batch').args).toEqual(['pull']);
    const own = gitInvocation(['fetch'], { ...base, GIT_SSH_COMMAND: '/usr/bin/ssh -p 2222' }, null);
    expect(own.env.GIT_SSH_COMMAND).toBe('/usr/bin/ssh -p 2222 -o BatchMode=yes -o ConnectTimeout=10');
    expect(own.args).toEqual(['fetch']);
    expect(gitInvocation(['fetch'], { ...base, GIT_SSH_COMMAND: 'my-wrapper' }, null).env.GIT_SSH_COMMAND).toBe('my-wrapper');
    expect(gitInvocation(['fetch'], { ...base, GIT_SSH_COMMAND: 'ssh -o BatchMode=no' }, null).env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=no -o ConnectTimeout=10');
    const interactive = gitInvocation(['clone', 'u', 'd'], base, null, true);
    expect(interactive.args).toEqual(['clone', 'u', 'd']);
    expect(interactive.env.GIT_TERMINAL_PROMPT).toBeUndefined();
  });

  it('runs the real ssh with BatchMode on fetch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ssh-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'ssh.log');
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\necho "$@" >> '${log}'\nexit 255\n`);
    chmodSync(join(bin, 'ssh'), 0o755);
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'ssh://git@example.invalid/x.git']);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete env.GIT_SSH_COMMAND;
    delete env.GIT_SSH;
    const r = await new Git(repo, env).tryRun(['fetch', 'origin']);
    expect(r.ok).toBe(false);
    expect(readFileSync(log, 'utf8')).toContain('BatchMode=yes');
    expect(readFileSync(log, 'utf8')).toContain('ConnectTimeout=10');
  });
});

describe('commitAll and persist edge cases (N2, N5)', () => {
  it('is a no-op, not a failure, when an owned path exists but holds nothing git can stage', async () => {
    const { person } = await hubWithRemote();
    const me = person('me');
    const g = new Git(me.hubDir);
    const head = (await g.run(['rev-parse', 'HEAD'])).trim();
    // people/me/ is empty on disk (its only tracked file deleted and committed away first)
    await g.run(['rm', '-q', 'people/me/_index.md']);
    await g.run(['commit', '-q', '-m', 'empty me']);
    mkdirSync(join(me.hubDir, 'people/me'), { recursive: true });
    expect(await commitAll(g, 'x', ownedPaths('me'))).toBe(false);
    sendMessage(me, { to: 'pm', type: 'question', body: 'a' });
    expect(await commitAll(g, 'x', ownedPaths('me'))).toBe(true);
    // ... and holding only an ignored .DS_Store
    writeFileSync(join(me.hubDir, 'people/me/.DS_Store'), 'x');
    expect(await commitAll(g, 'x', ownedPaths('me'))).toBe(false);
    sendMessage({ ...me, now: () => new Date('2026-10-08T11:00:00Z') }, { to: 'pm', type: 'question', body: 'b' });
    expect((await persist(me, 'x', { sleep: noSleep })).status).toBe('ok');
    expect((await g.run(['rev-parse', 'HEAD~3'])).trim()).toBe(head);
    expect(await commitAll(g, 'x', ownedPaths('me'))).toBe(false);
  });

  it('a pre-wave hub with a committed teammate .DS_Store that Finder modifies does not block persist', async () => {
    const { person, remoteFiles, git } = await hubWithRemote();
    const me = person('me');
    // Old hub: no .gitignore, and an inbox/pm/.DS_Store committed by someone.
    git(['-C', me.hubDir, 'rm', '-q', '.gitignore']);
    writeFileSync(join(me.hubDir, 'inbox/pm/.DS_Store'), 'v1');
    git(['-C', me.hubDir, 'add', '-A']);
    git(['-C', me.hubDir, 'commit', '-q', '-m', 'old hub']);
    git(['-C', me.hubDir, 'push', '-q', 'origin', 'HEAD:main']);
    // An ownership gate like the real one: only adds are allowed in someone else's inbox.
    hook(join(me.hubDir, '.git'), 'pre-commit',
      'bad=$(git diff --cached --name-status --no-renames | grep -vE "^A\s+inbox/" | grep -E "\s(inbox/pm|people/pm)/")\n[ -n "$bad" ] && { echo "blocked: $bad" >&2; exit 1; }\nexit 0');
    writeFileSync(join(me.hubDir, 'inbox/pm/.DS_Store'), 'v2 by Finder');
    const msg = sendMessage(me, { to: 'pm', type: 'question', body: 'hi' });
    const r = await persist(me, 'm', { sleep: noSleep });
    expect(r.status).toBe('ok');
    expect(remoteFiles()).toContain(msg.path.slice(me.hubDir.length + 1));
    expect(remoteFiles()).toContain('.gitignore');
    expect(git(['--git-dir', join(me.hubDir, '..', 'remote.git'), 'show', 'main:inbox/pm/.DS_Store'])).toBe('v1');
  });
});
