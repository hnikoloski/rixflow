import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapHub } from '../src/core/template';
import type { Ctx } from '../src/core/types';

// Git identity and config isolation for code under test that builds its own Git(process.env).
export const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
Object.assign(process.env, GIT_ENV);

const git = (args: string[]) => execFileSync('git', args, { env: process.env, stdio: 'pipe', encoding: 'utf8' });

// A bootstrapped hub pushed to a local bare remote, plus a clone per person, each with its own ctx.
export async function hubWithRemote(members = ['me', 'pm']) {
  const root = mkdtempSync(join(tmpdir(), 'hubremote-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  await bootstrapHub(seed, members.map((name) => ({ name, role: name === 'pm' ? 'pm' as const : 'dev' as const })), { AC: { folder: 'acme' } });
  git(['init', '-q', '--bare', '-b', 'main', remote]);
  git(['-C', seed, 'remote', 'add', 'origin', remote]);
  git(['-C', seed, 'push', '-q', 'origin', 'main']);
  const person = (name: string): Ctx => {
    const hubDir = join(root, `clone-${name}`);
    git(['clone', '-q', remote, hubDir]);
    return {
      hubDir, configDir: join(root, `cfg-${name}`),
      user: { name, role: name === 'pm' ? 'pm' : 'dev', projectsRoot: join(root, 'projects'), siteFolders: {}, taskSites: {} },
      now: () => new Date('2026-10-08T10:00:00Z'),
    };
  };
  const remoteFiles = () => git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean);
  return { root, remote, person, remoteFiles, git };
}

// A pre-commit hook that blocks like the real ownership gate would for `user`.
export function installOwnershipHook(hubDir: string, user: string): void {
  const hook = join(hubDir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\nbad=$(git diff --cached --name-only | grep -vE '^(people/${user}/|inbox/|shared/|\\.gitignore$)')\n[ -n "$bad" ] && { echo "blocked: $bad" >&2; exit 1; }\nexit 0\n`);
  chmodSync(hook, 0o755);
}
