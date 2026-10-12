import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDir, hubDir, loadState, loadUserConfig, normalizeDir, saveState, saveUserConfig } from '../../src/core/config';
import { HubError, assertGid, assertMessageId, assertName, assertSiteCode } from '../../src/core/types';

const tmp = () => mkdtempSync(join(tmpdir(), 'cfg-'));

describe('paths', () => {
  it('honours env overrides', () => {
    expect(configDir({ RIXFLOW_CONFIG_DIR: '/x/cfg' })).toBe('/x/cfg');
    expect(hubDir({ RIXFLOW_DIR: '/x/hub' })).toBe('/x/hub');
  });
  it('defaults under the home directory', () => {
    expect(hubDir({})).toMatch(/\.rixflow$/);
    expect(configDir({})).toMatch(/\.config\/rixflow$/);
  });
});

describe('user config', () => {
  it('round-trips and keeps the workspace gid as a string', () => {
    const dir = tmp();
    saveUserConfig(dir, {
      name: 'hristijan', role: 'dev', projectsRoot: '/p', asanaWorkspace: '1198828799176805',
      siteFolders: { AC: '/p/acme-v2' }, taskSites: { '123': 'AC' },
    });
    const cfg = loadUserConfig(dir);
    expect(cfg.asanaWorkspace).toBe('1198828799176805');
    expect(cfg.siteFolders.AC).toBe('/p/acme-v2');
  });
  it('keeps the Jira email on the machine config', () => {
    const dir = tmp();
    saveUserConfig(dir, { name: 'dev', role: 'dev', projectsRoot: '/p', jiraEmail: 'dev@acme.example.com', siteFolders: {}, taskSites: {} });
    expect(loadUserConfig(dir).jiraEmail).toBe('dev@acme.example.com');
    saveUserConfig(dir, { name: 'dev', role: 'dev', projectsRoot: '/p', siteFolders: {}, taskSites: {} });
    expect(loadUserConfig(dir).jiraEmail).toBeUndefined();
  });
  it('keeps the pinned Jira address on the machine config, normalized', () => {
    const dir = tmp();
    saveUserConfig(dir, { name: 'dev', role: 'dev', projectsRoot: '/p', jiraUrl: 'https://acme.atlassian.net/', siteFolders: {}, taskSites: {} });
    expect(loadUserConfig(dir).jiraUrl).toBe('https://acme.atlassian.net');
    saveUserConfig(dir, { name: 'dev', role: 'dev', projectsRoot: '/p', jiraUrl: 'http://acme.atlassian.net', siteFolders: {}, taskSites: {} });
    expect(loadUserConfig(dir).jiraUrl).toBeUndefined();
  });
  it('throws NOT_INITIALIZED when missing', () => {
    expect(() => loadUserConfig(tmp())).toThrowError(expect.objectContaining({ code: 'NOT_INITIALIZED' }));
  });
  it('rejects a bad role', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.yml'), 'name: a\nrole: boss\nprojectsRoot: /p\n');
    expect(() => loadUserConfig(dir)).toThrowError(HubError);
  });
});

describe('normalizeDir (I6)', () => {
  const env = { HOME: '/home/x' };
  it('expands a leading ~ with env.HOME, resolves and strips trailing separators', () => {
    expect(normalizeDir('~', env)).toBe('/home/x');
    expect(normalizeDir('~/', env)).toBe('/home/x');
    expect(normalizeDir('~/projects', env)).toBe('/home/x/projects');
    expect(normalizeDir('~/projects/', env)).toBe('/home/x/projects');
    expect(normalizeDir('/a/b//', env)).toBe('/a/b');
    expect(normalizeDir('/a/./b/../c', env)).toBe('/a/c');
    expect(normalizeDir('/', env)).toBe('/');
    expect(normalizeDir('~bob/x', env)).not.toContain('/home/x');
  });
  it('loadUserConfig normalizes projectsRoot and siteFolders', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.yml'), 'name: a\nrole: dev\nprojectsRoot: ~/projects/\nsiteFolders:\n  AC: ~/work/ac/\n  GL: /srv/gl/\n');
    const cfg = loadUserConfig(dir, env);
    expect(cfg.projectsRoot).toBe('/home/x/projects');
    expect(cfg.siteFolders).toEqual({ AC: '/home/x/work/ac', GL: '/srv/gl' });
  });
  it('resolves relative siteFolders against projectsRoot, not the process cwd', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.yml'), 'name: a\nrole: dev\nprojectsRoot: /p/projects\nsiteFolders:\n  AC: acme-v2/\n  GL: ../gl\n');
    expect(loadUserConfig(dir, env).siteFolders).toEqual({ AC: '/p/projects/acme-v2', GL: '/p/gl' });
    expect(normalizeDir('rel/x', env, '/base')).toBe('/base/rel/x');
    expect(normalizeDir('~/x', env, '/base')).toBe('/home/x/x');
  });
  it('paths use env.HOME when it is passed', () => {
    expect(hubDir({ HOME: '/home/x' })).toBe('/home/x/.rixflow');
    expect(configDir({ HOME: '/home/x' })).toBe('/home/x/.config/rixflow');
  });
});

describe('state', () => {
  it('returns defaults when missing and round-trips', () => {
    const dir = tmp();
    expect(loadState(dir)).toEqual({ seenTaskModified: {}, notified: [] });
    saveState(dir, { seenTaskModified: { '1': 'x' }, notified: ['a'], lastPromptCheck: 't' });
    expect(loadState(dir)).toEqual({ seenTaskModified: { '1': 'x' }, notified: ['a'], lastPromptCheck: 't' });
  });
});

describe('validators', () => {
  it('accepts valid values', () => {
    expect(() => assertName('ana-b')).not.toThrow();
    expect(() => assertGid('1219093521695631')).not.toThrow();
    expect(() => assertMessageId('2026-10-08-a1b2')).not.toThrow();
    expect(() => assertSiteCode('AC')).not.toThrow();
  });
  it('rejects traversal and junk', () => {
    expect(() => assertName('../x')).toThrowError(expect.objectContaining({ code: 'BAD_NAME' }));
    expect(() => assertName('Ana')).toThrowError(expect.objectContaining({ code: 'BAD_NAME' }));
    expect(() => assertGid('12/3')).toThrowError(expect.objectContaining({ code: 'BAD_GID' }));
    expect(() => assertMessageId('x')).toThrowError(expect.objectContaining({ code: 'BAD_ID' }));
    expect(() => assertSiteCode('ac')).toThrowError(expect.objectContaining({ code: 'BAD_SITE' }));
  });
});
