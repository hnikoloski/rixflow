import { isSiteCode } from './sites';
import { isCurrentSprint } from './sprint';
import { fieldValue, type Ticket } from './tickets/types';
import type { Workflow } from './workflow';

export type Bucket = 'todo' | 'in_progress' | 'waiting' | 'done';

export interface Mapped {
  codes: string[];
  bucket: Bucket | null;
  urgent: boolean;
  sprint: string | null; // current sprint name
  codesAt?: number; // chain index the codes came from (0: the ticket itself)
}

const BUCKETS: Bucket[] = ['todo', 'in_progress', 'waiting', 'done'];
// Legacy only: the title heuristics of the original Asana plate.
const URGENT_TITLE = /hotfix|urgent|\bp0\b/i;

// The raw values the workflow reads project codes from, before any lookup.
export function projectValues(t: Ticket, wf: Workflow): string[] {
  const p = wf.project;
  switch (p.from) {
    case 'custom-field': {
      const v = p.field ? fieldValue(t, p.field) : null;
      return v ? [v] : [];
    }
    case 'component':
      return t.components;
    case 'label':
      return t.labels;
    case 'asana-project':
    case 'jira-project':
      return t.containers;
  }
}

function codesOf(t: Ticket, wf: Workflow): string[] {
  const raw = projectValues(t, wf);
  const values = wf.project.values;
  if (values === 'codes') return raw.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(isSiteCode);
  const lookup = new Map(Object.entries(values).map(([k, code]) => [k.trim().toLowerCase(), code]));
  const out: string[] = [];
  for (const v of raw) {
    const code = lookup.get(v.trim().toLowerCase());
    if (code && isSiteCode(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

function bucketOf(status: string | null, wf: Workflow): Bucket | null {
  if (!status) return null;
  const s = status.toLowerCase();
  for (const b of BUCKETS) {
    const names = wf.status[b].map((n) => n.toLowerCase());
    if (wf.legacy ? names.some((n) => s.includes(n)) : names.includes(s)) return b;
  }
  return null;
}

function sprintOf(chain: Ticket[], wf: Workflow, now: Date): string | null {
  const mode = wf.sprints;
  if (mode.mode === 'none') return null;
  if (mode.mode === 'asana-sections') {
    const sections = chain.flatMap((t) => t.sections);
    // Legacy keeps the original rule: only the first section in the chain is looked at.
    const candidates = wf.legacy ? sections.slice(0, 1) : sections;
    return candidates.find((name) => isCurrentSprint(name, now)) ?? null;
  }
  for (const t of chain) {
    const s = t.sprints.find((x) => x.active && (mode.board === null || x.boardId === mode.board));
    if (s) return s.name;
  }
  return null;
}

// Whether the plate must fetch parents to map this ticket: its own fields lack a project value,
// or (Asana sections) it sits in no section at all.
export function needsParents(t: Ticket, wf: Workflow): boolean {
  return projectValues(t, wf).length === 0 || (wf.sprints.mode === 'asana-sections' && t.sections.length === 0);
}

export function mapTicket(chain: Ticket[], wf: Workflow, now: Date): Mapped {
  const own = chain[0];
  let codes: string[] = [];
  let codesAt: number | undefined;
  for (let i = 0; i < chain.length; i++) {
    const c = codesOf(chain[i], wf);
    if (c.length) {
      codes = c;
      codesAt = i;
      break;
    }
  }
  const priority = chain.find((t) => t.priority)?.priority ?? null;
  const urgentValues = wf.urgent.values.map((v) => v.toLowerCase());
  const urgent = (!!priority && urgentValues.includes(priority.toLowerCase())) || (wf.legacy && !!own && URGENT_TITLE.test(own.title));
  const mapped: Mapped = { codes, bucket: own ? bucketOf(own.status, wf) : null, urgent, sprint: sprintOf(chain, wf, now) };
  if (codesAt !== undefined) mapped.codesAt = codesAt;
  return mapped;
}
