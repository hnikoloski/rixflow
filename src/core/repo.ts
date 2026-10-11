import { execFile } from 'node:child_process';
import { HubError } from './types';

export type RunGit = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; stdout: string }>;

const LS_REMOTE_TIMEOUT_MS = 15_000;
const GH_TIMEOUT_MS = 60_000;
const REPO_NAME = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/;

const HOST = /^[A-Za-z0-9.-]+$/;
const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;

// The https URL an anonymous visitor would use, without any credentials; null when it cannot be derived.
export function anonymousUrl(url: string): string | null {
  const u = url.trim();
  const scp = /^[A-Za-z0-9._-]+@([^:/\s]+):([^\s]+)$/.exec(u);
  if (scp) return HOST.test(scp[1]) && PATH.test(scp[2]) ? `https://${scp[1]}/${scp[2]}` : null;
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' && p.protocol !== 'ssh:') return null;
    const path = p.pathname.replace(/^\/+/, '');
    if (!p.hostname || !HOST.test(p.hostname) || !PATH.test(path)) return null;
    return p.protocol === 'https:' ? `https://${p.host}/${path}` : `https://${p.hostname}/${path}`;
  } catch {
    return null;
  }
}

const systemGit: RunGit = (args, env) =>
  new Promise((resolve) => {
    execFile('git', args, { env, timeout: LS_REMOTE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout) =>
      resolve({ ok: !err, stdout: err ? '' : stdout }));
  });

export async function isPublicRepo(url: string, run: RunGit = systemGit): Promise<boolean> {
  const anon = anonymousUrl(url);
  if (!anon) return false;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never',
  };
  try {
    return (await run(['-c', 'credential.helper=', 'ls-remote', anon], env)).ok;
  } catch {
    return false;
  }
}

export async function checkReach(url: string, run: RunGit = systemGit): Promise<{ ok: boolean; empty: boolean }> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
  try {
    const r = await run(['ls-remote', url], env);
    return r.ok ? { ok: true, empty: r.stdout.trim() === '' } : { ok: false, empty: false };
  } catch {
    return { ok: false, empty: false };
  }
}

export interface Gh { available(): Promise<boolean>; createPrivate(name: string): Promise<string> }

const runGh = (args: string[]): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: GH_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout) =>
      resolve({ ok: !err, stdout: err ? '' : stdout }));
  });

export function systemGh(): Gh {
  return {
    available: async () => (await runGh(['auth', 'status'])).ok,
    async createPrivate(name) {
      if (!REPO_NAME.test(name)) throw new HubError('BAD_REPO_NAME', 'Repository name must be "owner/repo" or "repo" (letters, digits, . _ -).');
      if (!(await runGh(['repo', 'create', name, '--private'])).ok) throw new HubError('GH_FAILED', 'gh could not create the repository.');
      const view = await runGh(['repo', 'view', name, '--json', 'sshUrl']);
      let ssh: unknown;
      try { ssh = (JSON.parse(view.stdout) as { sshUrl?: unknown }).sshUrl; } catch { /* handled below */ }
      if (!view.ok || typeof ssh !== 'string' || !ssh) throw new HubError('GH_FAILED', 'gh could not read the new repository URL.');
      return ssh;
    },
  };
}
