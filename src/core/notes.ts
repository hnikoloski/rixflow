import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isInsideDir } from './config';
import { listMd, personDir, readDoc, writeDoc } from './hubfs';
import { isoDate } from './ids';
import { rebuildIndex } from './indexes';
import { assertTicketId, type Ctx } from './types';

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
  const body = [
    `# Checkpoint ${cp.task}`, siteLink(cp.site), '', '## Done', cp.done, '', '## Pending', cp.pending, '',
    '## Blockers', cp.blockers, '', '## How to resume', cp.resume,
  ].join('\n');
  writeDoc(path, {
    type: 'checkpoint', task: cp.task, site: cp.site, branch: cp.branch, stash_ref: cp.stashRef,
    paused_at: ctx.now().toISOString(), asana_modified_at: cp.asanaModifiedAt, author: ctx.user.name,
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
  };
}

export function readCheckpoint(ctx: Ctx, task: string): Checkpoint | null {
  const path = checkpointPath(ctx, task);
  return existsSync(path) ? toCheckpoint(path) : null;
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
  };
}

export function readHandover(ctx: Ctx, task: string): Handover | null {
  const path = handoverPath(ctx, task);
  return existsSync(path) ? toHandover(path) : null;
}

export function findActiveHandover(ctx: Ctx, cwd: string): Handover | null {
  const dir = join(personDir(ctx), 'handovers');
  if (!existsSync(dir)) return null;
  const matches = readAll(
    readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_index.md').map((f) => join(dir, f)),
    toHandover,
  ).filter((h) => h.projectDir && isInsideDir(cwd, h.projectDir));
  matches.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return matches[0] ?? null;
}
