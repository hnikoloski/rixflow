import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isInsideDir } from './config';
import { listMd, personDir, readDoc, writeDoc } from './hubfs';
import { isoDate } from './ids';
import { rebuildIndex } from './indexes';
import { assertName, assertTicketId, type Ctx } from './types';

export type Phase = 'research' | 'plan' | 'implement' | 'debug' | 'done';
export type Trigger = 'checkpoint' | 'wrapup' | 'precompact' | 'session-end';

export interface SessionSummary {
  task?: string;
  site?: string;
  sessionId: string;
  phase: Phase;
  trigger: Trigger;
  goal: string;
  done: string;
  decisions: string;
  deadEnds: string;
  next: string;
}

export interface Checkpoint {
  task: string;
  site?: string;
  branch?: string;
  stashRef?: string;
  done: string;
  pending: string;
  blockers: string;
  resume: string;
  asanaModifiedAt?: string;
  pausedAt?: string;
  handedTo?: string; // the teammate this paused work was handed over to
}

export interface Handover {
  task: string;
  site?: string;
  projectDir?: string;
  asanaModifiedAt: string;
  brief: string;
  requestContext?: string;
  related: string[];
  previousCheckpoint?: string;
  created?: string;
  ended?: string;
  outcome?: 'finished' | 'dropped';
  restricted?: boolean;
}

const SECTION_TITLES = new Set([
  'Goal', 'Done', 'Decisions', 'Dead ends', 'Open / next', 'Pending', 'Blockers', 'How to resume',
  'Brief', 'Request context', 'Related notes', 'Previous checkpoint',
]);

// Splits only on the section titles this module writes, so content that
// contains other `## ` headings survives a round trip.
function sections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null) out[current] = buf.join('\n').trim();
  };
  for (const line of body.split('\n')) {
    const m = /^## (.+)$/.exec(line);
    if (m && SECTION_TITLES.has(m[1].trim())) {
      flush();
      current = m[1].trim();
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// Reads every note in a folder, skipping files that fail to parse.
function readAll<T>(files: string[], parse: (path: string) => T): T[] {
  const out: T[] = [];
  for (const f of files) {
    try {
      out.push(parse(f));
    } catch {
      // corrupt note: skip
    }
  }
  return out;
}

function siteLink(site?: string): string {
  const first = site?.split(',')[0]?.trim().toLowerCase();
  return first ? `[[shared/sites/${first}/_index]]` : '';
}

function reindex(ctx: Ctx): void {
  rebuildIndex(ctx.hubDir, `people/${ctx.user.name}`, ctx.user.name);
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

export function writeSession(ctx: Ctx, s: SessionSummary): string {
  if (s.task) assertTicketId(s.task);
  const dir = join(personDir(ctx), 'sessions');
  const date = isoDate(ctx.now());
  const base = `${date}-${s.task ?? 'misc'}`;
  const related = [s.task ? `[[people/${ctx.user.name}/handovers/${s.task}]]` : '', siteLink(s.site)].filter(Boolean).join(' · ');
  const body = [
    '## Goal', s.goal, '', '## Done', s.done, '', '## Decisions', s.decisions, '',
    '## Dead ends', s.deadEnds, '', '## Open / next', s.next, '', related ? `Related: ${related}` : '',
  ].join('\n');
  const data = {
    type: 'session', task: s.task, site: s.site, session_id: s.sessionId, phase: s.phase,
    trigger: s.trigger, date, author: ctx.user.name,
  };
  // Exclusive create: a concurrent writer can never overwrite an existing summary.
  for (let n = 1; ; n++) {
    const path = join(dir, `${base}-${n}.md`);
    try {
      writeDoc(path, data, body, { exclusive: true });
      reindex(ctx);
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

export function hasSessionSummary(ctx: Ctx, sessionId: string): boolean {
  return readAll(listMd(join(personDir(ctx), 'sessions')), (f) => readDoc(f).data.session_id).includes(sessionId);
}

function checkpointPath(ctx: Ctx, task: string): string {
  assertTicketId(task);
  return join(personDir(ctx), 'checkpoints', `${task}.md`);
}

export function writeCheckpoint(ctx: Ctx, cp: Checkpoint): string {
  const path = checkpointPath(ctx, cp.task);
  if (cp.handedTo !== undefined) assertName(cp.handedTo);
  const body = [
    `# Checkpoint ${cp.task}`, siteLink(cp.site), '', '## Done', cp.done, '', '## Pending', cp.pending, '',
    '## Blockers', cp.blockers, '', '## How to resume', cp.resume,
  ].join('\n');
  writeDoc(path, {
    type: 'checkpoint', task: cp.task, site: cp.site, branch: cp.branch, stash_ref: cp.stashRef,
    paused_at: ctx.now().toISOString(), asana_modified_at: cp.asanaModifiedAt, handed_to: cp.handedTo,
    author: ctx.user.name,
  }, body);
  reindex(ctx);
  return path;
}

function toCheckpoint(path: string): Checkpoint {
  const { data, body } = readDoc(path);
  const s = sections(body);
  return {
    task: String(data.task), site: str(data.site), branch: str(data.branch), stashRef: str(data.stash_ref),
    done: s['Done'] ?? '', pending: s['Pending'] ?? '', blockers: s['Blockers'] ?? '', resume: s['How to resume'] ?? '',
    asanaModifiedAt: str(data.asana_modified_at), pausedAt: str(data.paused_at),
    handedTo: validName(data.handed_to),
  };
}

// A hand-edited `handed_to` that is not a valid person name is ignored.
function validName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    assertName(v);
    return v;
  } catch {
    return undefined;
  }
}

export function readCheckpoint(ctx: Ctx, task: string): Checkpoint | null {
  const path = checkpointPath(ctx, task);
  return existsSync(path) ? toCheckpoint(path) : null;
}

export interface TeammateWork {
  from: string;
  checkpoint: Checkpoint;
  handover: Handover | null;
}

// A teammate's paused work on a task, for picking it up: the newest checkpoint for the task in
// anyone else's people/ folder (only `from`'s when given), with that person's handover. Read only. Teammates control those
// files, so a file (or symlink) whose real path leaves the hub is skipped, as in search.
export function findTeammateWork(ctx: Ctx, task: string, from?: string): TeammateWork | null {
  assertTicketId(task);
  if (from !== undefined) assertName(from);
  const peopleDir = join(ctx.hubDir, 'people');
  if (!existsSync(peopleDir)) return null;
  const hubReal = realpathSync(ctx.hubDir);
  const real = (path: string): string | null => {
    try {
      const r = realpathSync(path);
      return r.startsWith(hubReal + sep) ? r : null;
    } catch {
      return null;
    }
  };
  let best: TeammateWork | null = null;
  for (const name of readdirSync(peopleDir).sort()) {
    if (name === ctx.user.name || (from !== undefined && name !== from)) continue;
    try { assertName(name); } catch { continue; }
    const dir = personDir(ctx, name);
    const cp = real(join(dir, 'checkpoints', `${task}.md`));
    if (!cp) continue;
    let checkpoint: Checkpoint;
    try { checkpoint = toCheckpoint(cp); } catch { continue; }
    if (best && (checkpoint.pausedAt ?? '') <= (best.checkpoint.pausedAt ?? '')) continue;
    const ho = real(join(dir, 'handovers', `${task}.md`));
    let handover: Handover | null = null;
    try { handover = ho ? toHandover(ho) : null; } catch { handover = null; }
    best = { from: name, checkpoint, handover };
  }
  return best;
}

// Every teammate's notes on a task, yours included: handovers, checkpoints and session summaries,
// as hub-relative paths, oldest person first. Links that leave the hub are skipped.
export function notesForTask(ctx: Ctx, task: string): string[] {
  assertTicketId(task);
  const peopleDir = join(ctx.hubDir, 'people');
  if (!existsSync(peopleDir)) return [];
  const hubReal = realpathSync(ctx.hubDir);
  const inside = (path: string): boolean => {
    try {
      return realpathSync(path).startsWith(hubReal + sep);
    } catch {
      return false;
    }
  };
  const out: string[] = [];
  for (const name of readdirSync(peopleDir).sort()) {
    try { assertName(name); } catch { continue; }
    const dir = personDir(ctx, name);
    for (const kind of ['handovers', 'checkpoints']) {
      if (inside(join(dir, kind, `${task}.md`))) out.push(`people/${name}/${kind}/${task}.md`);
    }
    for (const file of listMd(join(dir, 'sessions')).sort()) {
      if (!inside(file)) continue;
      try {
        if (String(readDoc(file).data.task ?? '') === task) out.push(`people/${name}/sessions/${file.slice(file.lastIndexOf(sep) + 1)}`);
      } catch {
        // An unreadable summary is skipped.
      }
    }
  }
  return out;
}

// True once the teammate a checkpoint was handed to has started the task (their handover for it
// is newer than the checkpoint), so the sender's plate can stop listing it as paused.
export function handoverPickedUp(ctx: Ctx, cp: Checkpoint): boolean {
  if (!cp.handedTo) return false;
  try {
    assertTicketId(cp.task);
    const path = realpathSync(join(personDir(ctx, cp.handedTo), 'handovers', `${cp.task}.md`));
    if (!isInsideDir(path, realpathSync(ctx.hubDir))) return false;
    const created = Date.parse(String(readDoc(path).data.created ?? ''));
    const paused = Date.parse(cp.pausedAt ?? '');
    return !Number.isNaN(created) && (Number.isNaN(paused) || created >= paused);
  } catch {
    return false;
  }
}

export function listCheckpoints(ctx: Ctx): Checkpoint[] {
  return readAll(listMd(join(personDir(ctx), 'checkpoints')), toCheckpoint);
}

export function clearCheckpoint(ctx: Ctx, task: string): boolean {
  const path = checkpointPath(ctx, task);
  if (!existsSync(path)) return false;
  rmSync(path);
  reindex(ctx);
  return true;
}

function handoverPath(ctx: Ctx, task: string): string {
  assertTicketId(task);
  return join(personDir(ctx), 'handovers', `${task}.md`);
}

export function writeHandover(ctx: Ctx, h: Handover): string {
  const path = handoverPath(ctx, h.task);
  const links = h.related.map((r) => `- [[${r.replace(/\.md$/, '')}]]`).join('\n') || '- none';
  const body = [
    `# Handover ${h.task}`, siteLink(h.site), '', '## Brief', h.brief, '', '## Request context', h.requestContext ?? '- none', '',
    '## Related notes', links, '', '## Previous checkpoint',
    h.previousCheckpoint ? `[[${h.previousCheckpoint.replace(/\.md$/, '')}]]` : '- none',
  ].join('\n');
  writeDoc(path, {
    type: 'handover', task: h.task, site: h.site, project_dir: h.projectDir, asana_modified_at: h.asanaModifiedAt,
    created: ctx.now().toISOString(), related: h.related, previous_checkpoint: h.previousCheckpoint, author: ctx.user.name,
    restricted: h.restricted ? true : undefined,
  }, body);
  reindex(ctx);
  return path;
}

function toHandover(path: string): Handover {
  const { data, body } = readDoc(path);
  const s = sections(body);
  const request = s['Request context'];
  return {
    task: String(data.task), site: str(data.site), projectDir: str(data.project_dir),
    asanaModifiedAt: String(data.asana_modified_at ?? ''), brief: s['Brief'] ?? '',
    requestContext: request && request !== '- none' ? request : undefined,
    related: Array.isArray(data.related) ? data.related.map(String) : [],
    previousCheckpoint: str(data.previous_checkpoint), created: str(data.created),
    ended: str(data.ended), outcome: data.outcome === 'finished' || data.outcome === 'dropped' ? data.outcome : undefined,
    restricted: data.restricted === true ? true : undefined,
  };
}

export function readHandover(ctx: Ctx, task: string): Handover | null {
  const path = handoverPath(ctx, task);
  return existsSync(path) ? toHandover(path) : null;
}

// Marks a handover ended (finished or dropped) so it no longer counts as the folder's current
// task. Everything else, including `created`, stays; resume still reads it as history.
export function endHandover(ctx: Ctx, task: string, outcome: 'finished' | 'dropped'): boolean {
  const path = handoverPath(ctx, task);
  if (!existsSync(path)) return false;
  const { data, body } = readDoc(path);
  writeDoc(path, { ...data, ended: ctx.now().toISOString(), outcome }, body);
  reindex(ctx);
  return true;
}

// Tasks whose own handover is restricted (ended or not).
export function restrictedHandoverTasks(ctx: Ctx): string[] {
  const dir = join(personDir(ctx), 'handovers');
  if (!existsSync(dir)) return [];
  return readAll(readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_index.md').map((f) => join(dir, f)), toHandover)
    .filter((h) => h.restricted).map((h) => h.task);
}

export function findActiveHandover(ctx: Ctx, cwd: string): Handover | null {
  const dir = join(personDir(ctx), 'handovers');
  if (!existsSync(dir)) return null;
  const matches = readAll(
    readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_index.md').map((f) => join(dir, f)),
    toHandover,
  ).filter((h) => !h.ended && h.projectDir && isInsideDir(cwd, h.projectDir));
  matches.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return matches[0] ?? null;
}
