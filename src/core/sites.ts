import { isAbsolute, relative, resolve, sep } from 'node:path';
import { normalizeDir } from './config';
import { fieldValue, type AsanaTask } from './asana';
import type { SiteDef } from './team';
import { assertSiteCode, type UserConfig } from './types';

// Site codes come from Asana field text, so only well-formed codes are looked up.
function isSiteCode(v: string): boolean {
  try {
    assertSiteCode(v);
    return true;
  } catch {
    return false;
  }
}

export interface SiteResolution {
  codes: string[];
  folder: string | null;
  source: 'remembered' | 'task' | 'parent' | 'none';
}

// Explicit siteFolders overrides are user-chosen paths, returned normalized (~ expanded, no trailing /).
// A folder derived from a site definition must stay inside projectsRoot.
export function folderFor(code: string, sites: Record<string, SiteDef>, user: UserConfig): string | null {
  if (!isSiteCode(code)) return null;
  if (Object.hasOwn(user.siteFolders, code) && user.siteFolders[code]) return normalizeDir(user.siteFolders[code], undefined, normalizeDir(user.projectsRoot));
  const site = Object.hasOwn(sites, code) ? sites[code] : undefined;
  if (!site) return null;
  const root = normalizeDir(user.projectsRoot);
  const folder = resolve(root, site.folder);
  const rel = relative(root, folder);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return folder;
}

export function valueFromChain(chain: AsanaTask[], prefix: string): string | null {
  for (const t of chain) {
    const v = fieldValue(t, prefix);
    if (v) return v;
  }
  return null;
}

export function resolveSite(chain: AsanaTask[], sites: Record<string, SiteDef>, user: UserConfig): SiteResolution {
  if (chain.length === 0) return { codes: [], folder: null, source: 'none' };
  const remembered = Object.hasOwn(user.taskSites, chain[0].gid) ? user.taskSites[chain[0].gid] : undefined;
  if (remembered && isSiteCode(remembered)) return { codes: [remembered], folder: folderFor(remembered, sites, user), source: 'remembered' };
  for (let i = 0; i < chain.length; i++) {
    const value = fieldValue(chain[i], 'Website');
    if (!value) continue;
    const codes = value.split(',').map((s) => s.trim()).filter(isSiteCode);
    if (codes.length === 0) continue;
    return {
      codes,
      folder: codes.length === 1 ? folderFor(codes[0], sites, user) : null,
      source: i === 0 ? 'task' : 'parent',
    };
  }
  return { codes: [], folder: null, source: 'none' };
}
