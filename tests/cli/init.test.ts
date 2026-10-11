import { describe, expect, it } from 'vitest';
import { chmodSync, lstatSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ACCESS_HINT, MCP_ALLOW_RULE, PRE_COMMIT_MARKER, refreshHookCopy, runInit, applyClaudeSettings, installPreCommit, mergeClaudeSettings, preCommitScript, type InitIo,
} from '../../src/cli/init';

const tmp = () => mkdtempSync(join(tmpdir(), 'init-'));
const io = (answers: string[]): InitIo & { logs: string[]; asked: string[] } => {
  const logs: string[] = [];
  const asked: string[] = [];
  return {
    logs, asked,
    ask: async (q) => { asked.push(q); return answers.shift() ?? ''; },
    askHidden: async () => '',
    log: (t) => { logs.push(t); },
  };
};

describe('mergeClaudeSettings', () => {
  it('adds the MCP allow rule and the hub directory, keeping existing settings', () => {
    const { settings, changes } = mergeClaudeSettings({ model: 'opus', permissions: { allow: ['Bash(git status)'] } }, '/home/u/.rixflow');
    expect(settings).toEqual({
      model: 'opus',
      permissions: { allow: ['Bash(git status)', MCP_ALLOW_RULE], additionalDirectories: ['/home/u/.rixflow'] },
    });
    expect(changes).toHaveLength(2);
  });
  it('is idempotent', () => {
    const first = mergeClaudeSettings({}, '/h').settings;
    expect(mergeClaudeSettings(first, '/h').changes).toEqual([]);
    expect(mergeClaudeSettings(first, '/h').settings).toEqual(first);
  });
  it('keeps unrelated keys, nested permission keys and order, and does not mutate its input', () => {
    const input = {
      hooks: { Stop: [{ x: 1 }] }, env: { A: '1' },
      permissions: { deny: ['Bash(rm *)'], defaultMode: 'plan', allow: ['A'], additionalDirectories: ['/x'] },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const { settings } = mergeClaudeSettings(input, '/h');
    expect(input).toEqual(snapshot);
    expect(settings).toMatchObject({ hooks: snapshot.hooks, env: snapshot.env });
    expect((settings.permissions as Record<string, unknown>).deny).toEqual(['Bash(rm *)']);
    expect((settings.permissions as Record<string, unknown>).defaultMode).toBe('plan');
    expect((settings.permissions as Record<string, unknown>).allow).toEqual(['A', MCP_ALLOW_RULE]);
    expect((settings.permissions as Record<string, unknown>).additionalDirectories).toEqual(['/x', '/h']);
  });
  it('treats trailing slashes as the same directory', () => {
    const { settings, changes } = mergeClaudeSettings({ permissions: { allow: [MCP_ALLOW_RULE], additionalDirectories: ['/h/'] } }, '/h');
    expect(changes).toEqual([]);
    expect((settings.permissions as Record<string, unknown>).additionalDirectories).toEqual(['/h/']);
    const second = mergeClaudeSettings({ permissions: { additionalDirectories: ['/h'] } }, '/h/');
    expect((second.settings.permissions as Record<string, unknown>).additionalDirectories).toEqual(['/h']);
  });
  it('throws instead of dropping malformed existing values', () => {
    expect(() => mergeClaudeSettings({ permissions: 'x' }, '/h')).toThrow();
    expect(() => mergeClaudeSettings({ permissions: { allow: 'x' } }, '/h')).toThrow();
    expect(() => mergeClaudeSettings({ permissions: { additionalDirectories: {} } }, '/h')).toThrow();
  });
});

describe('applyClaudeSettings', () => {
  it('shows the changes, asks, then writes atomically with a backup', async () => {
    const dir = tmp();
    const path = join(dir, '.claude', 'settings.json');
    mkdirSync(join(dir, '.claude'));
    writeFileSync(path, JSON.stringify({ model: 'opus', custom: { a: 1 } }));
    const i = io(['y']);
    await applyClaudeSettings(i, path, '/hub');
    expect(i.logs.join('\n')).toContain(MCP_ALLOW_RULE);
    expect(i.logs.join('\n')).toContain(path);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.model).toBe('opus');
    expect(written.custom).toEqual({ a: 1 });
    expect(written.permissions.allow).toEqual([MCP_ALLOW_RULE]);
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8'))).toEqual({ model: 'opus', custom: { a: 1 } });
    expect(readdirSync(join(dir, '.claude')).sort()).toEqual(['settings.json', 'settings.json.bak']);
  });
  it('writes nothing when declined', async () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{"a":1}');
    await applyClaudeSettings(io(['n']), path, '/hub');
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}');
    expect(existsSync(`${path}.bak`)).toBe(false);
  });
  it('asks nothing and writes nothing when already applied (second run)', async () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    await applyClaudeSettings(io(['y']), path, '/hub');
    const before = readFileSync(path, 'utf8');
    const i = io([]);
    await applyClaudeSettings(i, path, '/hub');
    expect(i.asked).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('keeps a symlinked settings.json a symlink and updates its target', async () => {
    const dir = tmp();
    const target = join(dir, 'dotfiles-settings.json');
    writeFileSync(target, '{"keep":1}');
    const link = join(dir, 'settings.json');
    symlinkSync(target, link);
    await applyClaudeSettings(io(['y']), link, '/hub');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ keep: 1, permissions: { allow: [MCP_ALLOW_RULE] } });
  });
  it('refuses to touch a settings file that is not valid JSON', async () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{ not json');
    await expect(applyClaudeSettings(io(['y']), path, '/hub')).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
  it('preserves the file mode', async () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{}');
    chmodSync(path, 0o600);
    await applyClaudeSettings(io(['y']), path, '/hub');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('preCommitScript', () => {
  it('runs verify-commit with node, single-quoting the path', () => {
    expect(preCommitScript('/cfg/hub.cjs', '/cfg')).toBe(
      `#!/bin/sh\n${PRE_COMMIT_MARKER}\nRIXFLOW_CONFIG_DIR='/cfg'\nexport RIXFLOW_CONFIG_DIR\nexec node '/cfg/hub.cjs' verify-commit\n`,
    );
  });
  it('survives spaces, quotes and shell metacharacters in the path', () => {
    const dir = tmp();
    const cli = join(dir, `we ird'$(touch pwned)"; \`x\`.cjs`);
    writeFileSync(cli, 'console.log(process.argv.slice(2).join(","), process.env.RIXFLOW_CONFIG_DIR)');
    const script = join(dir, 'hook.sh');
    const cfg = join(dir, `c f'g$(touch pwned2)`);
    writeFileSync(script, preCommitScript(cli, cfg));
    const r = spawnSync('sh', [script], { encoding: 'utf8', cwd: dir, env: { ...process.env, RIXFLOW_CONFIG_DIR: '/other' } });
    expect(r.stdout.trim()).toBe(`verify-commit ${cfg}`);
    expect(existsSync(join(dir, 'pwned2'))).toBe(false);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });
});

describe('installPreCommit', () => {
  it('copies the cli and writes an executable hook, creating the hooks dir', () => {
    const dir = tmp();
    const hub = join(dir, 'hub');
    mkdirSync(join(hub, '.git'), { recursive: true });
    const cli = join(dir, 'src.cjs');
    writeFileSync(cli, 'x');
    const cfg = join(dir, 'cfg');
    expect(installPreCommit(hub, cfg, cli)).toEqual([]);
    expect(readFileSync(join(cfg, 'hub.cjs'), 'utf8')).toBe('x');
    const hook = join(hub, '.git', 'hooks', 'pre-commit');
    expect(readFileSync(hook, 'utf8')).toBe(preCommitScript(join(cfg, 'hub.cjs'), cfg));
    expect(statSync(hook).mode & 0o111).toBeTruthy();
  });
});

describe('installPreCommit safety', () => {
  const setup = () => {
    const dir = tmp();
    const hub = join(dir, 'hub');
    spawnSync('git', ['init', '-q', hub], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    const cli = join(dir, 'src.cjs');
    writeFileSync(cli, 'x');
    return { hub, cli, cfg: join(dir, 'cfg') };
  };
  it('backs up a foreign pre-commit hook, but not our own on reinstall', () => {
    const { hub, cli, cfg } = setup();
    const hook = join(hub, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho theirs\n');
    const msgs = installPreCommit(hub, cfg, cli);
    expect(readFileSync(`${hook}.bak`, 'utf8')).toContain('theirs');
    expect(msgs.join('\n')).toContain('pre-commit.bak');
    writeFileSync(`${hook}.bak`, 'keep');
    expect(installPreCommit(hub, cfg, cli)).toEqual([]);
    expect(readFileSync(`${hook}.bak`, 'utf8')).toBe('keep');
  });
  it('warns when core.hooksPath disables the gate', () => {
    const { hub, cli, cfg } = setup();
    spawnSync('git', ['-C', hub, 'config', 'core.hooksPath', '/elsewhere']);
    expect(installPreCommit(hub, cfg, cli).join('\n')).toMatch(/hooksPath.*INACTIVE/);
    spawnSync('git', ['-C', hub, 'config', 'core.hooksPath', '.git/hooks']);
    expect(installPreCommit(hub, cfg, cli)).toEqual([]);
  });
});

describe('runInit clone failure', () => {
  it('prints a one-line ssh-agent / credential helper hint when its clone fails', async () => {
    const root = tmp();
    const env = { ...process.env, HOME: root, RIXFLOW_DIR: join(root, 'hub'), RIXFLOW_CONFIG_DIR: join(root, 'cfg') };
    const i = io(['yes', join(root, 'missing.git')]);
    await expect(runInit(i, '/x/hub.cjs', env)).rejects.toThrow();
    expect(i.logs).toContain(ACCESS_HINT);
    expect(ACCESS_HINT.split('\n')).toHaveLength(1);
    expect(existsSync(join(root, 'cfg'))).toBe(false);
  });
});

describe('refreshHookCopy (M8)', () => {
  it('replaces <configDir>/hub.cjs when it differs from the running bundle, and only then', () => {
    const dir = tmp();
    const cfg = join(dir, 'cfg');
    mkdirSync(cfg);
    const running = join(dir, 'dist', 'hub.cjs');
    mkdirSync(join(dir, 'dist'));
    writeFileSync(running, 'new bundle');
    expect(refreshHookCopy(cfg, running)).toBe(false); // no copy yet: init's job
    expect(existsSync(join(cfg, 'hub.cjs'))).toBe(false);
    writeFileSync(join(cfg, 'hub.cjs'), 'old bundle');
    expect(refreshHookCopy(cfg, running)).toBe(true);
    expect(readFileSync(join(cfg, 'hub.cjs'), 'utf8')).toBe('new bundle');
    expect(refreshHookCopy(cfg, running)).toBe(false);
    expect(readdirSync(cfg)).toEqual(['hub.cjs']);
  });
  it('never throws', () => {
    expect(refreshHookCopy('/nonexistent/cfg', '/nonexistent/hub.cjs')).toBe(false);
    expect(refreshHookCopy(tmp(), null)).toBe(false);
  });
});
