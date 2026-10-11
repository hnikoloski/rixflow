import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HubError } from '../../src/core/types';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { markRestricted, readPrivateBrief, restrictedBrief, writePrivateBrief } from '../../src/core/private';
import { readHandover, writeHandover, endHandover } from '../../src/core/notes';
import { resumeTask, startTask } from '../../src/core/tasks';
import { summarizeSession, touchedTasks } from '../../src/core/summarize';
import { LEGACY_WORKFLOW } from '../../src/core/workflow';
import { fakeSource, ticket } from '../fixtures/asana';
import { makeCtx } from '../helpers';

const DESC = 'Rotate the acme payroll export credentials';
const COMMENT = 'Finance says globex invoice 4411 is blocked';
const comments = { '201': [{ id: 'c1', createdAt: '2026-10-07T09:00:00.000Z', author: 'Ana', text: COMMENT }] };
const make = (restricted: boolean) => fakeSource([ticket({ id: '201', title: 'Payroll export', notes: DESC, restricted, url: 'https://acme.example.com/t/201' })], comments);

describe('private briefs', () => {
  it('writes 0600 in a 0700 dir, keeps 0600 on overwrite, scrubs', () => {
    const ctx = makeCtx();
    const file = writePrivateBrief(ctx.configDir, 'WEB-7', 'see https://u:p@x.example.com/');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(ctx.configDir, 'private')).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).not.toContain('u:p@');
    chmodSync(file, 0o644);
    writePrivateBrief(ctx.configDir, 'WEB-7', 'again');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readPrivateBrief(ctx.configDir, 'WEB-7')).toBe('again');
    expect(readPrivateBrief(ctx.configDir, 'WEB-8')).toBeNull();
  });
  it('rejects unsafe task ids', () => {
    const ctx = makeCtx();
    expect(() => writePrivateBrief(ctx.configDir, '../evil', 'x')).toThrow();
    expect(() => readPrivateBrief(ctx.configDir, '../../etc/passwd')).toThrow();
  });
  it('restrictedBrief format', () => {
    expect(restrictedBrief(ticket({ id: '1', title: 'T', notes: 'secret' }), 'Jira', 'ana'))
      .toBe('# T\n\n- Jira: 1\n- Restricted ticket: its description and comments are kept on ana\'s machine only.');
  });
});

describe('restricted tickets', () => {
  it('keeps text off the hub and resumes from the private file', async () => {
    const ctx = makeCtx();
    const res = await startTask(ctx, make(true), LEGACY_WORKFLOW, { task: '201', cwd: '/' });
    const raw = readFileSync(res.handoverPath, 'utf8');
    expect(raw).not.toContain(DESC);
    expect(raw).not.toContain(COMMENT);
    expect(raw).toContain('restricted: true');
    const priv = join(ctx.configDir, 'private', '201.md');
    expect(statSync(priv).mode & 0o777).toBe(0o600);
    expect(readFileSync(priv, 'utf8')).toContain(DESC);
    expect(readFileSync(priv, 'utf8')).toContain(COMMENT);
    const r = await resumeTask(ctx, make(true), '201');
    expect(r.privateBrief).toBe(true);
    expect(r.handover?.brief).toContain(DESC);
    // another machine: same hub, empty config dir
    const other = { ...ctx, configDir: join(ctx.configDir, 'elsewhere') };
    const r2 = await resumeTask(other, make(true), '201');
    expect(r2.privateBrief).toBe(false);
    expect(r2.handover?.brief).toContain('Restricted ticket');
    expect(r2.handover?.brief).not.toContain(DESC);
  });
  it('unrestricted tickets behave as before', async () => {
    const ctx = makeCtx();
    const res = await startTask(ctx, make(false), LEGACY_WORKFLOW, { task: '201', cwd: '/' });
    expect(readFileSync(res.handoverPath, 'utf8')).toContain(DESC);
    expect(existsSync(join(ctx.configDir, 'private'))).toBe(false);
    const r = await resumeTask(ctx, make(false), '201');
    expect(r.privateBrief).toBe(false);
    expect(r.handover?.brief).toContain(DESC);
  });
  it('restricted survives endHandover', () => {
    const ctx = makeCtx();
    writeHandover(ctx, { task: '201', asanaModifiedAt: '', brief: 'b', related: [], restricted: true });
    endHandover(ctx, '201', 'finished');
    expect(readHandover(ctx, '201')).toMatchObject({ restricted: true, outcome: 'finished' });
  });
  it('summarizer skips a restricted active handover', async () => {
    const ctx = makeCtx();
    const home = process.env.HOME!;
    writeHandover(ctx, { task: '201', projectDir: `${home}/p/acme`, asanaModifiedAt: '', brief: 'b', related: [], restricted: true });
    const t = join(ctx.configDir, 't.jsonl');
    writeFileSync(t, JSON.stringify({ type: 'user', message: { content: 'x'.repeat(900) } }) + '\n');
    let called = false;
    const out = await summarizeSession(ctx, { sessionId: 's-r', transcriptPath: t, trigger: 'precompact', cwd: '~/p/acme' }, {
      run: () => { called = true; return '{}'; }, persist: async () => {},
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
    expect(readFileSync(join(ctx.configDir, 'summary-errors.log'), 'utf8')).toContain('restricted ticket');
  });
});

describe('transcript-based summarizer guard', () => {
  const home = process.env.HOME!;
  function run(ctx: ReturnType<typeof makeCtx>, tool: string, task: string, cwd = '/elsewhere') {
    const t = join(ctx.configDir, 'tr.jsonl');
    const use = { type: 'assistant', message: { content: [{ type: 'tool_use', name: tool, input: { task } }, { type: 'text', text: 'x'.repeat(900) }] } };
    writeFileSync(t, JSON.stringify(use) + '\n');
    let called = false;
    return summarizeSession(ctx, { sessionId: 's-t', transcriptPath: t, trigger: 'precompact', cwd }, {
      run: () => { called = true; return '{"phase":"done","goal":"g"}'; }, persist: async () => {},
    }).then((out) => ({ out, called }));
  }
  it('skips with no projectDir, a cwd mismatch', async () => {
    const ctx = makeCtx();
    writeHandover(ctx, { task: '201', asanaModifiedAt: '', brief: 'b', related: [], restricted: true });
    expect(await run(ctx, 'mcp__plugin_rixflow_hub__resume_task', '201', `${home}/other`)).toEqual({ out: null, called: false });
  });
  it('skips an ended restricted handover', async () => {
    const ctx = makeCtx();
    writeHandover(ctx, { task: '201', projectDir: `${home}/p/acme`, asanaModifiedAt: '', brief: 'b', related: [], restricted: true });
    endHandover(ctx, '201', 'finished');
    expect(await run(ctx, 'mcp__plugin_rixflow_hub__finish_task', '201', `${home}/p/acme`)).toEqual({ out: null, called: false });
  });
  it('skips a session that only called task_details on a restricted ticket (private file only)', async () => {
    const ctx = makeCtx();
    writePrivateBrief(ctx.configDir, 'WEB-7', 'secret');
    expect(await run(ctx, 'mcp__plugin_rixflow_hub__task_details', 'web-7')).toEqual({ out: null, called: false });
  });
  it('still summarizes an unrestricted task', async () => {
    const ctx = makeCtx();
    writeHandover(ctx, { task: '202', asanaModifiedAt: '', brief: 'b', related: [] });
    expect((await run(ctx, 'mcp__plugin_rixflow_hub__task_details', '202')).called).toBe(true);
  });
});

describe('private storage safety', () => {
  it('refuses a symlinked private dir and reads null through a symlinked file', () => {
    const ctx = makeCtx();
    const target = join(ctx.configDir, 'real');
    mkdirSync(target);
    symlinkSync(target, join(ctx.configDir, 'private'));
    expect(() => writePrivateBrief(ctx.configDir, '201', 'x')).toThrow(/Could not save the restricted ticket brief/);
    expect(readPrivateBrief(ctx.configDir, '201')).toBeNull();
    const ctx2 = makeCtx();
    mkdirSync(join(ctx2.configDir, 'private'));
    writeFileSync(join(ctx2.configDir, 'elsewhere.md'), 'leak');
    symlinkSync(join(ctx2.configDir, 'elsewhere.md'), join(ctx2.configDir, 'private', '201.md'));
    expect(readPrivateBrief(ctx2.configDir, '201')).toBeNull();
  });
  it('an unwritable private dir leaves no hub handover', async () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.configDir, 'private'), 'a file where the dir should be');
    const err = await startTask(ctx, make(true), LEGACY_WORKFLOW, { task: '201', cwd: '/' }).catch((e) => e);
    expect(err).toBeInstanceOf(HubError);
    expect(err.code).toBe('PRIVATE_WRITE');
    expect(readHandover(ctx, '201')).toBeNull();
  });
});

describe('restricted marker and full scan', () => {
  const use = (name: string, task: string) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: { task } }] } });
  const big = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(900) }] } });
  const deps = (st: { called: boolean }) => ({ run: () => { st.called = true; return '{"phase":"done","goal":"g"}'; }, persist: async () => {} });

  it('start and resume write a 0600 marker that outlives finish', async () => {
    const ctx = makeCtx();
    await startTask(ctx, make(true), LEGACY_WORKFLOW, { task: '201', cwd: '/' });
    const marker = join(ctx.configDir, 'private', '201.restricted');
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    const ctx2 = makeCtx();
    writeHandover(ctx2, { task: '201', asanaModifiedAt: '', brief: 'b', related: [] });
    await resumeTask(ctx2, make(true), '201');
    expect(existsSync(join(ctx2.configDir, 'private', '201.restricted'))).toBe(true);
  });
  it('skips a session that only looked at a restricted ticket via a marker', async () => {
    const ctx = makeCtx();
    markRestricted(ctx.configDir, '201', ctx.now());
    const t = join(ctx.configDir, 'tr.jsonl');
    writeFileSync(t, `${use('hub_task_details', '201')}\n${big}\n`);
    const st = { called: false };
    expect(await summarizeSession(ctx, { sessionId: 's', transcriptPath: t, trigger: 'precompact', cwd: '/' }, deps(st))).toBeNull();
    expect(st.called).toBe(false);
  });
  it('finds an early tool call past the tail window, next to a malformed line', async () => {
    const ctx = makeCtx();
    markRestricted(ctx.configDir, '201', ctx.now());
    const t = join(ctx.configDir, 'tr.jsonl');
    writeFileSync(t, `{"type":"assistant","tool_use" broken\n${use('mcp__plugin_rixflow_hub__resume_task', '201')}\n`);
    const filler = (big + '\n').repeat(2000);
    for (let i = 0; i < 6; i++) appendFileSync(t, filler.repeat(Math.ceil(1.5 * 1024 * 1024 / filler.length)));
    expect(statSync(t).size).toBeGreaterThan(8 * 1024 * 1024);
    const st = { called: false };
    expect(await summarizeSession(ctx, { sessionId: 's', transcriptPath: t, trigger: 'precompact', cwd: '/' }, deps(st))).toBeNull();
    expect(st.called).toBe(false);
  });
  it('touchedTasks returns null for an unreadable transcript', () => {
    expect(touchedTasks(join(makeCtx().configDir, 'missing.jsonl'))).toBeNull();
  });
});
