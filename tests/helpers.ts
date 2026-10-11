import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Ctx, Role } from '../src/core/types';

export function makeCtx(opts: { name?: string; role?: Role; members?: string[]; now?: string } = {}): Ctx {
  const root = mkdtempSync(join(tmpdir(), 'rixflow-'));
  const hubDir = join(root, 'hub');
  const configDir = join(root, 'cfg');
  mkdirSync(join(hubDir, 'config'), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const members = opts.members ?? ['hristijan', 'pm', 'ana'];
  writeFileSync(
    join(hubDir, 'config', 'team.yml'),
    YAML.stringify({ members: members.map((n) => ({ name: n, role: n === 'pm' ? 'pm' : 'dev' })) }),
  );
  writeFileSync(
    join(hubDir, 'config', 'sites.yml'),
    YAML.stringify({ sites: { AC: { folder: 'acme' }, GL: { folder: 'globex-web' } } }),
  );
  const now = new Date(opts.now ?? '2026-10-08T10:00:00Z');
  return {
    hubDir,
    configDir,
    user: {
      name: opts.name ?? 'hristijan',
      role: opts.role ?? 'dev',
      projectsRoot: '/home/u/projects',
      asanaWorkspace: '111',
      siteFolders: {},
      taskSites: {},
    },
    now: () => now,
  };
}
