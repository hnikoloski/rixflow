import { normalizeDir, isInsideDir } from './config';
import { parentChain, type AsanaComment, type AsanaReader, type AsanaTask } from './asana';
import { buildBrief, oneLine } from './brief';
import { listInbox } from './messages';
import { readCheckpoint, readHandover, writeHandover, type Checkpoint, type Handover } from './notes';
import { scrub } from './scrub';
import { search } from './search';
import { resolveSite } from './sites';
import { loadSites } from './team';
import { HubError, assertTicketId, type Ctx } from './types';

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
  newComments: AsanaComment[];
  currentModifiedAt: string | null;
  // True when Asana could not be checked (not configured, unreachable, any non-auth error):
  // `changed: false` then means "unknown", not "unchanged". `reason` says why (scrubbed).
  asanaUnavailable: boolean;
  reason?: string;
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
  return err instanceof HubError && err.code === 'ASANA_AUTH';
}

export async function startTask(ctx: Ctx, asana: AsanaReader, input: { task: string; cwd: string }): Promise<StartResult> {
  assertTicketId(input.task);
  const task = await asana.getTask(input.task);
  const chain = await parentChain(asana, task);
  const site = resolveSite(chain, loadSites(ctx.hubDir), ctx.user);
  const comments = await asana.getComments(input.task, 10);
  const related = search(ctx.hubDir, { text: keywords(chain.map((t) => t.name).join(' ')), site: site.codes[0], limit: 5 }).map((h) => h.path);
  const checkpoint = readCheckpoint(ctx, input.task);
  const requests = listInbox(ctx)
    .filter((m) => m.task === input.task)
    .map((m) => oneLine(`- ${m.type} from ${m.from} (${oneLine(scrub(m.created).slice(0, 10))}): ${m.body}`))
    .join('\n');
  const handoverPath = writeHandover(ctx, {
    task: input.task,
    site: site.codes.join(', ') || undefined,
    projectDir: site.folder ?? undefined,
    asanaModifiedAt: task.modified_at,
    brief: buildBrief(task, chain, comments),
    requestContext: requests || undefined,
    related,
    previousCheckpoint: checkpoint ? `people/${ctx.user.name}/checkpoints/${input.task}.md` : undefined,
  });
  const inFolder = !!site.folder && isInsideDir(normalizeDir(input.cwd), site.folder);
  return {
    task: input.task,
    title: scrub(oneLine(task.name)),
    handoverPath,
    siteCodes: site.codes,
    projectDir: site.folder,
    inFolder,
    launch: site.folder && !inFolder ? `${cdCommand(site.folder)} && claude "/rixflow:resume ${input.task}"` : null,
    needsSite: !site.folder,
  };
}

export async function resumeTask(ctx: Ctx, asana: AsanaReader | null, task: string): Promise<ResumeResult> {
  assertTicketId(task);
  const handover = readHandover(ctx, task);
  const checkpoint = readCheckpoint(ctx, task);
  const local = {
    handover: handover && scrubFields(handover),
    checkpoint: checkpoint && scrubFields(checkpoint),
  };
  const unavailable = (reason: string): ResumeResult => ({
    ...local, changed: false, newComments: [], currentModifiedAt: null, asanaUnavailable: true, reason: oneLine(scrub(reason)).slice(0, 200),
  });
  if (!asana) return unavailable('Asana is not configured');
  let current: AsanaTask;
  try {
    current = await asana.getTask(task);
  } catch (err) {
    if (isAuthError(err)) throw err;
    // Asana unreachable: the local handover and checkpoint still answer the question.
    return unavailable(err instanceof HubError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err));
  }
  // The newest local record is the baseline: its Asana timestamp decides `changed`, and its time
  // is the cutoff for comments that count as new.
  const baseline = newestBaseline(handover, checkpoint);
  const since = baseline?.asanaModifiedAt ?? '';
  const changed = !!since && current.modified_at !== since;
  let newComments: AsanaComment[] = [];
  if (changed) {
    const cutoff = Date.parse(baseline?.at ?? '');
    try {
      newComments = (await asana.getComments(task, 20)).filter(
        (c) => Number.isNaN(cutoff) || Date.parse(c.created_at) > cutoff,
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
    currentModifiedAt: current.modified_at,
    asanaUnavailable: false,
  };
}
