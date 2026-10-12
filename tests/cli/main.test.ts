import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import YAML from 'yaml';
import { getToken } from '../../src/core/token';

// End-to-end: bundles the real entry point and runs it with a temp HOME/config/hub only.
let root: string;
let cli: string;
let env: NodeJS.ProcessEnv;

const run = (args: string[], input = '', extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [cli, ...args], { input, encoding: 'utf8', env: { ...env, ...extra }, timeout: 15_000 });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'main-'));
  cli = join(root, 'hub.cjs');
  buildSync({ entryPoints: ['src/cli/main.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: cli, logLevel: 'silent' });
  env = {
    PATH: process.env.PATH, HOME: join(root, 'home'),
    RIXFLOW_CONFIG_DIR: join(root, 'cfg'), RIXFLOW_DIR: join(root, 'hub'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
  };
});
describe('hub CLI', () => {
  it('hooks exit 0 and print nothing when the hub is not set up', () => {
    for (const ev of ['session-start', 'prompt', 'precompact', 'session-end', 'bogus']) {
      const r = run(['hook', ev], '{"session_id":"s","transcript_path":"/t"}');
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(run(['hook', 'session-start'], 'not json').status).toBe(0);
  });

  it('hooks do nothing under RIXFLOW_CHILD=1', () => {
    const r = run(['hook', 'session-start'], '{"session_id":"s"}', { RIXFLOW_CHILD: '1' });
    expect([r.status, r.stdout]).toEqual([0, '']);
  });

  it('bootstrap rejects bad input without creating anything', () => {
    const bad = run(['bootstrap', join(root, 'bad'), '--members', '../x:dev']);
    expect(bad.status).toBe(1);
    expect(existsSync(join(root, 'bad'))).toBe(false);
    expect(run(['bootstrap', join(root, 'bad2'), '--members', 'a:boss']).status).toBe(1);
  });

  it('sync --json prints null before setup', () => {
    const r = run(['sync', '--json']);
    expect([r.status, r.stdout]).toEqual([0, 'null\n']);
  });

  it('status prints JSON and exits 0 before setup', () => {
    const r = run(['status', '--json', '--no-sync']);
    expect(r.status).toBe(0);
    const s = JSON.parse(r.stdout);
    expect(s).toMatchObject({ v: 2, initialized: false, problems: ['setup needed'] });
  });

  describe('with an initialised hub', () => {
    beforeAll(() => {
      const made = run(['bootstrap', env.RIXFLOW_DIR!, '--members', 'me:dev,pm:pm']);
      expect(made.status).toBe(0);
      mkdirSync(env.RIXFLOW_CONFIG_DIR!, { recursive: true });
      writeFileSync(join(env.RIXFLOW_CONFIG_DIR!, 'config.yml'), YAML.stringify({
        name: 'me', role: 'dev', projectsRoot: join(root, 'projects'), siteFolders: {}, taskSites: {},
      }));
    });

    it('sync --json prints the sync result as JSON', () => {
      const r = run(['sync', '--json']);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 'offline', detail: 'no remote configured', conflicts: [] });
    });

    it('session-start prints the session note and exits 0', () => {
      const r = run(['hook', 'session-start'], '{"session_id":"abc"}');
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('[rixflow] session abc');
    });

    it('verify-commit blocks edits to another person and passes own changes (installed hook)', () => {
      const hub = env.RIXFLOW_DIR!;
      const git = (...a: string[]) => spawnSync('git', ['-C', hub, ...a], { encoding: 'utf8', env });
      const hook = join(hub, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, `#!/bin/sh\nexec node '${cli}' verify-commit\n`, { mode: 0o755 });
      writeFileSync(join(hub, 'people', 'pm', '_index.md'), 'tampered');
      git('add', '-A');
      const blocked = git('commit', '-q', '-m', 'x');
      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain('people/pm/_index.md');
      git('reset', '-q', '--hard');
      writeFileSync(join(hub, 'people', 'me', 'n.md'), 'ok');
      git('add', '-A');
      expect(git('commit', '-q', '-m', 'y').status).toBe(0);
    });

    it('verify-commit fails closed outside a repo', () => {
      const r = spawnSync(process.execPath, [cli, 'verify-commit'], { cwd: mkdtempSync(join(tmpdir(), 'nr-')), encoding: 'utf8', env });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('commit blocked');
    });

    it('summary exits 0 quietly even when the transcript is missing or the trigger is bad', () => {
      for (const trigger of ['session-end', 'nonsense']) {
        const r = run(['summary', '--session', 's', '--transcript', join(root, 'missing.jsonl'), '--trigger', trigger]);
        expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
      }
      const log = readFileSync(join(env.RIXFLOW_CONFIG_DIR!, 'summary-errors.log'), 'utf8');
      expect(log).toContain('nonsense');
      expect(log).toMatch(/\ts\tskip\tno transcript/);
    });

    it('refreshes a stale pre-commit copy of the CLI on start (M8)', () => {
      const copy = join(env.RIXFLOW_CONFIG_DIR!, 'hub.cjs');
      writeFileSync(copy, '// old bundle');
      expect(run(['scrub'], 'x').status).toBe(0);
      expect(readFileSync(copy, 'utf8')).toBe(readFileSync(cli, 'utf8'));
    });

    it('summary logs a failing claude (scrubbed stderr) when the worker runs it', () => {
      const bin = join(root, 'fakebin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "model unavailable https://u:pw@x.example.com/" >&2\nexit 3\n', { mode: 0o755 });
      const t = join(root, 'big.jsonl');
      writeFileSync(t, JSON.stringify({ type: 'user', message: { content: 'z'.repeat(700) } }) + '\n');
      const r = run(['summary', '--session', 'w-1', '--transcript', t, '--trigger', 'precompact'], '', { PATH: `${bin}:${env.PATH}` });
      expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
      const last = readFileSync(join(env.RIXFLOW_CONFIG_DIR!, 'summary-errors.log'), 'utf8').trim().split('\n').at(-1)!;
      expect(last).toMatch(/\tw-1\tfail\tclaude run failed\t.*model unavailable/);
      expect(last).not.toContain('u:pw@');
    });
  });

  // A PATH without secret-tool / security makes the keychain fail, so the token lands in the 0600 file.
  describe('token set', () => {
    const noKeychain = () => { throw new Error('no keychain'); };
    const machine = (name: string, workflow?: string) => {
      const base = join(root, name);
      const e = { ...env, HOME: join(base, 'home'), RIXFLOW_CONFIG_DIR: join(base, 'cfg'), RIXFLOW_DIR: join(base, 'hub') };
      expect(run(['bootstrap', e.RIXFLOW_DIR, '--members', 'me:dev'], '', e).status).toBe(0);
      if (workflow) writeFileSync(join(e.RIXFLOW_DIR, 'config', 'workflow.yml'), workflow);
      mkdirSync(e.RIXFLOW_CONFIG_DIR, { recursive: true });
      writeFileSync(join(e.RIXFLOW_CONFIG_DIR, 'config.yml'), YAML.stringify({ name: 'me', role: 'dev', projectsRoot: join(base, 'p') }));
      const emptyPath = join(base, 'nobin');
      mkdirSync(emptyPath);
      return { ...e, PATH: emptyPath };
    };

    it("asks with Jira's wording on a Jira hub and stores the token where getToken finds it", () => {
      const e = machine('tok-jira', YAML.stringify({
        requires: '0.3.0', tracker: { type: 'jira', url: 'https://acme.atlassian.net', flavor: 'cloud', projects: ['WEB'] },
        project: { from: 'component', values: { 'Acme site': 'AC' } },
      }));
      const r = run(['token', 'set'], 'jira-tok-9\n', e);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Jira token (input masked): ');
      expect(r.stdout).not.toContain('Asana');
      expect(r.stdout).not.toContain('jira-tok-9');
      expect(r.stdout).toContain('stored in file');
      expect(getToken(e.RIXFLOW_CONFIG_DIR, {}, noKeychain, 'me', 'jira')).toBe('jira-tok-9');
      expect(existsSync(join(e.RIXFLOW_CONFIG_DIR, 'asana-token'))).toBe(false);
    });

    it("asks with Asana's wording on a hub without workflow.yml", () => {
      const e = machine('tok-asana');
      const r = run(['token', 'set'], 'asana-tok-9\n', e);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Asana token (input masked): ');
      expect(getToken(e.RIXFLOW_CONFIG_DIR, {}, noKeychain, 'me', 'asana')).toBe('asana-tok-9');
      expect(existsSync(join(e.RIXFLOW_CONFIG_DIR, 'jira-token'))).toBe(false);
    });
  });
});
