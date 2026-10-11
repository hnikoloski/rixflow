import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubCliPath, hubCommand } from '../../src/core/command';
import { loadUserConfig } from '../../src/core/config';

describe('hubCommand (I8)', () => {
  it('points at the running hub.cjs, or at the sibling hub.cjs from mcp.cjs', () => {
    expect(hubCliPath('/p/rixflow/0.1.0/dist/hub.cjs')).toBe('/p/rixflow/0.1.0/dist/hub.cjs');
    expect(hubCliPath('/p/rixflow/0.1.0/dist/mcp.cjs')).toBe('/p/rixflow/0.1.0/dist/hub.cjs');
    expect(hubCommand('init', '/p/dist/mcp.cjs')).toBe('node "/p/dist/hub.cjs" init');
    expect(hubCommand('token set', '/p/dist/hub.cjs')).toBe('node "/p/dist/hub.cjs" token set');
  });
  it('quotes paths for a POSIX shell', () => {
    expect(hubCommand('init', '/a b/$x/"q"/`c`/dist/hub.cjs')).toBe('node "/a b/\\$x/\\"q\\"/\\`c\\`/dist/hub.cjs" init');
  });
  it('falls back to the plugin root, never to a bare `hub`', () => {
    const fromRoot = hubCommand('init', '/usr/lib/node_modules/vitest/worker.js', { CLAUDE_PLUGIN_ROOT: '/plug' });
    expect(fromRoot).toBe('node "/plug/dist/hub.cjs" init');
    expect(hubCommand('init', undefined, {})).toMatch(/^node ".*hub\.cjs" init$/);
  });
  it('the not-initialized error carries the runnable command', () => {
    try {
      loadUserConfig(mkdtempSync(join(tmpdir(), 'cmd-')));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain(hubCommand('init'));
      expect((e as Error).message).not.toMatch(/Run: hub init/);
    }
  });
});
