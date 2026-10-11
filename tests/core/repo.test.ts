import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { anonymousUrl, checkReach, isPublicRepo, systemGh, type RunGit } from '../../src/core/repo';

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
    expect(args).toEqual([
      '-c', 'credential.helper=', '-c', 'http.extraHeader=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      'ls-remote', '--', 'https://github.com/acme/hub.git',
    ]);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('');
    expect(env.SSH_ASKPASS).toBe('');
    expect(env.GCM_INTERACTIVE).toBe('never');
  });
  it('is false when git fails or throws', async () => {
    expect(await isPublicRepo('git@github.com:acme/hub', async () => ({ ok: false, stdout: '' }))).toBe(false);
    expect(await isPublicRepo('git@github.com:acme/hub', async () => { throw new Error('x'); })).toBe(false);
  });
  it('uses a clean env and an empty cwd', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c', GIT_CONFIG_PARAMETERS: "'a.b=c'", GIT_SSH_COMMAND: 'ssh -i k', GIT_SSH: 'ssh', GIT_DIR: '/x' });
    try {
      const run = vi.fn<RunGit>(async () => ({ ok: false, stdout: '' }));
      await isPublicRepo('git@github.com:acme/hub.git', run);
      const [, env, cwd] = run.mock.calls[0];
      for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_DIR']) expect(env[k]).toBeUndefined();
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
      expect(env.HOME).toBe(cwd);
      expect(env.XDG_CONFIG_HOME).toBe(cwd);
      expect(existsSync(cwd!)).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
  it('real git sees no user or system config under that env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anoncfg-'));
    const cfg = join(root, 'gitconfig');
    writeFileSync(cfg, '[url "git@unreachable.example.com:"]\n\tinsteadOf = https://github.com/\n');
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = cfg;
    process.env.HOME = root;
    try {
      let out = '';
      await isPublicRepo('https://github.com/acme/hub', async (_a, env, cwd) => {
        out = execFileSync('git', ['config', '--list', '--show-origin'], { env, cwd, encoding: 'utf8' });
        return { ok: false, stdout: '' };
      });
      expect(out).not.toContain('insteadOf');
      expect(out).not.toContain('unreachable.example.com');
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved;
    }
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
    expect(args).toEqual(['ls-remote', '--', 'git@github.com:acme/hub.git']);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
  });
  it('rejects option-like urls without running git', async () => {
    const run = vi.fn<RunGit>();
    expect(await checkReach('--upload-pack=x', run)).toEqual({ ok: false, empty: false });
    expect(run).not.toHaveBeenCalled();
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
