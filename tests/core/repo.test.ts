import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { anonymousUrl, checkReach, isPublicRepo, systemGh, type RunGit } from '../../src/core/repo';
import './../gitHub';

describe('anonymousUrl', () => {
  it('maps the url shapes', () => {
    expect(anonymousUrl('git@github.com:acme/hub.git')).toBe('https://github.com/acme/hub.git');
    expect(anonymousUrl('git@github.com:acme/hub')).toBe('https://github.com/acme/hub');
    expect(anonymousUrl('ssh://git@github.com/acme/hub.git')).toBe('https://github.com/acme/hub.git');
    expect(anonymousUrl('ssh://git@example.com:2222/acme/hub')).toBe('https://example.com/acme/hub');
    expect(anonymousUrl('https://github.com/acme/hub')).toBe('https://github.com/acme/hub');
  });
  it('strips userinfo from https', () => {
    expect(anonymousUrl('https://tok:x@github.com/acme/hub')).toBe('https://github.com/acme/hub');
    expect(anonymousUrl('https://token@github.com/o/r')).toBe('https://github.com/o/r');
  });
  it('returns null for unparseable or local', () => {
    for (const u of ['/tmp/hub.git', 'file:///tmp/hub.git', 'relative/path', '', 'http://example.com/a/b', 'https://']) {
      expect(anonymousUrl(u)).toBeNull();
    }
  });
});

describe('isPublicRepo', () => {
  it('runs ls-remote anonymously on the https url', async () => {
    const run = vi.fn<RunGit>(async () => ({ ok: true, stdout: 'abc\trefs/heads/main\n' }));
    expect(await isPublicRepo('git@github.com:acme/hub.git', run)).toBe(true);
    const [args, env] = run.mock.calls[0];
    expect(args).toEqual(['-c', 'credential.helper=', 'ls-remote', 'https://github.com/acme/hub.git']);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('');
    expect(env.SSH_ASKPASS).toBe('');
    expect(env.GCM_INTERACTIVE).toBe('never');
  });
  it('is false when git fails or throws', async () => {
    expect(await isPublicRepo('git@github.com:acme/hub', async () => ({ ok: false, stdout: '' }))).toBe(false);
    expect(await isPublicRepo('git@github.com:acme/hub', async () => { throw new Error('x'); })).toBe(false);
  });
  it('is false for a local path without calling git', async () => {
    const run = vi.fn<RunGit>();
    expect(await isPublicRepo('/tmp/some/bare.git', run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('checkReach', () => {
  it('reports empty on empty stdout and sets non-interactive env', async () => {
    const run = vi.fn<RunGit>(async () => ({ ok: true, stdout: '' }));
    expect(await checkReach('git@github.com:acme/hub.git', run)).toEqual({ ok: true, empty: true });
    const [args, env] = run.mock.calls[0];
    expect(args).toEqual(['ls-remote', 'git@github.com:acme/hub.git']);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
  });
  it('reports not empty and failures', async () => {
    expect(await checkReach('u', async () => ({ ok: true, stdout: 'a\trefs/heads/main\n' }))).toEqual({ ok: true, empty: false });
    expect(await checkReach('u', async () => ({ ok: false, stdout: '' }))).toEqual({ ok: false, empty: false });
    expect(await checkReach('u', async () => { throw new Error('x'); })).toEqual({ ok: false, empty: false });
  });
  it('works against a real fresh bare repo', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'reach-')), 'r.git');
    execFileSync('git', ['init', '-q', '--bare', dir]);
    expect(await checkReach(dir)).toEqual({ ok: true, empty: true });
  });
});

describe('systemGh', () => {
  it('rejects bad repo names before calling gh', async () => {
    for (const n of ['', 'a b', 'a/b/c', '-x;rm', 'acme/hub; ls', '$(x)']) {
      await expect(systemGh().createPrivate(n)).rejects.toMatchObject({ code: 'BAD_REPO_NAME' });
    }
  });
});
