import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HubError } from './types';

export type Exec = (cmd: string, args: string[], input?: string) => string;

// execFile-style only (no shell). stderr is ignored so keychain tools cannot echo secrets.
// A keyring prompt that never answers must not hang hooks.
export const KEYCHAIN_TIMEOUT_MS = 5000;

const defaultExec: Exec = (cmd, args, input) =>
  execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS });

function tokenFile(configDir: string): string {
  return join(configDir, 'asana-token');
}

// One keychain item per hub user (`asana:<user>`), so two personas on one machine never share a
// token. The legacy single `asana` account is still read as a fallback.
const LEGACY_ACCOUNT = 'asana';
const accountFor = (user?: string): string => (user ? `asana:${user}` : LEGACY_ACCOUNT);

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

function keychainGet(exec: Exec, user?: string): string | null {
  return (user ? keychainLookup(exec, accountFor(user)) : null) ?? keychainLookup(exec, LEGACY_ACCOUNT);
}

function keychainSet(exec: Exec, token: string, user?: string): boolean {
  const account = accountFor(user);
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
): string | null {
  const fromEnv = env.ASANA_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const fromKeychain = keychainGet(exec, user);
  if (fromKeychain) return fromKeychain;
  const file = tokenFile(configDir);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || null : null;
}

export function setToken(configDir: string, token: string, exec: Exec = defaultExec, user?: string): 'keychain' | 'file' {
  if (!/^\S+$/.test(token)) throw new HubError('BAD_TOKEN', 'Token must be a single non-empty line without spaces');
  if (keychainSet(exec, token, user)) return 'keychain';
  ensurePrivateDir(configDir);
  const file = tokenFile(configDir);
  // Remove any previous file (or symlink) first: writeFileSync keeps the mode of an existing
  // file, so 'wx' + mode 0600 on a fresh file is what guarantees the mode from creation.
  rmSync(file, { force: true });
  writeFileSync(file, token, { mode: 0o600, flag: 'wx' });
  return 'file';
}
