import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { AsanaClient } from '../core/asana';
import { configDir as getConfigDir, homeDir, hubDir as getHubDir, normalizeDir, saveUserConfig } from '../core/config';
import { hubCommand } from '../core/command';
import { Git } from '../core/git';
import { describeSync, persistHub } from '../core/runtime';
import { mergeHubGitignore } from '../core/template';
import { loadTeam } from '../core/team';
import { setToken } from '../core/token';
import { HubError } from '../core/types';
import type { WizardDeps } from './wizard/connect';
import { runCreate } from './wizard/create';
import { runJoin } from './wizard/join';
import { loadProgress } from './wizard/progress';
import { choose } from './wizard/prompts';

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

// One shared readline interface (created lazily) feeds a line queue, so answers buffered from piped
// input are never lost between prompts. `closed` flips only when a prompt had to return '' because
// stdin ended (EOF, Ctrl+D or Ctrl+C), never while buffered lines remain.
export function terminalIo(): InitIo {
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let rl: ReturnType<typeof createInterface> | undefined;
  let eof = false;
  let muted = false;
  const self: InitIo = { closed: false, ask: (q) => read(q, false), askHidden: (q) => read(q, true), log: (t) => console.log(t) };

  function start(): ReturnType<typeof createInterface> {
    if (rl) return rl;
    const r = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
    const hook = r as unknown as { _writeToOutput?: (s: string) => void };
    const write = typeof hook._writeToOutput === 'function' ? hook._writeToOutput.bind(r) : undefined;
    if (write) hook._writeToOutput = (str) => { if (!muted) write(str); };
    else {
      // Fallback: mute the output stream itself, only while a hidden prompt is active.
      const out = process.stdout;
      const orig = out.write.bind(out) as (...a: unknown[]) => boolean;
      (out as unknown as { write: (...a: unknown[]) => boolean }).write = (...a) => (muted ? true : orig(...a));
    }
    r.on('line', (l) => { const w = waiters.shift(); if (w) w(l); else lines.push(l); });
    const end = () => { eof = true; for (const w of waiters.splice(0)) w(''); };
    r.on('close', end);
    r.on('SIGINT', () => { r.close(); });
    rl = r;
    return r;
  }

  async function read(q: string, hidden: boolean): Promise<string> {
    const queued = lines.shift();
    if (queued !== undefined) { process.stdout.write(q); if (hidden && process.stdin.isTTY) process.stdout.write('\n'); return queued.trim(); }
    if (self.closed || eof || process.stdin.readableEnded || process.stdin.destroyed) { self.closed = true; return ''; }
    const r = start();
    r.resume();
    r.setPrompt(q);
    r.prompt();
    muted = hidden;
    let line: string;
    try {
      line = await new Promise<string>((res) => { waiters.push(res); });
    } finally {
      muted = false;
    }
    if (hidden && process.stdin.isTTY) process.stdout.write('\n');
    if (eof && line === '') self.closed = true;
    else r.pause();
    return line.trim();
  }
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
export async function withAccessHint(io: InitIo, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (e) {
    io.log(ACCESS_HINT);
    throw e;
  }
}

// Consent first. A machine that is not set up yet (no config.yml, or an unfinished wizard) gets
// "join or create"; an already set-up machine keeps the original init.
export async function runInit(
  io: InitIo, cliPath: string, env: NodeJS.ProcessEnv = process.env, deps: Omit<WizardDeps, 'cliPath'> = {},
): Promise<void> {
  const configDir = getConfigDir(env);

  io.log('Everything you save to the team hub (notes, session summaries, checkpoints) is visible to the whole team.');
  if ((await io.ask('Type "yes" to continue: ')).toLowerCase() !== 'yes') throw new HubError('ABORTED', 'init cancelled');

  const progress = loadProgress(configDir);
  if (!progress && existsSync(join(configDir, 'config.yml'))) return reinit(io, cliPath, env);
  const flow = progress?.flow ?? await choose(io, 'Join an existing team, or create a new one?', [
    { value: 'join', label: 'Join an existing team' },
    { value: 'create', label: 'Create a new team' },
  ]);
  const all: WizardDeps = { ...deps, cliPath };
  return flow === 'join' ? runJoin(io, all, env) : runCreate(io, all, env);
}

// The original init, for a machine that is already set up. Task 12 puts a menu in front of it.
async function reinit(io: InitIo, cliPath: string, env: NodeJS.ProcessEnv): Promise<void> {
  const configDir = getConfigDir(env);
  const hubDir = getHubDir(env);

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
