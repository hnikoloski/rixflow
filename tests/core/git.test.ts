import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git, commitAll, sync } from '../../src/core/git';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const noSleep = async () => {};
const ALL = ['README.md', 'people'];

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'git-'));
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: ENV });
  const clone = (name: string) => {
    const dir = join(root, name);
    execFileSync('git', ['clone', '-q', remote, dir], { env: ENV, stdio: 'pipe' });
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-B', 'main'], { env: ENV });
    execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { env: ENV });
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@example.com'], { env: ENV });
    return new Git(dir, ENV);
  };
  return { root, remote, clone };
}

function write(git: Git, rel: string, text: string) {
  const path = join(git.cwd, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

describe('git sync', () => {
  it('commitAll returns false when clean', async () => {
    const { clone } = setup();
    const a = clone('a');
    expect(await commitAll(a, 'x', ALL)).toBe(false);
    write(a, 'people/a/n.md', 'hi');
    expect(await commitAll(a, 'x', ALL)).toBe(true);
  });

  it('two users writing different files both end up on the remote', async () => {
    const { clone } = setup();
    const a = clone('a');
    write(a, 'README.md', 'hub');
    await commitAll(a, 'init', ALL);
    expect((await sync(a, 'a', { sleep: noSleep })).status).toBe('ok');
    const b = clone('b');
    write(a, 'people/a/n.md', 'from a');
    await commitAll(a, 'a', ALL);
    write(b, 'people/b/n.md', 'from b');
    await commitAll(b, 'b', ALL);
    await sync(a, 'a', { sleep: noSleep });
    const res = await sync(b, 'b', { sleep: noSleep });
    expect(res).toEqual({ status: 'ok', detail: '', pending: 0, conflicts: [] });
    await sync(a, 'a', { sleep: noSleep });
    expect(readFileSync(join(a.cwd, 'people/b/n.md'), 'utf8')).toBe('from b');
  });

  it('keeps both versions on a real conflict', async () => {
    const { clone } = setup();
    const a = clone('a');
    write(a, 'README.md', 'hub');
    await commitAll(a, 'init', ALL);
    await sync(a, 'a', { sleep: noSleep });
    const b = clone('b');
    write(a, 'people/x/note.md', 'version a');
    await commitAll(a, 'a', ALL);
    await sync(a, 'a', { sleep: noSleep });
    write(b, 'people/x/note.md', 'version b');
    await commitAll(b, 'b', ALL);
    const res = await sync(b, 'b', { sleep: noSleep });
    expect(res.conflicts).toEqual(['people/x/note.md']);
    expect(res.status).toBe('ok');
    expect(readFileSync(join(b.cwd, 'people/x/note.md'), 'utf8')).toBe('version a');
    expect(readFileSync(join(b.cwd, 'people/x/note.conflict-b.md'), 'utf8')).toBe('version b');
  });

  it('reports offline with pending commits', async () => {
    const { clone, root } = setup();
    const a = clone('a');
    await a.run(['remote', 'set-url', 'origin', join(root, 'missing.git')]);
    write(a, 'people/a/n.md', 'x');
    await commitAll(a, 'x', ALL);
    const res = await sync(a, 'a', { sleep: noSleep });
    expect(res.status).toBe('offline');
    expect(res.pending).toBe(1);
  });

  it('does nothing without a remote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-'));
    execFileSync('git', ['init', '-q', '-b', 'main', root], { env: ENV });
    const g = new Git(root, ENV);
    expect(await sync(g, 'a')).toEqual({ status: 'offline', detail: 'no remote configured', pending: 0, conflicts: [] });
    expect(existsSync(join(root, '.git'))).toBe(true);
  });

  async function conflictPair(path: string, local: string) {
    const { clone } = setup();
    const a = clone('a');
    write(a, 'README.md', 'hub');
    await commitAll(a, 'init', ALL);
    await sync(a, 'a', { sleep: noSleep });
    const b = clone('b');
    write(a, path, 'version a');
    await commitAll(a, 'a', ALL);
    await sync(a, 'a', { sleep: noSleep });
    write(b, path, local);
    await commitAll(b, 'b', ALL);
    return { a, b };
  }

  it('resolves a conflict on a non-ASCII path', async () => {
    const { b } = await conflictPair('people/x/né.md', 'version b');
    const res = await sync(b, 'b', { sleep: noSleep });
    expect(res.conflicts).toEqual(['people/x/né.md']);
    expect(readFileSync(join(b.cwd, 'people/x/né.conflict-b.md'), 'utf8')).toBe('version b');
    expect(readFileSync(join(b.cwd, 'people/x/né.md'), 'utf8')).toBe('version a');
  });

  it('scrubs secrets in the conflict copy', async () => {
    const { b } = await conflictPair('people/x/note.md', 'see https://u:p@h.com/x');
    await sync(b, 'b', { sleep: noSleep });
    expect(readFileSync(join(b.cwd, 'people/x/note.conflict-b.md'), 'utf8')).not.toContain('u:p@');
  });

  it('rejects an invalid user', async () => {
    const { b } = await conflictPair('people/x/note.md', 'version b');
    await expect(sync(b, '../evil', { sleep: noSleep })).rejects.toThrow();
    expect(existsSync(join(b.cwd, '.git/rebase-merge'))).toBe(false);
  });

  it('aborts a half-done rebase when resolving fails mid-way', async () => {
    const { b } = await conflictPair('people/x/note.md', 'version b');
    write(b, 'people/x/note.conflict-b.md/blocker', 'x');
    await expect(sync(b, 'b', { sleep: noSleep })).rejects.toThrow();
    expect(existsSync(join(b.cwd, '.git/rebase-merge'))).toBe(false);
    expect(existsSync(join(b.cwd, '.git/rebase-apply'))).toBe(false);
  });

  it('fails closed when a hook rejects the rebase', async () => {
    const { b } = await conflictPair('people/x/note.md', 'version b');
    const hook = join(b.cwd, '.git/hooks/pre-rebase');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    await expect(sync(b, 'b', { sleep: noSleep })).rejects.toThrow();
    expect(existsSync(join(b.cwd, '.git/rebase-merge'))).toBe(false);
  });

  it('cleans up a pre-existing in-progress rebase', async () => {
    const { b } = await conflictPair('people/x/note.md', 'version b');
    await b.tryRun(['fetch', '-q', 'origin']);
    expect((await b.tryRun(['rebase', 'origin/main'])).ok).toBe(false);
    expect(existsSync(join(b.cwd, '.git/rebase-merge'))).toBe(true);
    const res = await sync(b, 'b', { sleep: noSleep, holdsLock: true });
    expect(res.status).toBe('ok');
    expect(existsSync(join(b.cwd, '.git/rebase-merge'))).toBe(false);
  });

  it('commitAll refuses to commit unmerged files', async () => {
    const { b } = await conflictPair('people/x/note.md', 'version b');
    await b.tryRun(['fetch', '-q', 'origin']);
    expect((await b.tryRun(['rebase', 'origin/main'])).ok).toBe(false);
    const rebaseHead = (await b.run(['rev-parse', 'HEAD'])).trim();
    await expect(commitAll(b, 'x', ALL)).rejects.toThrow(/people\/x\/note\.md/);
    expect((await b.run(['rev-parse', 'HEAD'])).trim()).toBe(rebaseHead);
    expect(readFileSync(join(b.cwd, 'people/x/note.md'), 'utf8')).toContain('<<<<<<<');
  });
});
