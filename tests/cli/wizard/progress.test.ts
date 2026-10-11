import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearProgress, loadProgress, runSteps, saveProgress, type Progress } from '../../../src/cli/wizard/progress';
import { scriptedIo } from './io';

const dir = () => join(mkdtempSync(join(tmpdir(), 'wiz-')), 'cfg');
const prog = (over: Partial<Progress> = {}): Progress => ({ flow: 'join', done: ['a'], answers: { x: 1 }, updatedAt: 't', ...over });
const step = (id: string, log: string[], out: Record<string, unknown> = { [id]: true }) => ({
  id, run: async () => { log.push(id); return out; },
});

describe('progress file', () => {
  it('saves 0600, creates dir 0700, loads back, clears', () => {
    const d = dir();
    saveProgress(d, prog());
    expect(statSync(join(d, 'setup-progress.json')).mode & 0o777).toBe(0o600);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(loadProgress(d)?.answers).toEqual({ x: 1 });
    clearProgress(d);
    expect(loadProgress(d)).toBeNull();
  });
  it('returns null for corrupt files', () => {
    const d = dir();
    saveProgress(d, prog());
    writeFileSync(join(d, 'setup-progress.json'), '{nope');
    expect(loadProgress(d)).toBeNull();
    writeFileSync(join(d, 'setup-progress.json'), '{"flow":"x"}');
    expect(loadProgress(d)).toBeNull();
  });
  it('refuses secrets at any depth, keys and values', () => {
    const d = dir();
    for (const answers of [
      { jiraToken: 'x' }, { a: { b: [{ password: '1' }] } }, { a: 'my secret' },
      { a: ['https://u:p@example.com/x'] }, { a: { b: 'Bearer abcdefghijklmnopqrstuvwxyz' } },
    ]) expect(() => saveProgress(d, prog({ answers }))).toThrow(/secret/);
    try { saveProgress(d, prog({ answers: { jiraToken: 'x' } })); } catch (e) { expect((e as { code: string }).code).toBe('BAD_PROGRESS'); }
    expect(existsSync(join(d, 'setup-progress.json'))).toBe(false);
  });
  it('refuses to write through a symlink', () => {
    const d = dir();
    saveProgress(d, prog());
    const victim = join(d, 'victim');
    writeFileSync(victim, 'keep');
    clearProgress(d);
    symlinkSync(victim, join(d, 'setup-progress.json'));
    expect(() => saveProgress(d, prog())).toThrow(/symlink/);
    expect(readFileSync(victim, 'utf8')).toBe('keep');
  });
});

describe('runSteps', () => {
  it('runs all steps and clears progress', async () => {
    const d = dir(); const log: string[] = [];
    const out = await runSteps(scriptedIo([]), d, 'join', [step('a', log), step('b', log)]);
    expect(out).toEqual({ a: true, b: true });
    expect(loadProgress(d)).toBeNull();
  });
  it('resumes after step 2 of 3', async () => {
    const d = dir(); const log: string[] = [];
    saveProgress(d, prog({ done: ['a', 'b'], answers: { a: true, b: true } }));
    const io = scriptedIo(['y']);
    const out = await runSteps(io, d, 'join', [step('a', log), step('b', log), step('c', log)]);
    expect(log).toEqual(['c']);
    expect(out).toEqual({ a: true, b: true, c: true });
    expect(io.asked[0]).toContain('Continue where you stopped (b)?');
  });
  it('answering n starts fresh', async () => {
    const d = dir(); const log: string[] = [];
    saveProgress(d, prog({ done: ['a'], answers: { old: 1 } }));
    const out = await runSteps(scriptedIo(['n']), d, 'join', [step('a', log), step('b', log)]);
    expect(log).toEqual(['a', 'b']);
    expect(out).toEqual({ a: true, b: true });
  });
  it('ignores and keeps progress for the other flow', async () => {
    const d = dir(); const log: string[] = [];
    saveProgress(d, prog({ flow: 'create' }));
    const io = scriptedIo([]);
    await runSteps(io, d, 'join', [step('a', log)]);
    expect(io.asked).toEqual([]);
    expect(log).toEqual(['a']);
    expect(loadProgress(d)).toBeNull();
  });
  it('keeps the other flow file when a run stops midway', async () => {
    const d = dir();
    saveProgress(d, prog({ flow: 'create', done: ['z'] }));
    await expect(runSteps(scriptedIo([]), d, 'join', [{ id: 'a', run: async () => { throw new Error('x'); } }])).rejects.toThrow('x');
    expect(loadProgress(d)?.flow).toBe('create');
  });
  it('goto reruns from the target', async () => {
    const d = dir(); const log: string[] = []; let jumped = false;
    const steps = [
      step('a', log),
      step('b', log),
      { id: 'c', run: async () => { log.push('c'); if (!jumped) { jumped = true; return { goto: 'b' }; } return { c: true }; } },
    ];
    await runSteps(scriptedIo([]), d, 'create', steps);
    expect(log).toEqual(['a', 'b', 'c', 'b', 'c']);
  });
  it('EOF mid-step keeps earlier progress', async () => {
    const d = dir(); const log: string[] = [];
    const ask = (id: string) => ({ id, run: async (_a: Record<string, unknown>) => { const { askValid } = await import('../../../src/cli/wizard/prompts'); return { [id]: await askValid(io, `${id}?`, () => null) }; } });
    const io = scriptedIo(['one']);
    await expect(runSteps(io, d, 'join', [ask('s1'), ask('s2'), step('s3', log)])).rejects.toMatchObject({ code: 'ABORTED' });
    const p = loadProgress(d)!;
    expect(p.done).toEqual(['s1']);
    expect(p.answers).toEqual({ s1: 'one' });
    expect(readFileSync(join(d, 'setup-progress.json'), 'utf8')).not.toMatch(/token|password|secret/i);
    const io2 = scriptedIo(['y', 'two']);
    const out = await runSteps({ ...io2, ask: (q) => io2.ask(q) } as typeof io2, d, 'join', [
      { id: 's1', run: async () => { throw new Error('should be skipped'); } },
      { id: 's2', run: async () => ({ s2: await io2.ask('s2?') }) },
      step('s3', log),
    ]);
    expect(out).toEqual({ s1: 'one', s2: 'two', s3: true });
    expect(log).toEqual(['s3']);
  });
});
