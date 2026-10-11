import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAsana, persist, syncHub } from '../../src/core/runtime';
import { makeCtx } from '../helpers';

describe('runtime helpers', () => {
  it('makeAsana is null without workspace or token', () => {
    const ctx = makeCtx();
    expect(makeAsana(ctx, { ASANA_TOKEN: 'tok' })).not.toBeNull();
    expect(makeAsana({ ...ctx, user: { ...ctx.user, asanaWorkspace: undefined } }, { ASANA_TOKEN: 'tok' })).toBeNull();
  });
  it('syncHub is null when the hub is not a git repo', async () => {
    expect(await syncHub(makeCtx())).toBeNull();
  });
  it('persist never throws and returns a status', async () => {
    const ctx = makeCtx();
    expect((await persist(ctx, 'm')).detail).toContain('not a git repo');
    mkdirSync(join(ctx.hubDir, '.git'));
    writeFileSync(join(ctx.hubDir, '.git', 'HEAD'), 'garbage');
    expect((await persist(ctx, 'm')).status).toBe('blocked');
    const missing = { ...ctx, hubDir: join(mkdtempSync(join(tmpdir(), 'x-')), 'nope') };
    expect((await persist(missing, 'm')).status).toBe('blocked');
  });
});
