import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AsanaReader } from './asana';
import type { SyncResult, SyncStatus } from './git';
import { listInbox, type MessageStatus, type MessageType } from './messages';
import { findActiveHandover, listCheckpoints, readHandover, type Handover } from './notes';
import { display, gatherPlate, type PlateItem } from './plate';
import { HubError, assertGid, type Ctx } from './types';

export const STATUS_VERSION = 1;
export const ASANA_CACHE_TTL_MS = 600_000;
// The mod gives `hub status` 10 s. All of it (sync, then Asana) must end within STATUS_BUDGET_MS;
// sync gets SYNC_BUDGET_MS of that, then the status is built without it.
export const STATUS_BUDGET_MS = 9_000;
export const SYNC_BUDGET_MS = 4_000;
const CACHE_FILE = 'status-cache.json';

export interface StatusOptions { cwd: string; task?: string; asana: boolean; refresh: boolean; sync: boolean }

export interface StatusDeps {
  loadCtx: () => Ctx;
  sync: (ctx: Ctx) => Promise<SyncResult | null>;
  asana: (ctx: Ctx) => AsanaReader | null;
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

interface AsanaCache { fetchedAt: string; user: string; workspace: string; name: string | null; items: StatusTask[] }

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

function readCache(ctx: Ctx): AsanaCache | null {
  try {
    const path = join(ctx.configDir, CACHE_FILE);
    if (!existsSync(path)) return null;
    const c = JSON.parse(readFileSync(path, 'utf8')) as AsanaCache;
    if (c.user !== ctx.user.name || c.workspace !== ctx.user.asanaWorkspace || !Array.isArray(c.items)) return null;
    return Number.isNaN(Date.parse(c.fetchedAt)) ? null : c;
  } catch {
    return null;
  }
}

// Temp file + rename: a reader never sees half a file, even with several sessions polling.
function writeCache(ctx: Ctx, cache: AsanaCache): void {
  const path = join(ctx.configDir, CACHE_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
  }
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
async function asanaSection(
  ctx: Ctx, opts: StatusOptions, deps: StatusDeps, problems: string[], deadline: number,
): Promise<AsanaCache | null> {
  const cached = readCache(ctx);
  const now = ctx.now().getTime();
  const age = cached ? now - Date.parse(cached.fetchedAt) : NaN;
  // A fetchedAt in the future (clock change, copied file) counts as stale.
  if (cached && !opts.refresh && age >= 0 && age < ASANA_CACHE_TTL_MS) return cached;
  const asana = deps.asana(ctx);
  if (!asana || !ctx.user.asanaWorkspace) {
    problems.push('asana token missing');
    return cached;
  }
  try {
    // Abandoned on timeout: the requests are read-only GETs, and the CLI exits right after.
    const plate = await within(gatherPlate(ctx, asana), deadline - Date.now());
    if (plate === 'timeout') {
      problems.push('asana timed out');
      return cached;
    }
    const fresh: AsanaCache = {
      fetchedAt: ctx.now().toISOString(), user: ctx.user.name, workspace: ctx.user.asanaWorkspace,
      name: plate.sprintName, items: [...plate.urgent, ...plate.inProgress, ...plate.sprint].map(toTask),
    };
    writeCache(ctx, fresh);
    return fresh;
  } catch (e) {
    problems.push(e instanceof HubError && e.code === 'ASANA_AUTH' ? 'asana token rejected' : 'asana unreachable');
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
        assertGid(c.task);
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
  // never blanks the sprint an Asana poll fetched.
  const asana = opts.asana ? await asanaSection(ctx, opts, deps, problems, deadline) : readCache(ctx);
  if (asana) out.sprint = { name: asana.name, fetchedAt: asana.fetchedAt, items: asana.items };

  try {
    let task: string | undefined;
    if (opts.task) {
      try {
        assertGid(opts.task);
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
      const live = asana?.items.find((i) => i.task === gid);
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
