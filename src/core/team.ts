import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { HubError, assertGid, assertName, assertSiteCode, type Role } from './types';

export interface TeamMember {
  name: string;
  role: Role;
  asanaGid?: string;
}

export interface SiteDef {
  folder: string;
  aliases?: string[];
}

const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(file: string, reason: string): never {
  throw new HubError('BAD_CONFIG', `${file}: ${reason}`);
}

export const isMapping = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readYaml(path: string, label: string = path): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(label, `invalid YAML (${(err as Error).message})`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isMapping(parsed)) fail(label, 'top level must be a mapping');
  return parsed;
}

export function loadTeam(hubDir: string): TeamMember[] {
  const file = join(hubDir, 'config', 'team.yml');
  const raw = readYaml(file);
  if (raw.members === undefined || raw.members === null) return [];
  if (!Array.isArray(raw.members)) fail(file, 'members must be a list');
  return raw.members.map((m: unknown, i: number) => {
    if (!isMapping(m)) fail(file, `member ${i} must be a mapping`);
    try {
      assertName(m.name);
    } catch {
      fail(file, `member ${i} has an invalid name: ${String(m.name)}`);
    }
    if (m.role !== 'dev' && m.role !== 'pm') fail(file, `member ${m.name}: role must be dev or pm`);
    const member: TeamMember = { name: m.name, role: m.role };
    if (m.asanaGid !== undefined && m.asanaGid !== null) {
      const gid = String(m.asanaGid);
      try {
        assertGid(gid);
      } catch {
        fail(file, `member ${m.name}: invalid asanaGid`);
      }
      member.asanaGid = gid;
    }
    return member;
  });
}

export function loadSites(hubDir: string): Record<string, SiteDef> {
  const file = join(hubDir, 'config', 'sites.yml');
  const raw = readYaml(file);
  if (raw.sites === undefined || raw.sites === null) return {};
  if (!isMapping(raw.sites)) fail(file, 'sites must be a mapping');
  const out: Record<string, SiteDef> = {};
  for (const [code, def] of Object.entries(raw.sites)) {
    try {
      assertSiteCode(code);
    } catch {
      fail(file, `invalid site code: ${code}`);
    }
    if (!isMapping(def)) fail(file, `site ${code} must be a mapping`);
    const { folder, aliases } = def;
    if (typeof folder !== 'string' || !FOLDER.test(folder) || folder.includes('..')) {
      fail(file, `site ${code}: invalid folder`);
    }
    if (aliases !== undefined && (!Array.isArray(aliases) || !aliases.every((a) => typeof a === 'string'))) {
      fail(file, `site ${code}: aliases must be a list of strings`);
    }
    out[code] = aliases === undefined ? { folder } : { folder, aliases: aliases as string[] };
  }
  return out;
}
