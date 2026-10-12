import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { hubCommand } from './command';
import { jiraBaseUrl } from './tickets/jira';
import { HubError, assertName, type CheckState, type Ctx, type UserConfig } from './types';

type Env = Record<string, string | undefined>;

// env.HOME when it is set, so a caller that passes an env gets paths under that home.
export function homeDir(env: Env = process.env): string {
  return env.HOME || homedir();
}

// The one way user-supplied folders are compared: a leading ~ or ~/ expands to the home directory,
// then the path is resolved (absolute, no . or .. segments, no trailing separator).
// A relative path resolves against `base` (default: the process cwd).
export function normalizeDir(dir: string, env: Env = process.env, base?: string): string {
  const expanded = dir === '~' ? homeDir(env) : dir.startsWith('~/') ? join(homeDir(env), dir.slice(2)) : dir;
  return base === undefined ? resolve(expanded) : resolve(base, expanded);
}

// True when `dir` is `folder` itself or inside it. Both are normalized first.
export function isInsideDir(dir: string, folder: string, env: Env = process.env): boolean {
  const d = normalizeDir(dir, env);
  const f = normalizeDir(folder, env);
  return d === f || d.startsWith(f.endsWith(sep) ? f : f + sep);
}

export function configDir(env: Env = process.env): string {
  return env.RIXFLOW_CONFIG_DIR ?? join(homeDir(env), '.config', 'rixflow');
}

export function hubDir(env: Env = process.env): string {
  return env.RIXFLOW_DIR ?? join(homeDir(env), '.rixflow');
}

// Relative siteFolders are relative to projectsRoot.
function normalizeFolders(v: unknown, env: Env, projectsRoot: string): Record<string, string> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [code, folder] of Object.entries(v)) if (typeof folder === 'string' && folder) out[code] = normalizeDir(folder, env, projectsRoot);
  return out;
}

export function loadUserConfig(dir: string, env: Env = process.env): UserConfig {
  const path = join(dir, 'config.yml');
  if (!existsSync(path)) throw new HubError('NOT_INITIALIZED', `No ${path}. Run in a terminal: ${hubCommand('init')}`);
  const raw = YAML.parse(readFileSync(path, 'utf8')) ?? {};
  assertName(raw.name);
  if (raw.role !== 'dev' && raw.role !== 'pm') throw new HubError('BAD_CONFIG', 'role must be dev or pm');
  if (typeof raw.projectsRoot !== 'string') throw new HubError('BAD_CONFIG', 'projectsRoot is missing');
  const projectsRoot = normalizeDir(raw.projectsRoot, env);
  return {
    name: raw.name,
    role: raw.role,
    projectsRoot,
    asanaWorkspace: raw.asanaWorkspace === undefined ? undefined : String(raw.asanaWorkspace),
    jiraEmail: typeof raw.jiraEmail === 'string' && raw.jiraEmail.trim() ? raw.jiraEmail.trim() : undefined,
    jiraUrl: typeof raw.jiraUrl === 'string' ? jiraBaseUrl(raw.jiraUrl) ?? undefined : undefined,
    siteFolders: normalizeFolders(raw.siteFolders, env, projectsRoot),
    taskSites: raw.taskSites ?? {},
  };
}

export function saveUserConfig(dir: string, cfg: UserConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yml'), YAML.stringify(cfg));
}

export function loadCtx(env: Env = process.env): Ctx {
  const dir = configDir(env);
  return { hubDir: hubDir(env), configDir: dir, user: loadUserConfig(dir, env), now: () => new Date() };
}

export function loadState(dir: string): CheckState {
  try {
    const s = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const state: CheckState = { seenTaskModified: s.seenTaskModified ?? {}, notified: s.notified ?? [] };
    if (s.lastPromptCheck) state.lastPromptCheck = s.lastPromptCheck;
    if (typeof s.summaryFailureReported === 'string') state.summaryFailureReported = s.summaryFailureReported;
    if (typeof s.offlineNoticeDay === 'string') state.offlineNoticeDay = s.offlineNoticeDay;
    if (typeof s.noRemoteNoticeDay === 'string') state.noRemoteNoticeDay = s.noRemoteNoticeDay;
    if (typeof s.publicHubCheckDay === 'string') state.publicHubCheckDay = s.publicHubCheckDay;
    if (typeof s.publicHub === 'boolean') state.publicHub = s.publicHub;
    return state;
  } catch {
    return { seenTaskModified: {}, notified: [] };
  }
}

export function saveState(dir: string, state: CheckState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
}
