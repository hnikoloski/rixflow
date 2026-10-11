import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDoc } from '../../src/core/hubfs';
import { search } from '../../src/core/search';
import { HubError } from '../../src/core/types';
import { makeCtx } from '../helpers';

function seed() {
  const ctx = makeCtx();
  const h = ctx.hubDir;
  writeDoc(join(h, 'shared/decisions/ab-200.md'), { type: 'decision', site: 'AC', date: '2026-09-01' },
    '# A/B test 200 cancelled\nCancelled because the pricing caching broke [[shared/sites/ac/_index]].');
  writeDoc(join(h, 'people/ana/sessions/2026-10-01-7-1.md'), { type: 'session', site: 'GL, AC', date: '2026-10-01' },
    '## Decisions\n- Cache invalidation via tag purge on publish.');
  writeDoc(join(h, 'people/hristijan/notes/x.md'), { type: 'note', date: '2026-08-01' }, 'unrelated text');
  writeDoc(join(h, 'people/ana/_index.md'), {}, 'caching caching caching');
  return ctx;
}

function expectHubError(fn: () => unknown, code: string) {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(HubError);
  expect((thrown as HubError).code).toBe(code);
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

describe('search', () => {
  it('ranks by term hits and returns relative paths, snippets and links', () => {
    const hits = search(seed().hubDir, { text: 'caching pricing' });
    expect(hits[0].path).toBe('shared/decisions/ab-200.md');
    expect(hits[0].title).toBe('A/B test 200 cancelled');
    expect(hits[0].snippet).toContain('pricing caching');
    expect(hits[0].links).toEqual(['shared/sites/ac/_index']);
    expect(hits.map((x) => x.path)).not.toContain('people/ana/_index.md');
  });
  it('filters by person, site, type and since', () => {
    const h = seed().hubDir;
    expect(search(h, { person: 'ana' }).map((x) => x.path)).toEqual(['people/ana/sessions/2026-10-01-7-1.md']);
    expect(search(h, { site: 'ac' }).map((x) => x.path).sort()).toEqual(['people/ana/sessions/2026-10-01-7-1.md', 'shared/decisions/ab-200.md']);
    expect(search(h, { type: 'note' })).toHaveLength(1);
    expect(search(h, { since: '2026-09-15' }).map((x) => x.path)).toEqual(['people/ana/sessions/2026-10-01-7-1.md']);
  });
  it('rejects a bad person name', () => {
    expect(() => search(seed().hubDir, { person: '../x' })).toThrowError(expect.objectContaining({ code: 'BAD_NAME' }));
    expectHubError(() => search(seed().hubDir, { person: '../x' }), 'BAD_NAME');
    expectHubError(() => search(seed().hubDir, { person: 'Ana' }), 'BAD_NAME');
    expectHubError(() => search(seed().hubDir, { person: '..' }), 'BAD_NAME');
  });
});

describe('search hardening', () => {
  it('skips a corrupt .md file instead of failing the whole search', () => {
    const ctx = seed();
    writeFileSync(join(ctx.hubDir, 'shared/decisions/broken.md'), '---\nkey: [unclosed\n---\n# Broken caching note\n');
    const paths = search(ctx.hubDir, { text: 'caching' }).map((x) => x.path);
    expect(paths).not.toContain('shared/decisions/broken.md');
    expect(paths).toContain('shared/decisions/ab-200.md');
  });
  it('rejects a negative, zero, fractional, NaN or infinite limit with BAD_INPUT', () => {
    const h = seed().hubDir;
    for (const limit of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectHubError(() => search(h, { limit }), 'BAD_INPUT');
    }
  });
  it('applies a valid positive integer limit', () => {
    expect(search(seed().hubDir, { limit: 1 })).toHaveLength(1);
  });
  it('rejects an unparseable since date with BAD_INPUT', () => {
    const h = seed().hubDir;
    for (const since of ['yesterday', '2026-13-45', '2026/09/15']) {
      expectHubError(() => search(h, { since }), 'BAD_INPUT');
    }
  });
  it('never returns a file that is a symlink pointing outside the hub', () => {
    const ctx = seed();
    const outside = mkdtempSync(join(tmpdir(), 'rixflow-outside-'));
    writeFileSync(join(outside, 'secret.md'), '---\ntype: note\n---\n# Leaked caching secret\n');
    mkdirSync(join(ctx.hubDir, 'shared/links'), { recursive: true });
    symlinkSync(join(outside, 'secret.md'), join(ctx.hubDir, 'shared/links/leak.md'));
    const hits = search(ctx.hubDir, { text: 'caching secret' });
    expect(hits.map((x) => x.path)).not.toContain('shared/links/leak.md');
    expect(hits.some((x) => x.title.includes('Leaked'))).toBe(false);
  });
  it('skips .git and inbox directories under the scanned roots', () => {
    const ctx = seed();
    writeDoc(join(ctx.hubDir, 'people/ana/.git/hidden.md'), { type: 'note' }, 'caching hidden in git');
    writeDoc(join(ctx.hubDir, 'people/ana/inbox/hidden.md'), { type: 'note' }, 'caching hidden in inbox');
    const paths = search(ctx.hubDir, { text: 'caching' }).map((x) => x.path);
    expect(paths.some((p) => p.split('/').includes('.git') || p.split('/').includes('inbox'))).toBe(false);
  });
  it('writes nothing to the hub', () => {
    const ctx = seed();
    const before = snapshot(ctx.hubDir);
    search(ctx.hubDir, { text: 'caching pricing', limit: 5 });
    search(ctx.hubDir, { person: 'ana', site: 'ac', since: '2026-01-01' });
    expect(snapshot(ctx.hubDir)).toEqual(before);
  });
});
