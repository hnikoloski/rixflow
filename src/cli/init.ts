import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AsanaClient } from '../core/asana';
import { configDir as getConfigDir, homeDir, hubDir as getHubDir, normalizeDir, saveUserConfig } from '../core/config';
import { hubCommand } from '../core/command';
import { Git } from '../core/git';
import { describeSync, persistHub } from '../core/runtime';
import { mergeHubGitignore } from '../core/template';
import { loadTeam } from '../core/team';
import { setToken } from '../core/token';
import { HubError } from '../core/types';

export const MCP_ALLOW_RULE = 'mcp__plugin_rixflow_hub__*';

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function stringList(v: unknown, label: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new HubError('BAD_SETTINGS', `${label} in settings.json is not a list; refusing to overwrite it`);
  return [...v] as string[];
}

// Pure: never mutates its input and never drops keys. Malformed existing values
// throw instead of being replaced.
export function mergeClaudeSettings(settings: Record<string, unknown>, hubDir: string): { settings: Record<string, unknown>; changes: string[] } {
  if (settings.permissions !== undefined && !isRecord(settings.permissions)) {
    throw new HubError('BAD_SETTINGS', 'permissions in settings.json is not an object; refusing to overwrite it');
  }
  const permissions = { ...(settings.permissions as Record<string, unknown> | undefined) };
  const allow = stringList(permissions.allow, 'permissions.allow');
  const dirs = stringList(permissions.additionalDirectories, 'permissions.additionalDirectories');
  const changes: string[] = [];
  if (!allow.includes(MCP_ALLOW_RULE)) {
    allow.push(MCP_ALLOW_RULE);
    changes.push(`permissions.allow += ${MCP_ALLOW_RULE}`);
  }
  const norm = (d: string) => (d.length > 1 ? d.replace(/\/+$/, '') : d);
  if (!dirs.some((d) => norm(String(d)) === norm(hubDir))) {
    dirs.push(hubDir);
    changes.push(`permissions.additionalDirectories += ${hubDir}`);
  }
  return { settings: { ...settings, permissions: { ...permissions, allow, additionalDirectories: dirs } }, changes };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const PRE_COMMIT_MARKER = '# rixflow pre-commit (managed)';

// Pins the config dir it was installed with, so a manual `git commit` in a demo persona's clone
// verifies as that persona, not as whoever the default config dir belongs to.
export function preCommitScript(cliPath: string, configDir: string): string {
  return `#!/bin/sh\n${PRE_COMMIT_MARKER}\nRIXFLOW_CONFIG_DIR=${shellQuote(configDir)}\nexport RIXFLOW_CONFIG_DIR\nexec node ${shellQuote(cliPath)} verify-commit\n`;
}

export { refreshHookCopy } from '../core/hookcopy';

// Returns messages for the user (backups, warnings).
export function installPreCommit(hubDir: string, configDir: string, cliPath: string): string[] {
  const messages: string[] = [];
  mkdirSync(configDir, { recursive: true });
  const cliCopy = join(configDir, 'hub.cjs');
  copyFileSync(cliPath, cliCopy);
  const hooksDir = join(hubDir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, 'pre-commit');
  if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(PRE_COMMIT_MARKER)) {
    copyFileSync(hook, `${hook}.bak`);
    messages.push(`Existing pre-commit hook backed up to ${hook}.bak and replaced.`);
  }
  writeFileSync(hook, preCommitScript(cliCopy, configDir));
  chmodSync(hook, 0o755);
  let hooksPath = '';
  try {
    hooksPath = execFileSync('git', ['-C', hubDir, 'config', 'core.hooksPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // unset
  }
  if (hooksPath && hooksPath !== '.git/hooks' && resolve(hubDir, hooksPath) !== resolve(hooksDir)) {
    messages.push(`WARNING: core.hooksPath is set to "${hooksPath}", so the pre-commit ownership gate is INACTIVE for the hub.`);
  }
  return messages;
}

export interface InitIo {
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
  log(text: string): void;
  // Set once stdin has hit EOF; the wizard prompt helpers then abort instead of looping.
  closed?: boolean;
}

export function terminalIo(): InitIo {
  const self: InitIo = {
    closed: false,
    async ask(q) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answered = false;
      const eof = new Promise<string>((res) => rl.once('close', () => { if (!answered) self.closed = true; res(''); }));
      const a = await Promise.race([rl.question(q).then((x) => { answered = true; return x; }), eof]);
      rl.close();
      return a.trim();
    },
    async askHidden(q) {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      process.stdout.write(q);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
      const a = await rl.question('');
      rl.close();
      process.stdout.write('\n');
      return a.trim();
    },
    log: (t) => console.log(t),
  };
  return self;
}

// Shows the exact changes, asks, backs up the old file, then writes a temp file
// and renames it into place. An unparseable settings file is never touched.
export async function applyClaudeSettings(io: InitIo, linkPath: string, hubDir: string): Promise<void> {
  let settingsPath = linkPath;
  let current: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      throw new HubError('BAD_SETTINGS', `${settingsPath} is not valid JSON; fix it by hand and re-run init`);
    }
    if (!isRecord(parsed)) throw new HubError('BAD_SETTINGS', `${settingsPath} is not a JSON object`);
    current = parsed;
  }
  const { settings, changes } = mergeClaudeSettings(current, hubDir);
  if (!changes.length) return;
  io.log(`These changes will be made to ${settingsPath}:\n${changes.map((c) => `  - ${c}`).join('\n')}`);
  if ((await io.ask('Apply? (y/n): ')).toLowerCase() !== 'y') {
    io.log('Skipped. You will get permission prompts for RixFlow tools.');
    return;
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  const existed = existsSync(settingsPath);
  if (existed) settingsPath = realpathSync(settingsPath);
  if (existed) copyFileSync(settingsPath, `${settingsPath}.bak`);
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: existed ? statSync(settingsPath).mode & 0o777 : 0o644 });
    renameSync(tmp, settingsPath);
  } finally {
    rmSync(tmp, { force: true });
  }
  io.log(`Settings updated${existed ? ' (backup: settings.json.bak)' : ''}.`);
}

export const ACCESS_HINT =
  'Hint: RixFlow syncs in the background and cannot ask for passwords. For an ssh URL, load your key into ssh-agent ' +
  `(ssh-add); for an https URL, set up a git credential helper. Then run again: ${hubCommand('init')}`;

// Hooks and tools sync without a terminal, so access that only works with a prompt is explained here.
async function withAccessHint(io: InitIo, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (e) {
    io.log(ACCESS_HINT);
    throw e;
  }
}

export async function runInit(io: InitIo, cliPath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configDir = getConfigDir(env);
  const hubDir = getHubDir(env);

  io.log('Everything you save to the team hub (notes, session summaries, checkpoints) is visible to the whole team.');
  if ((await io.ask('Type "yes" to continue: ')).toLowerCase() !== 'yes') throw new HubError('ABORTED', 'init cancelled');

  if (!existsSync(join(hubDir, '.git'))) {
    const url = await io.ask('Hub git URL (e.g. git@github.com:org/rixflow-hub.git): ');
    // The only git call allowed to prompt: init runs in a terminal the user is watching.
    await withAccessHint(io, () => new Git(homeDir(env), env, { interactive: true }).run(['clone', '-q', '--', url, hubDir]));
  } else {
    await withAccessHint(io, () => new Git(hubDir, env).run(['pull', '-q', '--rebase']));
  }

  const team = loadTeam(hubDir);
  io.log(`Team: ${team.map((m) => `${m.name} (${m.role})`).join(', ')}`);
  const name = await io.ask('Your name (as listed above): ');
  const member = team.find((m) => m.name === name);
  if (!member) throw new HubError('UNKNOWN_MEMBER', `${name} is not in config/team.yml; add them first`);

  const defaultRoot = join(homeDir(env), 'projects');
  const projectsRoot = normalizeDir((await io.ask(`Projects folder [${defaultRoot}]: `)) || defaultRoot, env);

  const token = await io.askHidden('Asana personal access token (input hidden): ');
  const me = await new AsanaClient(token).getMe();
  let workspace = me.workspaces[0];
  if (me.workspaces.length > 1) {
    me.workspaces.forEach((w, i) => io.log(`${i + 1}. ${w.name}`));
    workspace = me.workspaces[Number(await io.ask('Workspace number: ')) - 1];
  }
  if (!workspace) throw new HubError('NO_WORKSPACE', 'no Asana workspace selected');
  io.log(`Asana token stored in ${setToken(configDir, token, undefined, name)}.`);

  saveUserConfig(configDir, {
    name, role: member.role, projectsRoot, asanaWorkspace: workspace.gid, siteFolders: {}, taskSites: {},
  });

  for (const m of installPreCommit(hubDir, configDir, cliPath)) io.log(m);
  // Hubs bootstrapped before the .gitignore existed get it now, committed as this user.
  if (mergeHubGitignore(hubDir)) {
    const res = await persistHub(hubDir, name, `chore: ignore editor files in the hub (${name})`, {}, env);
    io.log(`Added editor files (.obsidian/, .DS_Store, ...) to the hub .gitignore: ${describeSync(res)}.`);
  }
  await applyClaudeSettings(io, join(homeDir(env), '.claude', 'settings.json'), hubDir);
  io.log(`Done. Hub: ${hubDir}. Config: ${configDir}.`);
}
