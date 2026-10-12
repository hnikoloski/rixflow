import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AsanaClient } from '../../src/core/asana';
import { buildStatus, emptyStatus, STATUS_VERSION, type StatusDeps, type StatusOptions } from '../../src/core/status';
import { sendMessage } from '../../src/core/messages';
import { endHandover, writeCheckpoint, writeHandover } from '../../src/core/notes';
import { HubError, type Ctx } from '../../src/core/types';
import { makeSource } from '../../src/core/runtime';
import { LEGACY_WORKFLOW } from '../../src/core/workflow';
import { asSource, fakeAsanaSource, fakeSource, field, task } from '../fixtures/asana';
import { makeCtx } from '../helpers';

const opts = (o: Partial<StatusOptions> = {}): StatusOptions => ({ cwd: '/nowhere', asana: false, refresh: false, sync: false, ...o });
const deps = (ctx: Ctx, o: Partial<StatusDeps> = {}): StatusDeps => ({
  loadCtx: () => ctx,
  sync: async () => ({ status: 'ok', detail: '', pending: 0, conflicts: [] }),
  source: () => null,
  ...o,
});
const as = (ctx: Ctx, name: string): Ctx => ({ ...ctx, user: { ...ctx.user, name } });
const brief = (title: string, status = 'TODO', due = '2026-10-14') => `# ${title}\n\n- Asana: x\n- Status: ${status}\n- Due: ${due}`;
const handover = (ctx: Ctx, gid: string, title: string, projectDir?: string) =>
  writeHandover(ctx, { task: gid, site: 'AC', projectDir, asanaModifiedAt: '', brief: brief(title), related: [] });

describe('buildStatus', () => {
  it('hands the workflow it loaded to the source factory', async () => {
    const ctx = makeCtx();
    const wf = { ...structuredClone(LEGACY_WORKFLOW), legacy: false, tracker: { type: 'asana' as const, workspace: '999' } };
    const seen: unknown[] = [];
    await buildStatus(opts({ asana: true }), deps(ctx, { workflow: () => wf, source: (_c, w) => { seen.push(w); return null; } }));
    expect(seen).toEqual([wf]);
  });
  it('reports not initialized without throwing', async () => {
    const s = await buildStatus(opts(), {
      loadCtx: () => { throw new HubError('NOT_INITIALIZED', 'no config'); },
      sync: async () => null,
      source: () => null,
    });
    expect(s).toMatchObject({ v: STATUS_VERSION, initialized: false, user: null, current: null, inbox: [], paused: [], sprint: null });
    expect(s.problems).toEqual(['setup needed']);
  });

  it('lists new and read messages newest first with a one-line preview', async () => {
    const ctx = makeCtx();
    sendMessage(as(ctx, 'pm'), { to: 'hristijan', type: 'request', body: 'First line\nsecond line', task: '1219374889411287' });
    const later = { ...as(ctx, 'pm'), now: () => new Date('2026-10-08T11:00:00Z') };
    sendMessage(later, { to: 'hristijan', type: 'question', body: 'Newer one' });
    const s = await buildStatus(opts(), deps(ctx));
    expect(s.inbox.map((m) => m.preview)).toEqual(['Newer one', 'First line']);
    expect(s.inbox[1]).toMatchObject({ from: 'pm', type: 'request', task: '1219374889411287', status: 'new' });
    expect(s.inbox[0].task).toBeNull();
  });

  it('scrubs and cleans previews', async () => {
    const ctx = makeCtx();
    sendMessage(as(ctx, 'pm'), { to: 'hristijan', type: 'request', body: 'see https://u:secret@stage.x/ \u001b[31mred' });
    const s = await buildStatus(opts(), deps(ctx));
    expect(s.inbox[0].preview).not.toContain('secret');
    expect(s.inbox[0].preview).toContain('[redacted]');
    expect(s.inbox[0].preview).not.toMatch(/\u001b/);
  });

  it('strips C1 controls and bidi overrides from previews', async () => {
    const ctx = makeCtx();
    sendMessage(as(ctx, 'pm'), { to: 'hristijan', type: 'request', body: 'a\u202eb\u009bc\u0085d\u200ee\u200ff\u202ag\u2066h\u2069i' });
    const s = await buildStatus(opts(), deps(ctx));
    expect(s.inbox[0].preview).not.toMatch(/[\u0080-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    expect(s.inbox[0].preview).toBe('a b c d e f g h i');
  });

  it('picks the current task from --task, then cwd, else null', async () => {
    const ctx = makeCtx();
    handover(ctx, '111', 'Banner overlap', '/home/u/projects/acme');
    handover(ctx, '222', 'Consent mode', '/home/u/projects/globex-web');
    const bySession = await buildStatus(opts({ task: '222', cwd: '/home/u/projects/acme' }), deps(ctx));
    expect(bySession.current).toMatchObject({ task: '222', title: 'Consent mode', source: 'session', status: 'TODO', due: '2026-10-14' });
    const byCwd = await buildStatus(opts({ cwd: '/home/u/projects/acme/src' }), deps(ctx));
    expect(byCwd.current).toMatchObject({ task: '111', title: 'Banner overlap', source: 'cwd' });
    expect((await buildStatus(opts(), deps(ctx))).current).toBeNull();
  });

  it('shows no current task after the handover is ended', async () => {
    const ctx = makeCtx();
    handover(ctx, '111', 'Banner overlap', '/home/u/projects/acme');
    expect((await buildStatus(opts({ cwd: '/home/u/projects/acme' }), deps(ctx))).current?.task).toBe('111');
    endHandover(ctx, '111', 'dropped');
    expect((await buildStatus(opts({ cwd: '/home/u/projects/acme' }), deps(ctx))).current).toBeNull();
  });

  it('ignores an invalid --task and falls back to cwd', async () => {
    const ctx = makeCtx();
    handover(ctx, '111', 'Banner overlap', '/home/u/projects/acme');
    const s = await buildStatus(opts({ task: '../etc', cwd: '/home/u/projects/acme' }), deps(ctx));
    expect(s.current?.task).toBe('111');
  });

  it('reports the session task as current even with a checkpoint (resumed), and not as paused', async () => {
    const ctx = makeCtx();
    handover(ctx, '111', 'Banner overlap', '/home/u/projects/acme');
    writeCheckpoint(ctx, { task: '111', site: 'AC', done: 'd', pending: 'p', blockers: 'none', resume: 'r' });
    const s = await buildStatus(opts({ task: '111' }), deps(ctx));
    expect(s.current).toMatchObject({ task: '111', title: 'Banner overlap', source: 'session' });
    expect(s.paused).toEqual([]);
  });

  it('reports a checkpointed cwd task as paused, not current', async () => {
    const ctx = makeCtx();
    handover(ctx, '111', 'Banner overlap', '/home/u/projects/acme');
    writeCheckpoint(ctx, { task: '111', site: 'AC', done: 'd', pending: 'p', blockers: 'none', resume: 'r' });
    const s = await buildStatus(opts({ cwd: '/home/u/projects/acme' }), deps(ctx));
    expect(s.current).toBeNull();
    expect(s.paused).toEqual([expect.objectContaining({ task: '111', title: 'Banner overlap', site: 'AC' })]);
  });

  it('skips a checkpoint with an invalid task and cleans the others', async () => {
    const ctx = makeCtx();
    handover(ctx, '111', 'Banner overlap', '/home/u/projects/acme');
    writeCheckpoint(ctx, { task: '111', site: 'AC', done: 'd', pending: 'p', blockers: 'none', resume: 'r' });
    const dir = join(ctx.hubDir, 'people', 'hristijan', 'checkpoints');
    writeFileSync(join(dir, 'bad.md'), '---\ntype: checkpoint\ntask: ../etc\n---\n# Checkpoint\n');
    writeFileSync(join(dir, '333.md'), '---\ntype: checkpoint\ntask: "333"\nsite: "C\\u001bB"\npaused_at: "2026\\u202e-10-08"\n---\n# Checkpoint 333\n');
    const s = await buildStatus(opts(), deps(ctx));
    expect(s.problems).toEqual([]);
    expect(s.paused.map((p) => p.task).sort()).toEqual(['111', '333']);
    const odd = s.paused.find((p) => p.task === '333')!;
    expect(odd.site).toBe('C B');
    expect(odd.pausedAt).toBe('2026 -10-08');
  });

  it('times out a slow sync and still reports the rest', async () => {
    const ctx = makeCtx();
    handover(ctx, '111', 'Banner overlap', '/home/u/projects/acme');
    let finish!: () => void;
    const slow = () => new Promise<null>((r) => (finish = () => r(null)));
    const s = await buildStatus(opts({ sync: true, cwd: '/home/u/projects/acme' }), deps(ctx, { sync: slow, syncBudgetMs: 20 }));
    finish();
    expect(s.sync).toEqual({ status: 'offline', pending: 0, detail: 'sync timed out' });
    expect(s.current?.task).toBe('111');
    expect(s.problems).toEqual([]);
  });

  it('a timed-out sync still reports how many commits wait to be pushed', async () => {
    const ctx = makeCtx();
    const sync = () => new Promise<never>(() => {});
    const s = await buildStatus(opts({ sync: true }), deps(ctx, { sync, syncBudgetMs: 20, pending: async () => 2 }));
    expect(s.sync).toEqual({ status: 'offline', pending: 2, detail: 'sync timed out' });
    const broken = await buildStatus(opts({ sync: true }), deps(ctx, { sync, syncBudgetMs: 20, pending: async () => { throw new Error('x'); } }));
    expect(broken.sync).toEqual({ status: 'offline', pending: 0, detail: 'sync timed out' });
  }, 2_000);

  it('maps the sync result and skips sync when asked', async () => {
    const ctx = makeCtx();
    const off = await buildStatus(opts({ sync: true }), deps(ctx, { sync: async () => ({ status: 'offline', detail: 'no net', pending: 3, conflicts: [] }) }));
    expect(off.sync).toEqual({ status: 'offline', pending: 3, detail: 'no net' });
    const skipped = await buildStatus(opts({ sync: false }), deps(ctx));
    expect(skipped.sync.status).toBe('skipped');
  });

  it('a failing section does not hide the others', async () => {
    const ctx = makeCtx();
    handover(ctx, '111', 'Banner overlap', '/home/u/projects/acme');
    const dir = join(ctx.hubDir, 'inbox', 'hristijan');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-10-08-zzzz.md'), '---\nnot: valid\n---\n');
    const s = await buildStatus(opts({ sync: true, cwd: '/home/u/projects/acme' }), deps(ctx, { sync: async () => { throw new Error('boom'); } }));
    expect(s.current?.task).toBe('111');
    expect(s.inbox).toEqual([]);
    expect(s.problems).toEqual(['sync failed']);
  });

  it('fetches the sprint from Asana, caches it, and serves the cache within 10 minutes', async () => {
    const ctx = makeCtx();
    const sprint = { project: { gid: '9', name: 'P' }, section: { gid: '8', name: 'Sprint 41 | 5.10 - 9.10' } };
    const asana = fakeAsanaSource([task({ gid: '111', name: 'Banner', memberships: [sprint], custom_fields: [field('Website', 'AC'), field('Status', 'TODO')], due_on: '2026-10-09' })]);
    const first = await buildStatus(opts({ asana: true }), deps(ctx, { source: () => asana }));
    expect(first.sprint).toMatchObject({ name: 'Sprint 41 | 5.10 - 9.10' });
    expect(first.sprint!.items).toEqual([{ task: '111', title: 'Banner', sites: ['AC'], status: 'TODO', due: '2026-10-09', paused: false }]);
    const calls = asana.calls.length;
    await buildStatus(opts({ asana: true }), deps(ctx, { source: () => asana }));
    expect(asana.calls.length).toBe(calls);
    await buildStatus(opts({ asana: true, refresh: true }), deps(ctx, { source: () => asana }));
    expect(asana.calls.length).toBeGreaterThan(calls);
    expect(JSON.parse(readFileSync(join(ctx.configDir, 'status-cache.json'), 'utf8')).user).toBe('hristijan');
  });

  it('fills the current task status and due from the Asana data', async () => {
    const ctx = makeCtx();
    handover(ctx, '111', 'Banner overlap', '/home/u/projects/acme');
    const sprint = { project: { gid: '9', name: 'P' }, section: { gid: '8', name: 'Sprint 41 | 5.10 - 9.10' } };
    const asana = fakeAsanaSource([task({ gid: '111', name: 'Banner overlap', memberships: [sprint], custom_fields: [field('Status', 'TESTING')], due_on: '2026-10-09' })]);
    const s = await buildStatus(opts({ task: '111', asana: true }), deps(ctx, { source: () => asana }));
    expect(s.current).toMatchObject({ status: 'TESTING', due: '2026-10-09' });
  });

  it('without --asana serves the cached sprint, however old, and never calls Asana', async () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.configDir, 'status-cache.json'), JSON.stringify({
      fetchedAt: '2026-10-01T08:00:00.000Z', user: 'hristijan', scope: `asana:${ctx.user.asanaWorkspace}`, name: 'Sprint 41',
      items: [{ task: '111', title: 'Banner', sites: ['AC'], status: 'TODO', due: null, paused: false }],
    }));
    const asana = fakeAsanaSource([]);
    const s = await buildStatus(opts({ asana: false }), deps(ctx, { source: () => asana }));
    expect(s.sprint).toMatchObject({ name: 'Sprint 41', fetchedAt: '2026-10-01T08:00:00.000Z' });
    expect(asana.calls).toEqual([]);
    expect(s.problems).toEqual([]);
  });

  it('keeps the cached sprint when the token goes missing', async () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.configDir, 'status-cache.json'), JSON.stringify({
      fetchedAt: '2026-10-01T08:00:00.000Z', user: 'hristijan', scope: `asana:${ctx.user.asanaWorkspace}`, name: 'Sprint 41', items: [],
    }));
    const s = await buildStatus(opts({ asana: true }), deps(ctx, { source: () => null }));
    expect(s.sprint).toMatchObject({ name: 'Sprint 41' });
    expect(s.problems).toContain('tickets token missing');
  });

  it('counts the time before buildStatus (process start) against the budget', async () => {
    const ctx = makeCtx();
    const slow = { ...fakeAsanaSource([]), myTickets: () => new Promise<never>(() => {}) };
    const t0 = Date.now();
    const s = await buildStatus(opts({ asana: true, refresh: true }), deps(ctx, { source: () => slow, budgetMs: 10_000, startedAt: Date.now() - 10_000 }));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(s.problems).toContain('tickets timed out');
  }, 2_000);

  it('treats a cache from the future as stale', async () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.configDir, 'status-cache.json'), JSON.stringify({
      fetchedAt: '2099-01-01T00:00:00.000Z', user: 'hristijan', scope: `asana:${ctx.user.asanaWorkspace}`, name: 'old', items: [],
    }));
    const asana = fakeAsanaSource([]);
    await buildStatus(opts({ asana: true }), deps(ctx, { source: () => asana }));
    expect(asana.calls).toContain('getMyTasks');
  });

  it('ignores a corrupt cache', async () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.configDir, 'status-cache.json'), '{"fetchedAt": "2026-10-08T09:59');
    const asana = fakeAsanaSource([]);
    const s = await buildStatus(opts({ asana: true }), deps(ctx, { source: () => asana }));
    expect(asana.calls).toContain('getMyTasks');
    expect(s.problems).toEqual([]);
  });

  it('reports a missing token and an unreachable Asana as problems', async () => {
    const ctx = makeCtx();
    const noToken = await buildStatus(opts({ asana: true }), deps(ctx));
    expect(noToken.problems).toContain('tickets token missing');
    const down = { ...fakeAsanaSource([]), myTickets: async () => { throw new Error('ECONNRESET'); } };
    const unreachable = await buildStatus(opts({ asana: true, refresh: true }), deps(ctx, { source: () => down }));
    expect(unreachable.problems).toContain('tickets unreachable');
    expect(unreachable.sprint).toBeNull();
  });

  it('reports a hanging Asana as unreachable once its request times out', async () => {
    const ctx = makeCtx();
    const hang = ((_url: URL, init: RequestInit) => new Promise<Response>((_ok, fail) => {
      init.signal?.addEventListener('abort', () => fail(init.signal?.reason));
    })) as unknown as typeof fetch;
    const s = await buildStatus(opts({ asana: true, refresh: true }), deps(ctx, { source: () => asSource(new AsanaClient('tok', hang, undefined, 20)) }));
    expect(s.problems).toContain('tickets unreachable');
    expect(s.sprint).toBeNull();
  }, 2_000);

  it('stops a slow Asana at the overall budget, even when each request answers in time', async () => {
    const ctx = makeCtx();
    const slow = { ...fakeAsanaSource([]), myTickets: () => new Promise<never>(() => {}) };
    const t0 = Date.now();
    const s = await buildStatus(opts({ asana: true, refresh: true }), deps(ctx, { source: () => slow, budgetMs: 50 }));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(s.problems).toContain('tickets timed out');
    expect(s.sprint).toBeNull();
  }, 2_000);

  it('counts the sync against the same budget', async () => {
    const ctx = makeCtx();
    const sync = () => new Promise<null>((done) => setTimeout(() => done(null), 60));
    const slow = { ...fakeAsanaSource([]), myTickets: () => new Promise<never>(() => {}) };
    const t0 = Date.now();
    const s = await buildStatus(opts({ asana: true, refresh: true, sync: true }), deps(ctx, { sync, source: () => slow, budgetMs: 80 }));
    expect(Date.now() - t0).toBeLessThan(500);
    expect(s.problems).toContain('tickets timed out');
  }, 2_000);

  it('keeps showing a stale sprint when the refresh fails, and says so', async () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.configDir, 'status-cache.json'), JSON.stringify({
      fetchedAt: '2026-10-08T08:00:00.000Z', user: 'hristijan', scope: `asana:${ctx.user.asanaWorkspace}`, name: 'Sprint 41',
      items: [{ task: '111', title: 'Banner', sites: ['AC'], status: 'TODO', due: null, paused: false }],
    }));
    const down = { ...fakeAsanaSource([]), myTickets: async () => { throw new HubError('ASANA_NETWORK', 'x'); } };
    const s = await buildStatus(opts({ asana: true }), deps(ctx, { source: () => down }));
    expect(s.sprint).toMatchObject({ name: 'Sprint 41', fetchedAt: '2026-10-08T08:00:00.000Z' });
    expect(s.problems).toContain('tickets unreachable');
  });

  it('ties the cache to the tracker scope and ignores a v1 cache', async () => {
    const ctx = makeCtx();
    const item = { task: '111', title: 'Banner', sites: ['AC'], status: 'TODO', due: null, paused: false };
    writeFileSync(join(ctx.configDir, 'status-cache.json'), JSON.stringify({
      fetchedAt: '2026-10-08T09:59:00.000Z', user: 'hristijan', workspace: ctx.user.asanaWorkspace, name: 'Sprint 41', items: [item],
    }));
    expect((await buildStatus(opts(), deps(ctx))).sprint).toBeNull();
    writeFileSync(join(ctx.configDir, 'status-cache.json'), JSON.stringify({
      fetchedAt: '2026-10-08T09:59:00.000Z', user: 'hristijan', scope: 'jira:https://jira.example.com', name: 'Sprint 41', items: [item],
    }));
    expect((await buildStatus(opts(), deps(ctx))).sprint).toBeNull();
    const jira = { ...LEGACY_WORKFLOW, legacy: false, tracker: { type: 'jira' as const, url: 'https://jira.example.com', flavor: 'cloud' as const, projects: ['WEB'] } };
    expect((await buildStatus(opts(), deps(ctx, { workflow: () => jira }))).sprint).toMatchObject({ name: 'Sprint 41' });
  });

  it('reports an invalid workflow as a tickets problem and keeps the other sections', async () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.hubDir, 'config', 'workflow.yml'), 'tracker:\n  type: trello\n');
    sendMessage(as(ctx, 'pm'), { to: 'hristijan', type: 'request', body: 'hi' });
    const s = await buildStatus(opts({ asana: true }), deps(ctx, { source: () => fakeAsanaSource([]) }));
    expect(s.problems).toEqual(['tickets: workflow invalid']);
    expect(s.inbox).toHaveLength(1);
  });

  it('asks for an update when the team setup needs a newer RixFlow, skips tickets and serves the rest', async () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.hubDir, 'config', 'workflow.yml'), 'requires: 99.0.0\ntracker:\n  type: asana\n');
    sendMessage(as(ctx, 'pm'), { to: 'hristijan', type: 'request', body: 'hi' });
    let built = 0;
    const s = await buildStatus(opts({ asana: true }), deps(ctx, { source: () => { built += 1; return fakeAsanaSource([]); } }));
    expect(s.problems).toEqual(['tickets: update rixflow']);
    expect(s.sprint).toBeNull();
    expect(built).toBe(0);
    expect(s.inbox).toHaveLength(1);
  });

  it('reports a rejected Jira URL as a tickets problem instead of throwing', async () => {
    const ctx = makeCtx();
    const jira = { ...structuredClone(LEGACY_WORKFLOW), legacy: false, tracker: { type: 'jira' as const, url: 'http://jira.example.com', flavor: 'server' as const, projects: [] } };
    const s = await buildStatus(opts({ asana: true }), deps(ctx, { workflow: () => jira, source: (c, wf) => makeSource(c, { JIRA_TOKEN: 't' }, wf) }));
    expect(s.problems).toEqual(['tickets: jira url invalid']);
    expect(s.initialized).toBe(true);
  });

  it('reports any *_AUTH error as a rejected token', async () => {
    const ctx = makeCtx();
    const denied = { ...fakeSource([]), myTickets: async () => { throw new HubError('JIRA_AUTH', 'no'); } };
    const s = await buildStatus(opts({ asana: true }), deps(ctx, { source: () => denied }));
    expect(s.problems).toEqual(['tickets token rejected']);
  });

  it('emptyStatus has the full shape', () => {
    expect(emptyStatus(new Date('2026-10-08T10:00:00Z'), ['x'])).toEqual({
      v: STATUS_VERSION, at: '2026-10-08T10:00:00.000Z', user: null, initialized: false,
      sync: { status: 'skipped', pending: 0, detail: '' }, current: null, inbox: [], paused: [], sprint: null, problems: ['x'],
    });
  });
});
