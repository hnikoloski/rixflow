import { normalizeDir, isInsideDir } from './config';
import { buildBrief, oneLine } from './brief';
import { mapTicket } from './mapping';
import { listInbox } from './messages';
import { findTeammateWork, notesForTask, readCheckpoint, readHandover, writeHandover, type Checkpoint, type Handover } from './notes';
import { scrub } from './scrub';
import { search } from './search';
import { markRestricted, readPrivateBrief, restrictedBrief, writePrivateBrief } from './private';
import { resolveSite } from './sites';
import { loadSites } from './team';
import { parentChain, type Ticket, type TicketChild, type TicketComment, type TicketSource } from './tickets/types';
import { HubError, assertTicketId, type Ctx } from './types';
import { stepOf, type Workflow } from './workflow';

export interface StartResult {
  task: string;
  title: string;
  handoverPath: string;
  siteCodes: string[];
  projectDir: string | null;
  inFolder: boolean;
  launch: string | null;
  needsSite: boolean;
}

export interface ResumeResult {
  handover: Handover | null;
  checkpoint: Checkpoint | null;
  changed: boolean;
  newComments: TicketComment[];
  currentModifiedAt: string | null;
  // True when the ticket tracker could not be checked (not configured, unreachable, any non-auth
  // error): `changed: false` then means "unknown", not "unchanged". `reason` says why (scrubbed).
  ticketsUnavailable: boolean;
  reason?: string;
  // True when `handover.brief` is the full brief from this machine's private file.
  privateBrief: boolean;
  // Set when the handover and checkpoint are a teammate's paused work (their name): you had
  // nothing of your own for the task, or you asked for that teammate's work by name.
  from?: string;
  // With `from`: hub paths of everyone's notes on the task (handovers, checkpoints, sessions).
  notes?: string[];
}

function keywords(name: string): string {
  return name.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 6).join(' ');
}

// Plain paths stay bare, so the launch line reads naturally; anything else is single-quoted,
// with each embedded ' written as '\'' so the shell sees one word. A plain path may not start
// with '-', which would read as an option.
function shellPath(path: string): string {
  return /^[A-Za-z0-9_./][A-Za-z0-9_./-]*$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

// `cd --` ends option parsing, so a dash-led path is never taken as a cd flag.
function cdCommand(path: string): string {
  return `cd ${path.startsWith('-') ? '-- ' : ''}${shellPath(path)}`;
}

// The newer of the handover (created) and checkpoint (pausedAt). Falls back to whichever exists.
function newestBaseline(
  handover: Handover | null,
  checkpoint: Checkpoint | null,
): { asanaModifiedAt?: string; at?: string } | null {
  if (!handover && !checkpoint) return null;
  if (!handover) return { asanaModifiedAt: checkpoint!.asanaModifiedAt, at: checkpoint!.pausedAt };
  if (!checkpoint) return { asanaModifiedAt: handover.asanaModifiedAt, at: handover.created };
  const handoverAt = Date.parse(handover.created ?? '');
  const checkpointAt = Date.parse(checkpoint.pausedAt ?? '');
  const checkpointIsNewer = Number.isFinite(checkpointAt) && (!Number.isFinite(handoverAt) || checkpointAt > handoverAt);
  return checkpointIsNewer
    ? { asanaModifiedAt: checkpoint.asanaModifiedAt, at: checkpoint.pausedAt }
    : { asanaModifiedAt: handover.asanaModifiedAt, at: handover.created };
}

// Returns a copy with every top-level string field scrubbed (arrays of strings included).
function scrubFields<T extends object>(v: T): T {
  const scrubValue = (x: unknown): unknown => {
    if (typeof x === 'string') return scrub(x);
    if (Array.isArray(x)) return x.map(scrubValue);
    return x;
  };
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubValue(x)])) as T;
}

function isAuthError(err: unknown): boolean {
  return err instanceof HubError && err.code.endsWith('_AUTH');
}

// Extra brief context is best effort: a failed lookup leaves it out, but a rejected login still surfaces.
async function optional<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isAuthError(err)) throw err;
    return fallback;
  }
}

export async function startTask(ctx: Ctx, source: TicketSource, wf: Workflow, input: { task: string; cwd: string }): Promise<StartResult> {
  assertTicketId(input.task);
  const id = source.normalizeId(input.task);
  const ticket = await source.ticket(id);
  const chain = await parentChain(source, ticket);
  const site = resolveSite(chain, mapTicket(chain, wf, ctx.now()), loadSites(ctx.hubDir), ctx.user);
  const comments = await source.comments(id, 10);
  // A subtask brings its epic (the top of the chain); the epic, or any ticket, brings its subtasks.
  const root = chain[chain.length - 1];
  const epic = root.id !== ticket.id
    ? { ticket: root, comments: root.restricted ? [] : await optional(() => source.comments(root.id, 10), []) }
    : null;
  const subtasks: TicketChild[] = source.children ? await optional(() => source.children!(root.id), []) : [];
  const step = epic ? stepOf(ticket.title, wf.steps) : null;
  const related = search(ctx.hubDir, { text: keywords(chain.map((t) => t.title).join(' ')), site: site.codes[0], limit: 5 }).map((h) => h.path);
  // Stage builds on the dev step: link everyone's notes on the epic's dev subtasks.
  if (step === 'stage') {
    for (const c of subtasks) {
      if (c.id === ticket.id || stepOf(c.title, wf.steps) !== 'dev') continue;
      try { assertTicketId(c.id); } catch { continue; }
      for (const path of notesForTask(ctx, c.id)) if (!related.includes(path)) related.push(path);
    }
  }
  const checkpoint = readCheckpoint(ctx, id);
  const requests = listInbox(ctx)
    .filter((m) => m.task === id)
    .map((m) => oneLine(`- ${m.type} from ${m.from} (${oneLine(scrub(m.created).slice(0, 10))}): ${m.body}`))
    .join('\n');
  if (ticket.restricted) markRestricted(ctx.configDir, id, ctx.now());
  const full = buildBrief(ticket, chain, comments, source.label, { epic, subtasks, step });
  if (ticket.restricted) writePrivateBrief(ctx.configDir, id, full);
  const handoverPath = writeHandover(ctx, {
    task: id,
    site: site.codes.join(', ') || undefined,
    projectDir: site.folder ?? undefined,
    asanaModifiedAt: ticket.modifiedAt,
    brief: ticket.restricted ? restrictedBrief(ticket, source.label, ctx.user.name) : full,
    restricted: ticket.restricted || undefined,
    requestContext: requests || undefined,
    related,
    previousCheckpoint: checkpoint ? `people/${ctx.user.name}/checkpoints/${id}.md` : undefined,
  });
  const inFolder = !!site.folder && isInsideDir(normalizeDir(input.cwd), site.folder);
  return {
    task: id,
    title: scrub(oneLine(ticket.title)),
    handoverPath,
    siteCodes: site.codes,
    projectDir: site.folder,
    inFolder,
    launch: site.folder && !inFolder ? `${cdCommand(site.folder)} && claude "/rixflow:resume ${id}"` : null,
    needsSite: !site.folder,
  };
}

// `noSource` is the reason given when `source` is null. `from` names the teammate whose paused
// work to load (a handover sent to you); it wins over your own notes on the task.
export async function resumeTask(
  ctx: Ctx, source: TicketSource | null, task: string, noSource = 'the ticket tracker is not configured', from?: string,
): Promise<ResumeResult> {
  assertTicketId(task);
  let handover = readHandover(ctx, task);
  let checkpoint = readCheckpoint(ctx, task);
  // Nothing of your own: pick up a teammate's paused work on the task, if any.
  const teammate = from !== undefined && from !== ctx.user.name
    ? findTeammateWork(ctx, task, from)
    : !handover && !checkpoint ? findTeammateWork(ctx, task) : null;
  if (from !== undefined && from !== ctx.user.name && !teammate) {
    throw new HubError('NOT_FOUND', `${from} has no paused work on ${task}`);
  }
  if (teammate) ({ handover, checkpoint } = teammate);
  const priv = handover?.restricted && !teammate ? readPrivateBrief(ctx.configDir, task) : null;
  const local = {
    handover: handover && scrubFields(priv === null ? handover : { ...handover, brief: priv }),
    checkpoint: checkpoint && scrubFields(checkpoint),
    privateBrief: priv !== null,
    ...(teammate ? { from: teammate.from, notes: notesForTask(ctx, task) } : {}),
  };
  const unavailable = (reason: string): ResumeResult => ({
    ...local, changed: false, newComments: [], currentModifiedAt: null, ticketsUnavailable: true, reason: oneLine(scrub(reason)).slice(0, 200),
  });
  if (!source) return unavailable(noSource);
  let current: Ticket;
  let id: string;
  try {
    id = source.normalizeId(task);
    current = await source.ticket(id);
  } catch (err) {
    if (isAuthError(err)) throw err;
    // Tracker unreachable: the local handover and checkpoint still answer the question.
    return unavailable(err instanceof HubError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err));
  }
  if (current.restricted) markRestricted(ctx.configDir, id, ctx.now());
  // The newest local record is the baseline: its ticket timestamp decides `changed`, and its time
  // is the cutoff for comments that count as new.
  const baseline = newestBaseline(handover, checkpoint);
  const since = baseline?.asanaModifiedAt ?? '';
  const changed = !!since && current.modifiedAt !== since;
  let newComments: TicketComment[] = [];
  if (changed) {
    const cutoff = Date.parse(baseline?.at ?? '');
    try {
      newComments = (await source.comments(id, 20)).filter(
        (c) => Number.isNaN(cutoff) || Date.parse(c.createdAt) > cutoff,
      );
    } catch (err) {
      if (isAuthError(err)) throw err;
      newComments = [];
    }
  }
  return {
    ...local,
    changed,
    newComments: newComments.map(scrubFields),
    currentModifiedAt: current.modifiedAt,
    ticketsUnavailable: false,
  };
}
