import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isCurrentSprint, parseSprintSection } from '../../src/core/sprint';
import { folderFor, resolveSite } from '../../src/core/sites';
import { buildPlate, gatherPlate, renderPlate } from '../../src/core/plate';
import { sendMessage, type Message } from '../../src/core/messages';
import { writeCheckpoint } from '../../src/core/notes';
import { HubError } from '../../src/core/types';
import { fakeAsana, field, task } from '../fixtures/asana';
import { makeCtx } from '../helpers';

const sites = { AC: { folder: 'acme' }, GL: { folder: 'globex-web' } };
const user = { name: 'hristijan', role: 'dev' as const, projectsRoot: '/p', siteFolders: {}, taskSites: {} };
const sprintSection = (name: string) => ({ project: { gid: '9', name: 'Growth Web Team Sprints' }, section: { gid: '8', name } });

describe('sprint', () => {
  it('parses day.month ranges', () => {
    const s = parseSprintSection('Sprint 41 | 5.10 - 9.10', 2026)!;
    expect(s.number).toBe(41);
    expect(s.start.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(isCurrentSprint('Sprint 41 | 5.10 - 9.10', new Date('2026-10-08T10:00:00Z'))).toBe(true);
    expect(isCurrentSprint('Sprint 41 | 5.10 - 9.10', new Date('2026-10-12T10:00:00Z'))).toBe(false);
    expect(parseSprintSection('Sprint backlog', 2026)).toBeNull();
  });
  it('handles a sprint that spans the new year', () => {
    expect(isCurrentSprint('Sprint 53 | 29.12 - 2.1', new Date('2027-01-01T09:00:00Z'))).toBe(true);
    expect(isCurrentSprint('Sprint 53 | 29.12 - 2.1', new Date('2026-12-30T09:00:00Z'))).toBe(true);
  });
  it('treats the whole end day as inside the sprint, in UTC', () => {
    expect(isCurrentSprint('Sprint 41 | 5.10 - 9.10', new Date('2026-10-09T23:59:59.999Z'))).toBe(true);
    expect(isCurrentSprint('Sprint 41 | 5.10 - 9.10', new Date('2026-10-10T00:00:00.000Z'))).toBe(false);
    expect(isCurrentSprint('Sprint 41 | 5.10 - 9.10', new Date('2026-10-05T00:00:00.000Z'))).toBe(true);
    expect(isCurrentSprint('Sprint 41 | 5.10 - 9.10', new Date('2026-10-04T23:59:59.999Z'))).toBe(false);
  });
  it('returns null for invalid dates and never throws on odd section names', () => {
    expect(parseSprintSection('Sprint 9 | 31.2 - 5.3', 2026)).toBeNull();
    expect(parseSprintSection('Sprint 9 | 5.13 - 9.13', 2026)).toBeNull();
    expect(parseSprintSection('Sprint 9 | 0.5 - 9.5', 2026)).toBeNull();
    expect(parseSprintSection('Sprint 9 | 9.10 - 5.10', 2026)).toBeNull();
    expect(isCurrentSprint('Sprint 9 | 31.2 - 5.3', new Date('2026-02-03T00:00:00Z'))).toBe(false);
    expect(() => isCurrentSprint('', new Date())).not.toThrow();
    expect(() => isCurrentSprint('Sprint | . - .', new Date())).not.toThrow();
    expect(isCurrentSprint('Sprint backlog', new Date())).toBe(false);
  });
});

describe('resolveSite', () => {
  it('uses the task field first, then the parent chain', () => {
    const parent = task({ gid: '1', custom_fields: [field('Website - Web', 'AC')] });
    const child = task({ gid: '2', parent: { gid: '1', name: 'p' }, custom_fields: [field('Website - Web', null)] });
    expect(resolveSite([child, parent], sites, user)).toEqual({ codes: ['AC'], folder: '/p/acme', source: 'parent' });
    expect(resolveSite([parent], sites, user).source).toBe('task');
  });
  it('returns no folder for multi-site values so the user is asked', () => {
    const t = task({ gid: '3', custom_fields: [field('Website - Web', 'GL, AC')] });
    expect(resolveSite([t], sites, user)).toEqual({ codes: ['GL', 'AC'], folder: null, source: 'task' });
  });
  it('prefers a remembered choice and honours folder overrides', () => {
    const t = task({ gid: '3', custom_fields: [field('Website - Web', 'GL, AC')] });
    const u = { ...user, taskSites: { '3': 'GL' }, siteFolders: { GL: '/elsewhere/gl' } };
    expect(resolveSite([t], sites, u)).toEqual({ codes: ['GL'], folder: '/elsewhere/gl', source: 'remembered' });
    expect(folderFor('XX', sites, user)).toBeNull();
  });
  it('reports none when nothing is set anywhere', () => {
    expect(resolveSite([task({ gid: '4' })], sites, user)).toEqual({ codes: [], folder: null, source: 'none' });
  });
  it('reports none for an empty chain instead of throwing', () => {
    expect(resolveSite([], sites, user)).toEqual({ codes: [], folder: null, source: 'none' });
  });
});

describe('folderFor', () => {
  it('keeps site folders inside projectsRoot', () => {
    expect(folderFor('AC', sites, user)).toBe('/p/acme');
    expect(folderFor('BAD', { BAD: { folder: '../evil' } }, user)).toBeNull();
    expect(folderFor('BAD', { BAD: { folder: '/etc' } }, user)).toBeNull();
    expect(folderFor('OK', { OK: { folder: '..foo' } }, user)).toBe('/p/..foo');
    expect(folderFor('BAD', { BAD: { folder: '..' } }, user)).toBeNull();
  });
  it('returns explicit siteFolders overrides exactly as given', () => {
    expect(folderFor('GL', sites, { ...user, siteFolders: { GL: '/opt/gl' } })).toBe('/opt/gl');
  });
});

describe('buildPlate', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  it('groups, orders and numbers items', () => {
    const ctx = makeCtx({ name: 'pm', role: 'pm' });
    const msg = sendMessage(ctx, { to: 'hristijan', type: 'request', body: 'Please check the pricing page\nmore' });
    const tasks = [
      task({ gid: '10', name: 'Backlog thing', memberships: [sprintSection('Sprint backlog')] }),
      task({ gid: '11', name: 'Sprint late', due_on: '2026-10-09', memberships: [sprintSection('Sprint 41 | 5.10 - 9.10')] }),
      task({ gid: '12', name: 'Sprint early', due_on: '2026-10-06', memberships: [sprintSection('Sprint 41 | 5.10 - 9.10')] }),
      task({ gid: '13', name: '[Hotfix] checkout broken' }),
      task({ gid: '14', name: 'Doing', custom_fields: [field('Status - Web', 'In Progress')] }),
      task({ gid: '15', name: 'Paused one' }),
    ].map((t) => ({ task: t, chain: [t], sites: ['AC'] }));
    const plate = buildPlate({
      tasks, inbox: [msg], checkpoints: [{ task: '15', done: '', pending: '', blockers: '', resume: '' }], waiting: [], now,
    });
    expect(plate.sprintName).toBe('Sprint 41 | 5.10 - 9.10');
    expect(plate.urgent.map((i) => i.ref)).toEqual(['13']);
    expect(plate.inProgress.map((i) => i.ref)).toEqual(['14', '15']);
    expect(plate.inProgress[1].paused).toBe(true);
    expect(plate.sprint.map((i) => i.ref)).toEqual(['12', '11']);
    expect(plate.inbox[0]).toMatchObject({ kind: 'message', ref: msg.id, title: 'Please check the pricing page', from: 'pm', messageType: 'request' });
    expect(plate.backlog.map((i) => i.ref)).toEqual(['10']);
    expect([...plate.urgent, ...plate.inProgress, ...plate.sprint, ...plate.inbox, ...plate.backlog].map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const text = renderPlate(plate);
    expect(text).toContain('1. [AC] [Hotfix] checkout broken');
    expect(text).toContain('(paused)');
  });

  it('puts only new and read messages in the inbox', () => {
    const ctx = makeCtx({ name: 'pm', role: 'pm' });
    const msg = sendMessage(ctx, { to: 'hristijan', type: 'question', body: 'open?' });
    const readMsg: Message = { ...msg, id: '2026-10-08-abcd', status: 'read' };
    const doneMsg: Message = { ...msg, id: '2026-10-08-wxyz', status: 'done' };
    const plate = buildPlate({ tasks: [], inbox: [msg, readMsg, doneMsg], checkpoints: [], waiting: [], now });
    expect(plate.inbox.map((i) => i.ref)).toEqual([msg.id, readMsg.id]);
  });

  it('renders control characters in titles as spaces', () => {
    const t = task({ gid: '20', name: 'evil\u001b[2J title' });
    const plate = buildPlate({ tasks: [{ task: t, chain: [t], sites: [] }], inbox: [], checkpoints: [], waiting: [], now });
    expect(renderPlate(plate)).not.toContain('\u001b');
  });
});

describe('gatherPlate', () => {
  it('walks parents for subtasks without a project or website', async () => {
    const ctx = makeCtx();
    const parent = task({ gid: '1', name: 'Components development on dev', custom_fields: [field('Website - Web', 'GL')], memberships: [sprintSection('Sprint 41 | 5.10 - 9.10')] });
    const sub = task({ gid: '2', name: 'Testimonial card', parent: { gid: '1', name: 'Components development on dev' } });
    const asana = fakeAsana([parent, sub], {}, ['2']);
    const plate = await gatherPlate(ctx, asana);
    expect(plate.sprint[0]).toMatchObject({ ref: '2', sites: ['GL'] });
    expect(asana.calls).toEqual(['getMyTasks', 'getTask:1']);
  });
  it('fails clearly without a workspace', async () => {
    const ctx = makeCtx();
    ctx.user.asanaWorkspace = undefined;
    await expect(gatherPlate(ctx, fakeAsana([]))).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });
  it('shows tasks with a checkpoint as paused', async () => {
    const ctx = makeCtx();
    writeCheckpoint(ctx, { task: '5', done: '', pending: '', blockers: '', resume: '' });
    const plate = await gatherPlate(ctx, fakeAsana([task({ gid: '5', name: 'Half done' })]));
    expect(plate.inProgress[0]).toMatchObject({ ref: '5', paused: true });
  });
  it('degrades a task whose parent fetch fails instead of crashing', async () => {
    const ctx = makeCtx();
    const sub = task({ gid: '2', name: 'Orphan subtask', parent: { gid: '1', name: 'gone' }, custom_fields: [field('Website - Web', 'AC')] });
    const good = task({ gid: '3', name: 'Fine task', memberships: [sprintSection('Sprint 41 | 5.10 - 9.10')] });
    const base = fakeAsana([sub, good], {}, ['2', '3']);
    const asana = { ...base, getTask: async (gid: string) => { throw new HubError('ASANA_NETWORK', `no ${gid}`); } };
    const plate = await gatherPlate(ctx, asana);
    expect(plate.backlog.map((i) => i.ref)).toEqual(['2']);
    expect(plate.backlog[0].sites).toEqual(['AC']);
    expect(plate.sprint.map((i) => i.ref)).toEqual(['3']);
  });
  it('still surfaces auth errors from the parent fetch', async () => {
    const ctx = makeCtx();
    const sub = task({ gid: '2', name: 'Sub', parent: { gid: '1', name: 'p' } });
    const base = fakeAsana([sub], {}, ['2']);
    const asana = { ...base, getTask: async () => { throw new HubError('ASANA_AUTH', 'rejected'); } };
    await expect(gatherPlate(ctx, asana)).rejects.toMatchObject({ code: 'ASANA_AUTH' });
  });
  it('never writes to the hub and never renders link-field values', async () => {
    const ctx = makeCtx();
    const secret = 'https://u:hunter2@x.example.com/';
    const t = task({
      gid: '7', name: 'Linked', permalink_url: secret,
      custom_fields: [field('Staging link - Web', secret), field('Status - Web', 'In Progress')],
    });
    const before = readdirSync(ctx.hubDir, { recursive: true }).sort();
    const plate = await gatherPlate(ctx, fakeAsana([t]));
    expect(readdirSync(ctx.hubDir, { recursive: true }).sort()).toEqual(before);
    expect(renderPlate(plate)).not.toContain('hunter2');
    expect(renderPlate(plate)).not.toContain('example');
  });
});

describe('plate output is scrubbed', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  it('removes URL credentials from every displayed string', () => {
    const t = task({
      gid: '30', name: 'fix https://u:p@x.example.com/a', custom_fields: [field('Status - Web', 'Blocked https://u:p@x.example.com/s')],
      memberships: [sprintSection('Sprint 41 | 5.10 - 9.10 https://u:p@x.example.com/z')],
    });
    const plate = buildPlate({ tasks: [{ task: t, chain: [t], sites: [] }], inbox: [], checkpoints: [], waiting: [], now });
    const msg = { id: '2026-10-08-abcd', type: 'question', from: 'pm', to: 'hristijan', thread: '2026-10-08-abcd', status: 'new', created: now.toISOString(), body: 'see https://u:p@x.example.com/m\nmore', path: '/x' } as Message;
    const waiting = { ...msg, id: '2026-10-07-wxyz', from: 'hristijan', to: 'pm', body: 'wait https://u:p@x.example.com/w' } as Message;
    const withMsg = buildPlate({ tasks: [{ task: t, chain: [t], sites: [] }], inbox: [msg], checkpoints: [], waiting: [waiting], now });
    const text = renderPlate(withMsg);
    expect(text).not.toContain('u:p@');
    expect(text).toContain('[redacted]');
    expect(plate.sprintName).not.toContain('u:p@');
    expect(plate.sprint[0].status).not.toContain('u:p@');
    expect(plate.sprint[0].status).toContain('[redacted]');
  });
});

describe('site lookups ignore inherited properties and bad codes', () => {
  it('does not throw on prototype names and resolves to none', () => {
    for (const value of ['constructor', 'toString']) {
      const t = task({ gid: '40', custom_fields: [field('Website - Web', value)] });
      expect(resolveSite([t], sites, user)).toEqual({ codes: [], folder: null, source: 'none' });
    }
  });
  it('drops malformed codes from a multi-value field', () => {
    const t = task({ gid: '41', custom_fields: [field('Website - Web', 'constructor, GL')] });
    expect(resolveSite([t], sites, user)).toEqual({ codes: ['GL'], folder: '/p/globex-web', source: 'task' });
  });
  it('uses own properties only for overrides and site definitions', () => {
    expect(folderFor('constructor', sites, user)).toBeNull();
    expect(folderFor('toString', sites, user)).toBeNull();
    const t = task({ gid: '42', custom_fields: [field('Website - Web', 'AC')] });
    expect(resolveSite([t], sites, { ...user, taskSites: {} as Record<string, string> }).folder).toBe('/p/acme');
  });
});

describe('gatherPlate parent fetches', () => {
  it('shares one failed parent fetch between sibling subtasks', async () => {
    const ctx = makeCtx();
    const subs = ['2', '3', '4'].map((gid) => task({ gid, name: `Sub ${gid}`, parent: { gid: '1', name: 'gone' } }));
    const base = fakeAsana(subs, {}, ['2', '3', '4']);
    let calls = 0;
    const asana = { ...base, getTask: async () => { calls++; throw new HubError('ASANA_NETWORK', 'down'); } };
    const plate = await gatherPlate(ctx, asana);
    expect(calls).toBe(1);
    expect(plate.backlog.map((i) => i.ref).sort()).toEqual(['2', '3', '4']);
  });
  it('keeps at most five parent fetches in flight', async () => {
    const ctx = makeCtx();
    const subs = Array.from({ length: 12 }, (_, i) => task({ gid: String(100 + i), name: `S${i}`, parent: { gid: String(200 + i), name: 'p' } }));
    const base = fakeAsana(subs, {}, subs.map((t) => t.gid));
    let inFlight = 0;
    let peak = 0;
    const asana = {
      ...base,
      getTask: async (gid: string) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return task({ gid, name: `P ${gid}` });
      },
    };
    const plate = await gatherPlate(ctx, asana);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
    expect(plate.backlog).toHaveLength(12);
  });
});
