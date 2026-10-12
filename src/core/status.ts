import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncResult, SyncStatus } from './git';
import { listInbox, type MessageStatus, type MessageType } from './messages';
import { findActiveHandover, listCheckpoints, readHandover, type Handover } from './notes';
import { display, gatherPlate, type PlateItem } from './plate';
import type { TicketSource } from './tickets/types';
import { HubError, assertTicketId, type Ctx } from './types';
import { jiraUrlChanged, loadWorkflow, type Workflow } from './workflow';

export const STATUS_VERSION = 2;
export const ASANA_CACHE_TTL_MS = 600_000;
// The mod gives `hub status` 10 s. All of it (sync, then tickets) must end within STATUS_BUDGET_MS;
// sync gets SYNC_BUDGET_MS of that, then the status is built without it.
export const STATUS_BUDGET_MS = 9_000;
export const SYNC_BUDGET_MS = 4_000;
const CACHE_FILE = 'status-cache.json';

export interface StatusOptions { cwd: string; task?: string; asana: boolean; refresh: boolean; sync: boolean }

export interface StatusDeps {
  loadCtx: () => Ctx;
  sync: (ctx: Ctx) => Promise<SyncResult | null>;
  source: (ctx: Ctx, wf: Workflow) => TicketSource | null;
  // Defaults to the hub's config/workflow.yml (the legacy Asana mapping when it is missing).
  workflow?: (ctx: Ctx) => Workflow;
  syncBudgetMs?: number;
  budgetMs?: number;
  // Local commits not yet pushed; read when the sync loses its race (it is still running elsewhere).
  pending?: (ctx: Ctx) => Promise<number>;
  // When the budget started (epoch ms): the CLI passes its process start, so node startup counts.
  startedAt?: number;
}

export interface StatusTask { task: string; title: string; sites: string[]; status: string | null; due: string | null; paused: boolean }

export interface HubStatus {
  v: number;
  at: string;
  user: string | null;
  initialized: boolean;
  sync: { status: SyncStatus | 'skipped'; pending: number; detail: string };
  current: {
    task: string; title: string; sites: string[]; status: string | null; due: string | null;
    startedAt: string | null; source: 'session' | 'cwd';
  } | null;
  inbox: Array<{ id: string; from: string; type: MessageType; task: string | null; preview: string; status: MessageStatus; created: string }>;
  paused: Array<{ task: string; title: string; site: string | null; pausedAt: string | null }>;
  sprint: { name: string | null; fetchedAt: string; items: StatusTask[] } | null;
  problems: string[];
}

// `scope` ties the cache to one tracker scope: `asana:<workspace gid>` or `jira:<base url>`.
interface TicketCache { fetchedAt: string; user: string; scope: string; name: string | null; items: StatusTask[] }

export function cacheScope(ctx: Ctx, wf: Workflow): string {
  return wf.tracker.type === 'jira' ? `jira:${wf.tracker.url}` : `asana:${wf.tracker.workspace ?? ctx.user.asanaWorkspace ?? ''}`;
}

export function emptyStatus(now: Date, problems: string[]): HubStatus {
  return {
    v: STATUS_VERSION, at: now.toISOString(), user: null, initialized: false,
    sync: { status: 'skipped', pending: 0, detail: '' }, current: null, inbox: [], paused: [], sprint: null, problems,
  };
}

const line = (re: RegExp, text: string): string | null => {
  const m = re.exec(text);
  return m ? display(m[1]) : null;
};
const titleOf = (h: Handover | null, fallback: string) => (h && line(/^# (.+)$/m, h.brief)) || fallback;

function readCache(ctx: Ctx, scope: string): TicketCache | null {
  try {
    const path = join(ctx.configDir, CACHE_FILE);
    if (!existsSync(path)) return null;
    const c = JSON.parse(readFileSync(path, 'utf8')) as TicketCache;
    if (c.user !== ctx.user.name || c.scope !== scope || !Array.isArray(c.items)) return null;
    return Number.isNaN(Date.parse(c.fetchedAt)) ? null : c;
  } catch {
    return null;
  }
}

// Temp file + rename: a reader never sees half a file, even with several sessions polling.
function writeCache(ctx: Ctx, cache: TicketCache): void {
  const path = join(ctx.configDir, CACHE_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
  }
}

// The problem line for a workflow or ticket source that could not be set up.
function setupProblem(e: unknown, fallback: string): string {
  if (e instanceof HubError && e.code === 'WORKFLOW_TOO_NEW') return 'tickets: update rixflow';
  if (e instanceof HubError && e.code === 'JIRA_BAD_URL') return 'tickets: jira url invalid';
  return fallback;
}

const toTask = (i: PlateItem): StatusTask => ({ task: i.ref, title: i.title, sites: i.sites, status: i.status, due: i.due, paused: i.paused });

// Resolves 'timeout' once `ms` have passed, unless `work` settles first; the timer never outlives it.
async function within<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'timeout'>((done) => {
    timer = setTimeout(() => done('timeout'), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

// A failed or late fetch falls back to the last cache, however old: a stale sprint beats a blank one.
async function ticketSection(
  ctx: Ctx, wf: Workflow, opts: StatusOptions, deps: StatusDeps, problems: string[], deadline: number,
): Promise<TicketCache | null> {
  const scope = cacheScope(ctx, wf);
  const cached = readCache(ctx, scope);
  const now = ctx.now().getTime();
  const age = cached ? now - Date.parse(cached.fetchedAt) : NaN;
  // A fetchedAt in the future (clock change, copied file) counts as stale.
  if (cached && !opts.refresh && age >= 0 && age < ASANA_CACHE_TTL_MS) return cached;
  let source: TicketSource | null;
  try {
    source = deps.source(ctx, wf);
  } catch (e) {
    problems.push(setupProblem(e, 'tickets token missing'));
    return cached;
  }
  if (!source) {
    problems.push(jiraUrlChanged(wf, ctx.user) ? 'tickets: jira url changed' : 'tickets token missing');
    return cached;
  }
  try {
    // Abandoned on timeout: the requests are read-only GETs, and the CLI exits right after.
    const plate = await within(gatherPlate(ctx, source, wf), deadline - Date.now());
    if (plate === 'timeout') {
      problems.push('tickets timed out');
      return cached;
    }
    const fresh: TicketCache = {
      fetchedAt: ctx.now().toISOString(), user: ctx.user.name, scope,
      name: plate.sprintName, items: [...plate.urgent, ...plate.inProgress, ...plate.sprint].map(toTask),
    };
    writeCache(ctx, fresh);
    return fresh;
  } catch (e) {
    problems.push(e instanceof HubError && e.code.endsWith('_AUTH') ? 'tickets token rejected' : 'tickets unreachable');
    return cached;
  }
}

// Each section is assembled on its own: a failure becomes a problem line, never an exception.
export async function buildStatus(opts: StatusOptions, deps: StatusDeps): Promise<HubStatus> {
  let ctx: Ctx;
  try {
    ctx = deps.loadCtx();
  } catch {
    return emptyStatus(new Date(), ['setup needed']);
  }
  const deadline = (deps.startedAt ?? Date.now()) + (deps.budgetMs ?? STATUS_BUDGET_MS);
  const out: HubStatus = { ...emptyStatus(ctx.now(), []), user: ctx.user.name, initialized: true };
  const problems = out.problems;

  if (opts.sync) {
    try {
      // The CLI's sync runs in a detached child: one that loses the race finishes there, holding the lock.
      const r = await within(deps.sync(ctx), deps.syncBudgetMs ?? SYNC_BUDGET_MS);
      if (r === 'timeout') {
        const pending = deps.pending ? await within(deps.pending(ctx), 1_000).catch(() => 0) : 0;
        out.sync = { status: 'offline', pending: typeof pending === 'number' ? pending : 0, detail: 'sync timed out' };
      }
      else out.sync = r ? { status: r.status, pending: r.pending, detail: display(r.detail) } : { status: 'skipped', pending: 0, detail: '' };
    } catch {
      problems.push('sync failed');
    }
  }

  try {
    out.inbox = listInbox(ctx, ['new', 'read']).reverse().map((m) => ({
      id: m.id, from: m.from, type: m.type, task: m.task ?? null, preview: display(m.body), status: m.status, created: m.created,
    }));
  } catch {
    problems.push('inbox unreadable');
  }

  try {
    for (const c of listCheckpoints(ctx)) {
      try {
        assertTicketId(c.task);
      } catch {
        continue; // a hand-edited checkpoint with a bad task id: skip it, keep the rest
      }
      out.paused.push({
        task: c.task, title: titleOf(readHandover(ctx, c.task), c.task),
        site: c.site ? display(c.site) : null, pausedAt: c.pausedAt ? display(c.pausedAt) : null,
      });
    }
  } catch {
    problems.push('checkpoints unreadable');
  }

  // Without --asana (the mod's fast poll) the last cached sprint is served as is, so a fast poll
  // never blanks the sprint a ticket poll fetched.
  let tickets: TicketCache | null = null;
  let wf: Workflow | null = null;
  try {
    wf = deps.workflow ? deps.workflow(ctx) : loadWorkflow(ctx.hubDir);
  } catch (e) {
    problems.push(setupProblem(e, 'tickets: workflow invalid'));
  }
  if (wf) tickets = opts.asana ? await ticketSection(ctx, wf, opts, deps, problems, deadline) : readCache(ctx, cacheScope(ctx, wf));
  if (tickets) out.sprint = { name: tickets.name, fetchedAt: tickets.fetchedAt, items: tickets.items };

  try {
    let task: string | undefined;
    if (opts.task) {
      try {
        assertTicketId(opts.task);
        task = opts.task;
      } catch {
        task = undefined;
      }
    }
    const h = task ? readHandover(ctx, task) : findActiveHandover(ctx, opts.cwd);
    const gid = task ?? h?.task;
    // A session task is current even with a checkpoint (resume_task keeps it) and is left out
    // of paused; only the cwd fallback defers to a checkpoint.
    if (task) out.paused = out.paused.filter((p) => p.task !== task);
    if (gid && (task || !out.paused.some((p) => p.task === gid))) {
      const live = tickets?.items.find((i) => i.task === gid);
      out.current = {
        task: gid,
        title: live?.title ?? titleOf(h, gid),
        sites: (live?.sites ?? (h?.site ? h.site.split(',') : [])).map(display).filter(Boolean),
        status: live ? live.status : h ? line(/^- Status: (.+)$/m, h.brief) : null,
        due: live ? live.due : h ? line(/^- Due: (.+)$/m, h.brief) : null,
        startedAt: h?.created ? display(h.created) : null,
        source: task ? 'session' : 'cwd',
      };
    }
  } catch {
    problems.push('current task unreadable');
  }
  return out;
}
