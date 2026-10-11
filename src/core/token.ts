import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrackerKind } from './tickets/types';
import { HubError } from './types';

export type Exec = (cmd: string, args: string[], input?: string) => string;

// execFile-style only (no shell). stderr is ignored so keychain tools cannot echo secrets.
// A keyring prompt that never answers must not hang hooks.
export const KEYCHAIN_TIMEOUT_MS = 5000;

const defaultExec: Exec = (cmd, args, input) =>
  execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS });

const tokenFile = (configDir: string, kind: TrackerKind): string => join(configDir, `${kind}-token`);

// One keychain item per system and hub user (`<kind>:<user>`), so two personas on one machine never
// share a token. The legacy single `asana` account is still read as a fallback for Asana.
const LEGACY_ACCOUNT = 'asana';
const accountFor = (kind: TrackerKind, user?: string): string => (user ? `${kind}:${user}` : kind);
const ENV_VAR: Record<TrackerKind, string> = { asana: 'ASANA_TOKEN', jira: 'JIRA_TOKEN' };

function keychainLookup(exec: Exec, account: string): string | null {
  try {
    const out = process.platform === 'darwin'
      ? exec('security', ['find-generic-password', '-s', 'rixflow', '-a', account, '-w'])
      : exec('secret-tool', ['lookup', 'service', 'rixflow', 'account', account]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

function keychainGet(exec: Exec, kind: TrackerKind, user?: string): string | null {
  const own = user ? keychainLookup(exec, accountFor(kind, user)) : null;
  if (own || kind !== 'asana') return own;
  return keychainLookup(exec, LEGACY_ACCOUNT);
}

function keychainSet(exec: Exec, token: string, kind: TrackerKind, user?: string): boolean {
  const account = accountFor(kind, user);
  try {
    if (process.platform === 'darwin') {
      exec('security', ['add-generic-password', '-U', '-s', 'rixflow', '-a', account, '-w', token]);
    } else {
      exec('secret-tool', ['store', '--label=rixflow', 'service', 'rixflow', 'account', account], token);
    }
    return true;
  } catch {
    return false;
  }
}

// Creates the config directory owner-only. An existing directory that is group- or
// world-accessible is tightened to 0700.
function ensurePrivateDir(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (statSync(configDir).mode & 0o077) chmodSync(configDir, 0o700);
}

export function getToken(
  configDir: string,
  env: Record<string, string | undefined> = process.env,
  exec: Exec = defaultExec,
  user?: string,
  kind: TrackerKind = 'asana',
): string | null {
  const fromEnv = env[ENV_VAR[kind]]?.trim();
  if (fromEnv) return fromEnv;
  const fromKeychain = keychainGet(exec, kind, user);
  if (fromKeychain) return fromKeychain;
  const file = tokenFile(configDir, kind);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null;
}

export function setToken(configDir: string, token: string, exec: Exec = defaultExec, user?: string, kind: TrackerKind = 'asana'): 'keychain' | 'file' {
  if (!/^\S+$/.test(token)) throw new HubError('BAD_TOKEN', 'Token must be a single non-empty line without spaces');
  if (keychainSet(exec, token, kind, user)) return 'keychain';
  ensurePrivateDir(configDir);
  const file = tokenFile(configDir, kind);
  // Remove any previous file (or symlink) first: writeFileSync keeps the mode of an existing
  // file, so 'wx' + mode 0600 on a fresh file is what guarantees the mode from creation.
  rmSync(file, { force: true });
  writeFileSync(file, token, { mode: 0o600, flag: 'wx' });
  return 'file';
}
