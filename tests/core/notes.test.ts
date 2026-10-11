import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSites, loadTeam } from '../../src/core/team';
import {
  clearCheckpoint, findActiveHandover, hasSessionSummary, listCheckpoints, readCheckpoint,
  readHandover, writeCheckpoint, writeHandover, writeSession,
} from '../../src/core/notes';
import { makeCtx } from '../helpers';

const summary = {
  sessionId: 'abc-123', phase: 'implement' as const, trigger: 'checkpoint' as const, task: '42', site: 'AC',
  goal: 'Fix pricing CTA', done: '- changed button', decisions: '- kept old copy for DE', deadEnds: '- none', next: '- deploy',
};

describe('team config', () => {
  it('loads members and sites', () => {
    const ctx = makeCtx();
    expect(loadTeam(ctx.hubDir).map((m) => m.name)).toEqual(['hristijan', 'pm', 'ana']);
    expect(loadSites(ctx.hubDir).AC.folder).toBe('acme');
  });
});

describe('sessions', () => {
  it('writes numbered files with frontmatter, sections and an index', () => {
    const ctx = makeCtx();
    const p1 = writeSession(ctx, summary);
    const p2 = writeSession(ctx, summary);
    expect(p1).toMatch(/people\/hristijan\/sessions\/2026-10-08-42-1\.md$/);
    expect(p2).toMatch(/-42-2\.md$/);
    const text = readFileSync(p1, 'utf8');
    expect(text).toContain('session_id: abc-123');
    expect(text).toContain('## Decisions\n- kept old copy for DE');
    expect(text).toContain('[[shared/sites/ac/_index]]');
    const index = readFileSync(join(ctx.hubDir, 'people', 'hristijan', '_index.md'), 'utf8');
    expect(index).toContain('[[people/hristijan/sessions/2026-10-08-42-1]]');
    expect(hasSessionSummary(ctx, 'abc-123')).toBe(true);
    expect(hasSessionSummary(ctx, 'other')).toBe(false);
  });
  it('uses misc when there is no task', () => {
    const ctx = makeCtx();
    expect(writeSession(ctx, { ...summary, task: undefined })).toMatch(/2026-10-08-misc-1\.md$/);
  });
});

describe('checkpoints', () => {
  it('writes, reads back, lists and clears', () => {
    const ctx = makeCtx();
    writeCheckpoint(ctx, { task: '42', site: 'AC', branch: 'wip/42', done: '- a', pending: '- b', blockers: '- none', resume: 'run tests', asanaModifiedAt: '2026-10-07T00:00:00.000Z' });
    const cp = readCheckpoint(ctx, '42');
    expect(cp).toMatchObject({ task: '42', branch: 'wip/42', pending: '- b', resume: 'run tests', pausedAt: '2026-10-08T10:00:00.000Z' });
    expect(listCheckpoints(ctx).map((c) => c.task)).toEqual(['42']);
    expect(clearCheckpoint(ctx, '42')).toBe(true);
    expect(readCheckpoint(ctx, '42')).toBeNull();
    expect(clearCheckpoint(ctx, '42')).toBe(false);
  });
  it('rejects a non-numeric task id', () => {
    const ctx = makeCtx();
    expect(() => readCheckpoint(ctx, '../x')).toThrowError(expect.objectContaining({ code: 'BAD_TICKET' }));
  });
});

describe('handovers', () => {
  it('round-trips and finds the active one by working directory', () => {
    const ctx = makeCtx();
    writeHandover(ctx, {
      task: '42', site: 'AC', projectDir: '/home/u/projects/acme', asanaModifiedAt: '2026-10-07T00:00:00.000Z',
      brief: 'Do the thing', requestContext: '- request from pm', related: ['shared/decisions/ab-200.md'],
    });
    const h = readHandover(ctx, '42');
    expect(h).toMatchObject({ task: '42', brief: 'Do the thing', related: ['shared/decisions/ab-200.md'], created: '2026-10-08T10:00:00.000Z' });
    expect(findActiveHandover(ctx, '/home/u/projects/acme/web/app')?.task).toBe('42');
    expect(findActiveHandover(ctx, '/home/u/projects/acme-v2')).toBeNull();
    expect(findActiveHandover(ctx, '/home/u/projects/acme')?.task).toBe('42');
    expect(findActiveHandover(ctx, '/home/u/projects/acme/')?.task).toBe('42');
    expect(existsSync(join(ctx.hubDir, 'people', 'hristijan', 'handovers', '42.md'))).toBe(true);
  });
});

describe('handover folder matching (I6)', () => {
  it('matches a handover whose project_dir has a trailing slash, for the dir itself and a sub-dir', () => {
    const ctx = makeCtx();
    writeHandover(ctx, { task: '42', projectDir: '/home/u/p/ac/', asanaModifiedAt: '', brief: 'b', related: [] });
    expect(findActiveHandover(ctx, '/home/u/p/ac')?.task).toBe('42');
    expect(findActiveHandover(ctx, '/home/u/p/ac/web/')?.task).toBe('42');
    expect(findActiveHandover(ctx, '/home/u/p/cbx')).toBeNull();
  });
});

describe('team config validation', () => {
  const badConfig = (ctx: ReturnType<typeof makeCtx>, file: string, text: string) =>
    writeFileSync(join(ctx.hubDir, 'config', file), text);

  it('rejects malformed YAML with BAD_CONFIG', () => {
    const ctx = makeCtx();
    badConfig(ctx, 'team.yml', 'members: [unclosed\n');
    expect(() => loadTeam(ctx.hubDir)).toThrowError(expect.objectContaining({ code: 'BAD_CONFIG' }));
  });
  it('rejects a null member with BAD_CONFIG', () => {
    const ctx = makeCtx();
    badConfig(ctx, 'team.yml', 'members:\n  - null\n');
    expect(() => loadTeam(ctx.hubDir)).toThrowError(expect.objectContaining({ code: 'BAD_CONFIG' }));
  });
  it('rejects an unknown role instead of coercing it', () => {
    const ctx = makeCtx();
    badConfig(ctx, 'team.yml', 'members:\n  - name: ana\n    role: admin\n');
    expect(() => loadTeam(ctx.hubDir)).toThrowError(expect.objectContaining({ code: 'BAD_CONFIG' }));
  });
  it('rejects an invalid member name with BAD_CONFIG', () => {
    const ctx = makeCtx();
    badConfig(ctx, 'team.yml', 'members:\n  - name: ../evil\n    role: dev\n');
    expect(() => loadTeam(ctx.hubDir)).toThrowError(expect.objectContaining({ code: 'BAD_CONFIG' }));
  });
  it('rejects a non-numeric asanaGid with BAD_CONFIG', () => {
    const ctx = makeCtx();
    badConfig(ctx, 'team.yml', 'members:\n  - name: ana\n    role: dev\n    asanaGid: abc\n');
    expect(() => loadTeam(ctx.hubDir)).toThrowError(expect.objectContaining({ code: 'BAD_CONFIG' }));
  });
  it('rejects a site folder that traverses', () => {
    const ctx = makeCtx();
    badConfig(ctx, 'sites.yml', 'sites:\n  AC:\n    folder: ../../x\n');
    expect(() => loadSites(ctx.hubDir)).toThrowError(expect.objectContaining({ code: 'BAD_CONFIG' }));
  });
  it('rejects a site value that is not an object', () => {
    const ctx = makeCtx();
    badConfig(ctx, 'sites.yml', 'sites:\n  AC: acme\n');
    expect(() => loadSites(ctx.hubDir)).toThrowError(expect.objectContaining({ code: 'BAD_CONFIG' }));
  });
  it('rejects malformed site aliases', () => {
    const ctx = makeCtx();
    badConfig(ctx, 'sites.yml', 'sites:\n  AC:\n    folder: acme\n    aliases: ac\n');
    expect(() => loadSites(ctx.hubDir)).toThrowError(expect.objectContaining({ code: 'BAD_CONFIG' }));
  });
});

describe('note parsing hardening', () => {
  it('round-trips handover content that contains a markdown heading', () => {
    const ctx = makeCtx();
    const brief = 'Do the thing\n## Acceptance criteria\n- x';
    writeHandover(ctx, { task: '42', asanaModifiedAt: '2026-10-07T00:00:00.000Z', brief, related: [] });
    expect(readHandover(ctx, '42')?.brief).toBe(brief);
  });
  it('allocates a new session number instead of overwriting an existing file', () => {
    const ctx = makeCtx();
    const dir = join(ctx.hubDir, 'people', 'hristijan', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-10-08-42-1.md'), 'EXISTING');
    writeFileSync(join(dir, '2026-10-08-42-2.md'), 'EXISTING');
    const p = writeSession(ctx, summary);
    expect(p).toMatch(/-42-3\.md$/);
    expect(readFileSync(join(dir, '2026-10-08-42-1.md'), 'utf8')).toBe('EXISTING');
  });
  it('skips corrupt files when listing and searching', () => {
    const ctx = makeCtx();
    writeCheckpoint(ctx, { task: '42', done: '- a', pending: '- b', blockers: '- none', resume: 'run tests' });
    const cpDir = join(ctx.hubDir, 'people', 'hristijan', 'checkpoints');
    writeFileSync(join(cpDir, '99.md'), '---\nkey: [unclosed\n---\nbody\n');
    expect(listCheckpoints(ctx).map((c) => c.task)).toEqual(['42']);

    writeSession(ctx, summary);
    const sDir = join(ctx.hubDir, 'people', 'hristijan', 'sessions');
    writeFileSync(join(sDir, 'corrupt.md'), '---\nkey: [unclosed\n---\nbody\n');
    expect(hasSessionSummary(ctx, 'abc-123')).toBe(true);

    writeHandover(ctx, { task: '42', projectDir: '/home/u/p', asanaModifiedAt: '', brief: 'b', related: [] });
    const hDir = join(ctx.hubDir, 'people', 'hristijan', 'handovers');
    writeFileSync(join(hDir, '77.md'), '---\nkey: [unclosed\n---\nbody\n');
    expect(findActiveHandover(ctx, '/home/u/p/web')?.task).toBe('42');
  });
});
