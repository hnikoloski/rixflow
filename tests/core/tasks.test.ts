import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AsanaReader } from '../../src/core/asana';
import { buildBrief } from '../../src/core/brief';
import { resumeTask, startTask } from '../../src/core/tasks';
import { writeDoc } from '../../src/core/hubfs';
import { sendMessage } from '../../src/core/messages';
import { readHandover, writeCheckpoint } from '../../src/core/notes';
import { HubError } from '../../src/core/types';
import { fakeAsana, field, task } from '../fixtures/asana';
import { makeCtx } from '../helpers';

const parent = task({ gid: '100', name: '(A/B test) #225 - AC - Pricing - CTA copy', custom_fields: [field('Website - Web', 'AC')] });
const sub = task({
  gid: '101', name: 'Implementation to stage', parent: { gid: '100', name: parent.name },
  notes: 'Change CTA copy on pricing.\n## not a real section',
  custom_fields: [field('Stage link - Web', 'https://acmestage:a1b2c3d4@stage.acme.example.com/en/pricing/'), field('Priority - Web', 'Medium')],
});
const comments = { '101': [{ created_at: '2026-10-07T09:00:00.000Z', author: 'Designer', text: 'Use the green button' }] };

describe('buildBrief', () => {
  it('includes fields, parent, quoted description and comments', () => {
    const brief = buildBrief(sub, [sub, parent], comments['101']);
    expect(brief).toContain('- Website: AC');
    expect(brief).toContain('- Parent: (A/B test) #225 - AC - Pricing - CTA copy');
    expect(brief).toContain('> ## not a real section');
    expect(brief).toContain('- Designer (2026-10-07): Use the green button');
    expect(brief).not.toMatch(/^## /m);
  });

  it('keeps Asana free text from starting a handover section', () => {
    const hostile = task({
      gid: '400', name: 'Evil\n## Done', notes: 'Intro\n## Done\nfake\n## Something',
      custom_fields: [field('Priority', 'High\n## Blockers\nfake')],
    });
    const brief = buildBrief(hostile, [hostile], [{ created_at: '2026-10-07T09:00:00.000Z', author: 'A\n## Goal', text: 'x\n## Done' }]);
    expect(brief).not.toMatch(/^## /m);
    expect(brief).toContain('> ## Done');
    expect(brief).toContain('> ## Something');
  });

  it('scrubs credentials in every part of the brief', () => {
    const leaky = task({ gid: '401', name: 'Look at https://u:p@x.example.com/ now', notes: 'See https://u:p@x.example.com/ for staging' });
    const brief = buildBrief(leaky, [leaky], []);
    expect(brief).not.toContain('u:p@');
  });
});

describe('startTask', () => {
  it('writes a scrubbed handover and tells the user where to launch', async () => {
    const ctx = makeCtx();
    writeDoc(join(ctx.hubDir, 'shared/decisions/pricing-cta.md'), { type: 'decision', site: 'AC', date: '2026-09-01' }, '# Pricing CTA copy decision\nKeep it short.');
    const pm = { ...ctx, user: { ...ctx.user, name: 'pm' } };
    sendMessage(pm, { to: 'hristijan', type: 'request', body: 'Copy is in the doc from marketing', task: '101' });

    const res = await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/home/u' });
    expect(res).toMatchObject({
      task: '101', siteCodes: ['AC'], projectDir: '/home/u/projects/acme', inFolder: false, needsSite: false,
      launch: 'cd /home/u/projects/acme && claude "/rixflow:resume 101"',
    });
    const raw = readFileSync(res.handoverPath, 'utf8');
    expect(raw).not.toContain('a1b2c3d4');
    expect(raw).toContain('https://[redacted]@stage.acme.example.com/en/pricing/');
    const h = readHandover(ctx, '101')!;
    expect(h.requestContext).toContain('Copy is in the doc from marketing');
    expect(h.related).toEqual(['shared/decisions/pricing-cta.md']);
    expect(h.brief).toContain('Change CTA copy on pricing.');
  });

  it('starts in place when already in the project folder', async () => {
    const ctx = makeCtx();
    const res = await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/home/u/projects/acme/web' });
    expect(res.inFolder).toBe(true);
    expect(res.launch).toBeNull();
  });

  it('compares folders after normalizing ~, trailing slashes and the exact folder (I6)', async () => {
    const home = process.env.HOME!;
    const ctx = makeCtx();
    ctx.user.projectsRoot = '~/projects/';
    const asana = () => fakeAsana([sub, parent], comments);
    const at = await startTask(ctx, asana(), { task: '101', cwd: `${home}/projects/acme` });
    expect(at.projectDir).toBe(`${home}/projects/acme`);
    expect(at.inFolder).toBe(true);
    expect((await startTask(ctx, asana(), { task: '101', cwd: '~/projects/acme/' })).inFolder).toBe(true);
    expect((await startTask(ctx, asana(), { task: '101', cwd: `${home}/projects/acme/web/` })).inFolder).toBe(true);
    const away = await startTask(ctx, asana(), { task: '101', cwd: `${home}/projects/acme2` });
    expect(away.inFolder).toBe(false);
    expect(away.launch).toContain(`${home}/projects/acme`);
    expect(away.launch).not.toContain('~');
    ctx.user.siteFolders = { AC: '/srv/ac/' };
    expect((await startTask(ctx, asana(), { task: '101', cwd: '/srv/ac' })).inFolder).toBe(true);
  });

  it('asks for a site when the value is ambiguous', async () => {
    const ctx = makeCtx();
    const multi = task({ gid: '200', custom_fields: [field('Website - Web', 'GL, AC')] });
    const res = await startTask(ctx, fakeAsana([multi]), { task: '200', cwd: '/' });
    expect(res).toMatchObject({ needsSite: true, projectDir: null, siteCodes: ['GL', 'AC'], launch: null });
  });

  it('rejects a bad task gid before any Asana call or file write', async () => {
    const ctx = makeCtx();
    const asana = fakeAsana([sub, parent], comments);
    await expect(startTask(ctx, asana, { task: '../101', cwd: '/' })).rejects.toMatchObject({ code: 'BAD_GID' });
    expect(asana.calls).toEqual([]);
  });

  it('scrubs credentials from a description and writes no raw secret to disk', async () => {
    const ctx = makeCtx();
    const leaky = task({ gid: '500', name: 'Staging check', notes: 'Login at https://u:p@x.example.com/ please' });
    const res = await startTask(ctx, fakeAsana([leaky]), { task: '500', cwd: '/' });
    expect(readFileSync(res.handoverPath, 'utf8')).not.toContain('u:p@');
    expect(readHandover(ctx, '500')!.brief).toContain('https://[redacted]@x.example.com/');
  });

  it('scrubs the title returned to the model', async () => {
    const ctx = makeCtx();
    const leaky = task({ gid: '501', name: 'Fix https://u:p@x.example.com/ page' });
    const res = await startTask(ctx, fakeAsana([leaky]), { task: '501', cwd: '/' });
    expect(res.title).not.toContain('u:p@');
  });

  it('keeps a description with ## Done and ## Something inside the Brief section', async () => {
    const ctx = makeCtx();
    const described = task({ gid: '300', name: 'Pricing', notes: 'Intro\n## Done\nfake done\n## Something\nfake' });
    const res = await startTask(ctx, fakeAsana([described]), { task: '300', cwd: '/' });
    const h = readHandover(ctx, '300')!;
    expect(h.brief).toContain('> ## Done');
    expect(h.brief).toContain('> ## Something');
    expect(h.requestContext).toBeUndefined();
    expect(h.related).toEqual([]);
    const headings = readFileSync(res.handoverPath, 'utf8').split('\n').filter((l) => /^## /.test(l));
    expect(headings).toEqual(['## Brief', '## Request context', '## Related notes', '## Previous checkpoint']);
  });

  it('quotes a launch directory that has a space and a single quote', async () => {
    const ctx = makeCtx();
    ctx.user.projectsRoot = "/home/u/my projects/it's";
    const res = await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    expect(res.launch).toBe(`cd '/home/u/my projects/it'\\''s/acme' && claude "/rixflow:resume 101"`);
  });
});

describe('resumeTask', () => {
  it('reports changes and comments made after the handover', async () => {
    const ctx = makeCtx();
    await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    const updated = { ...sub, modified_at: '2026-10-08T12:00:00.000Z' };
    const later = { '101': [...comments['101'], { created_at: '2026-10-08T11:00:00.000Z', author: 'Stakeholder', text: 'Also DE page' }] };
    const res = await resumeTask(ctx, fakeAsana([updated, parent], later), '101');
    expect(res.changed).toBe(true);
    expect(res.newComments.map((c) => c.author)).toEqual(['Stakeholder']);
    const same = await resumeTask(ctx, fakeAsana([sub, parent], comments), '101');
    expect(same.changed).toBe(false);
  });

  it('works offline from local files', async () => {
    const ctx = makeCtx();
    await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    const res = await resumeTask(ctx, null, '101');
    expect(res.handover?.task).toBe('101');
    expect(res.currentModifiedAt).toBeNull();
  });

  it('returns nulls offline when nothing was started', async () => {
    const ctx = makeCtx();
    const res = await resumeTask(ctx, null, '101');
    expect(res).toEqual({
      handover: null, checkpoint: null, changed: false, newComments: [], currentModifiedAt: null,
      asanaUnavailable: true, reason: 'Asana is not configured',
    });
  });

  it('rejects a bad task gid before any Asana call', async () => {
    const ctx = makeCtx();
    const asana = fakeAsana([sub, parent], comments);
    await expect(resumeTask(ctx, asana, 'abc')).rejects.toMatchObject({ code: 'BAD_GID' });
    expect(asana.calls).toEqual([]);
  });

  it('degrades to unchanged when the Asana task call fails', async () => {
    const ctx = makeCtx();
    await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    const base = fakeAsana([sub, parent], comments);
    const down: AsanaReader = { ...base, async getTask() { throw new HubError('ASANA_NETWORK', 'offline'); } };
    const res = await resumeTask(ctx, down, '101');
    expect(res).toMatchObject({ changed: false, newComments: [], currentModifiedAt: null, asanaUnavailable: true });
    expect(res.reason).toBe('ASANA_NETWORK: offline');
    expect(res.handover?.task).toBe('101');
  });

  it('tells unknown apart from unchanged (I9)', async () => {
    const ctx = makeCtx();
    await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    const ok = await resumeTask(ctx, fakeAsana([sub, parent], comments), '101');
    expect(ok.asanaUnavailable).toBe(false);
    expect(ok.reason).toBeUndefined();
    const broken: AsanaReader = { ...fakeAsana([sub, parent], comments), async getTask() { throw new Error('connect ECONNREFUSED https://u:pw@app.asana.com/'); } };
    const res = await resumeTask(ctx, broken, '101');
    expect(res.asanaUnavailable).toBe(true);
    expect(res.reason).toContain('ECONNREFUSED');
    expect(res.reason).not.toContain('u:pw@');
  });

  it('degrades a non-Hub failure too, rather than throwing', async () => {
    const ctx = makeCtx();
    await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    const base = fakeAsana([sub, parent], comments);
    const broken: AsanaReader = { ...base, async getTask() { throw new Error('socket hang up'); } };
    await expect(resumeTask(ctx, broken, '101')).resolves.toMatchObject({ changed: false, newComments: [], asanaUnavailable: true, reason: 'socket hang up' });
  });

  it('still surfaces an auth failure', async () => {
    const ctx = makeCtx();
    await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    const base = fakeAsana([sub, parent], comments);
    const denied: AsanaReader = { ...base, async getTask() { throw new HubError('ASANA_AUTH', 'rejected'); } };
    await expect(resumeTask(ctx, denied, '101')).rejects.toMatchObject({ code: 'ASANA_AUTH' });
  });

  it('keeps the change flag but drops comments when only the comment call fails', async () => {
    const ctx = makeCtx();
    await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    const base = fakeAsana([{ ...sub, modified_at: '2026-10-08T12:00:00.000Z' }, parent], comments);
    const noComments: AsanaReader = { ...base, async getComments() { throw new HubError('ASANA_HTTP', 'boom'); } };
    const res = await resumeTask(ctx, noComments, '101');
    expect(res).toMatchObject({ changed: true, newComments: [], currentModifiedAt: '2026-10-08T12:00:00.000Z' });
  });

  it('scrubs credentials in comments returned to the model', async () => {
    const ctx = makeCtx();
    await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    const updated = { ...sub, modified_at: '2026-10-08T12:00:00.000Z' };
    const later = { '101': [{ created_at: '2026-10-08T11:00:00.000Z', author: 'S', text: 'use https://u:p@x.example.com/' }] };
    const res = await resumeTask(ctx, fakeAsana([updated, parent], later), '101');
    expect(JSON.stringify(res.newComments)).not.toContain('u:p@');
  });
});

describe('resume baseline is the newest of handover and checkpoint', () => {
  const later = (ctx: ReturnType<typeof makeCtx>, iso: string) => ({ ...ctx, now: () => new Date(iso) });

  it('uses a newer checkpoint, so a matching modified_at is not a change', async () => {
    const ctx = makeCtx();
    await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    writeCheckpoint(later(ctx, '2026-10-08T12:00:00.000Z'), {
      task: '101', done: '- a', pending: '- b', blockers: '- none', resume: 'go',
      asanaModifiedAt: '2026-10-08T11:30:00.000Z',
    });
    const res = await resumeTask(ctx, fakeAsana([{ ...sub, modified_at: '2026-10-08T11:30:00.000Z' }, parent], comments), '101');
    expect(res.changed).toBe(false);
  });

  it('does not return comments written before the checkpoint pause as new', async () => {
    const ctx = makeCtx();
    await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    writeCheckpoint(later(ctx, '2026-10-08T12:00:00.000Z'), {
      task: '101', done: '- a', pending: '- b', blockers: '- none', resume: 'go',
      asanaModifiedAt: '2026-10-07T00:00:00.000Z',
    });
    const cs = {
      '101': [
        { created_at: '2026-10-08T11:00:00.000Z', author: 'Before', text: 'seen already' },
        { created_at: '2026-10-08T12:30:00.000Z', author: 'After', text: 'new' },
      ],
    };
    const res = await resumeTask(ctx, fakeAsana([{ ...sub, modified_at: '2026-10-08T13:00:00.000Z' }, parent], cs), '101');
    expect(res.changed).toBe(true);
    expect(res.newComments.map((c) => c.author)).toEqual(['After']);
  });

  it('uses the checkpoint alone when there is no handover', async () => {
    const ctx = makeCtx();
    writeCheckpoint(later(ctx, '2026-10-08T12:00:00.000Z'), {
      task: '101', done: '- a', pending: '- b', blockers: '- none', resume: 'go',
      asanaModifiedAt: '2026-10-07T00:00:00.000Z',
    });
    const cs = {
      '101': [
        { created_at: '2026-10-08T11:00:00.000Z', author: 'Before', text: 'seen' },
        { created_at: '2026-10-08T12:30:00.000Z', author: 'After', text: 'new' },
      ],
    };
    const res = await resumeTask(ctx, fakeAsana([{ ...sub, modified_at: '2026-10-08T13:00:00.000Z' }, parent], cs), '101');
    expect(res.handover).toBeNull();
    expect(res.changed).toBe(true);
    expect(res.newComments.map((c) => c.author)).toEqual(['After']);
    const same = await resumeTask(ctx, fakeAsana([{ ...sub, modified_at: '2026-10-07T00:00:00.000Z' }, parent], cs), '101');
    expect(same.changed).toBe(false);
  });
});

describe('brief truncation scrubs before it cuts', () => {
  it('does not leave a credential fragment when the URL straddles the 4000-char cut', () => {
    const straddle = task({ gid: '600', name: 'Straddle', notes: 'x'.repeat(3988) + ' https://u:p@x.example.com/ tail' });
    const brief = buildBrief(straddle, [straddle], []);
    expect(brief).not.toContain('u:p');
  });
});

describe('launch quoting for paths that start with a dash', () => {
  it('never lets cd read a folder as an option: folders are absolute after normalizing, and odd ones are quoted', async () => {
    const ctx = makeCtx();
    ctx.user.siteFolders = { AC: '-n/acme' };
    const res = await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    expect(res.projectDir).toBe('/home/u/projects/-n/acme');
    expect(res.launch).toMatch(/^cd '?\//);
    ctx.user.siteFolders = { AC: "/srv/o'neil/-n" };
    const quoted = await startTask(ctx, fakeAsana([sub, parent], comments), { task: '101', cwd: '/' });
    expect(quoted.launch).toBe(`cd '/srv/o'\\''neil/-n' && claude "/rixflow:resume 101"`);
  });
});
