import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Git, commitAll, ownedPaths } from '../../src/core/git';
import { persist, persistHub } from '../../src/core/runtime';
import { HUB_GITIGNORE, mergeHubGitignore } from '../../src/core/template';
import { sendMessage } from '../../src/core/messages';
import { checkChanges } from '../../src/core/ownership';
import { hubWithRemote, installOwnershipHook } from '../gitHub';

const put = (dir: string, rel: string, text = 'x') => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

describe('stray files never wedge the hub (C2)', () => {
  it('bootstrap writes and commits a root .gitignore', async () => {
    const { person, remoteFiles } = await hubWithRemote();
    const me = person('me');
    expect(remoteFiles()).toContain('.gitignore');
    const lines = readFileSync(join(me.hubDir, '.gitignore'), 'utf8').split('\n');
    for (const e of ['.obsidian/', '.trash/', '.DS_Store', 'Thumbs.db', '*.tmp-*']) expect(lines).toContain(e);
  });

  it('persist commits and pushes the own write past .obsidian/ and a teammate .DS_Store, even without a .gitignore', async () => {
    const { person, remoteFiles, git } = await hubWithRemote();
    const me = person('me');
    // An older hub, bootstrapped before the .gitignore existed.
    git(['-C', me.hubDir, 'rm', '-q', '--ignore-unmatch', '.gitignore']);
    git(['-C', me.hubDir, 'commit', '-q', '--allow-empty', '-m', 'old hub']);
    git(['-C', me.hubDir, 'push', '-q', 'origin', 'HEAD:main']);
    installOwnershipHook(me.hubDir, 'me');
    put(me.hubDir, '.obsidian/workspace.json', '{}');
    put(me.hubDir, 'people/pm/.DS_Store');
    // A stray left staged by an older version that ran `git add -A`.
    git(['-C', me.hubDir, 'add', '.obsidian/workspace.json']);
    const msg = sendMessage(me, { to: 'pm', type: 'question', body: 'hello' });
    const status = await persist(me, 'message');
    expect(status.status).toBe('ok');
    const rel = msg.path.slice(me.hubDir.length + 1);
    expect(remoteFiles()).toContain(rel);
    expect(remoteFiles().some((f) => f.startsWith('.obsidian') || f.endsWith('.DS_Store'))).toBe(false);
  });

  it('commitAll stages only the given paths', async () => {
    const { person } = await hubWithRemote();
    const me = person('me');
    const g = new Git(me.hubDir);
    put(me.hubDir, 'people/me/n.md');
    put(me.hubDir, 'people/pm/x.md');
    put(me.hubDir, 'stray.txt');
    expect(await commitAll(g, 'm', ownedPaths('me'))).toBe(true);
    const files = (await g.run(['show', '--name-only', '--format=', 'HEAD'])).split('\n').filter(Boolean);
    expect(files).toEqual(['people/me/n.md']);
    expect(ownedPaths('me')).toEqual(['people/me', 'inbox', 'shared', '.gitignore']);
    expect(() => ownedPaths('../x')).toThrow();
  });

  it('mergeHubGitignore merges missing entries into an existing clone; persistHub commits and pushes it', async () => {
    const { person, remoteFiles, git } = await hubWithRemote();
    const me = person('me');
    writeFileSync(join(me.hubDir, '.gitignore'), 'node_modules/\n.DS_Store');
    git(['-C', me.hubDir, 'add', '.gitignore']);
    git(['-C', me.hubDir, 'commit', '-q', '-m', 'custom ignore']);
    git(['-C', me.hubDir, 'push', '-q', 'origin', 'HEAD:main']);
    expect(mergeHubGitignore(me.hubDir)).toBe(true);
    const lines = readFileSync(join(me.hubDir, '.gitignore'), 'utf8').split('\n');
    expect(lines.filter((l) => l === '.DS_Store')).toHaveLength(1);
    expect(lines).toContain('node_modules/');
    for (const e of HUB_GITIGNORE) expect(lines).toContain(e);
    expect((await persistHub(me.hubDir, 'me', 'chore: ignore editor files')).status).toBe('ok');
    expect(git(['-C', me.hubDir, 'status', '--porcelain'])).toBe('');
    expect(git(['--git-dir', join(me.hubDir, '..', 'remote.git'), 'show', 'main:.gitignore'])).toContain('*.tmp-*');
    expect(mergeHubGitignore(me.hubDir)).toBe(false);
    rmSync(join(me.hubDir, '.gitignore'));
    expect(mergeHubGitignore(me.hubDir)).toBe(true);
    expect(existsSync(join(me.hubDir, '.gitignore'))).toBe(true);
    void remoteFiles;
  });

  it('the ownership check allows .gitignore at the root for anyone', () => {
    expect(checkChanges('me', [{ status: 'A', path: '.gitignore' }, { status: 'M', path: '.gitignore' }])).toEqual([]);
  });
});
