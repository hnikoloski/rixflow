import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivateBrief, restrictedBrief, writePrivateBrief } from '../../src/core/private';
import { readHandover, writeHandover, endHandover } from '../../src/core/notes';
import { resumeTask, startTask } from '../../src/core/tasks';
import { summarizeSession } from '../../src/core/summarize';
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
