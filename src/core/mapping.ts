import { isSiteCode } from './sites';
import { isCurrentSprint } from './sprint';
import { fieldValue, type Ticket, type TrackerKind } from './tickets/types';
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

export const BUCKET_LABEL: Record<Bucket, string> = { todo: 'to do', in_progress: 'in progress', waiting: 'waiting', done: 'done' };

type ProjectFrom = Workflow['project']['from'];

function valuesFrom(t: Ticket, from: ProjectFrom, field: string | null): string[] {
  switch (from) {
    case 'custom-field': {
      const v = field ? fieldValue(t, field) : null;
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

// The raw values the workflow reads project codes from, before any lookup.
export function projectValues(t: Ticket, wf: Workflow): string[] {
  return valuesFrom(t, wf.project.from, wf.project.field);
}

// Every distinct value a project source has across the samples, in first-seen order.
export function distinctValues(samples: Ticket[], from: ProjectFrom, field: string | null): string[] {
  const out: string[] = [];
  for (const t of samples) {
    for (const v of valuesFrom(t, from, field)) if (v.trim() && !out.includes(v)) out.push(v);
  }
  return out;
}

// Wizard: the places a ticket could name its project, with example values from real tickets.
export function projectOptions(
  samples: Ticket[], kind: TrackerKind,
): Array<{ from: ProjectFrom; field: string | null; label: string; examples: string[] }> {
  const fields: string[] = [];
  for (const t of samples) for (const f of t.fields) if (f.value && !fields.includes(f.name)) fields.push(f.name);
  const candidates: Array<{ from: ProjectFrom; field: string | null; label: string }> = [
    ...fields.map((f) => ({ from: 'custom-field' as const, field: f, label: `Field "${f}"` })),
    ...(kind === 'jira'
      ? [
        { from: 'component' as const, field: null, label: 'Component' },
        { from: 'label' as const, field: null, label: 'Label' },
        { from: 'jira-project' as const, field: null, label: 'Jira project' },
      ]
      : [{ from: 'asana-project' as const, field: null, label: 'Asana project' }]),
  ];
  return candidates
    .map((c) => ({ ...c, examples: distinctValues(samples, c.from, c.field).slice(0, 3) }))
    .filter((c) => c.examples.length > 0);
}

const MAX_CODE = 4;

// Wizard: a project code from a value's word initials ('Acme site' -> 'AS'), unique against `taken`.
export function suggestCode(value: string, taken: Set<string>): string {
  const words = value.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  let base: string;
  if (words.length > 1) base = words.map((w) => w[0]).join('').slice(0, MAX_CODE);
  else if (words.length === 1) base = words[0].length <= MAX_CODE ? words[0] : words[0].slice(0, 2);
  else base = 'PR';
  if (base.length < 2) base = base.padEnd(2, 'X');
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const code = `${base.slice(0, Math.max(2, MAX_CODE - suffix.length))}${suffix}`;
    if (!taken.has(code)) return code;
  }
}

const GUESSES: Array<[Bucket, RegExp]> = [
  ['done', /\b(done|closed|resolved|complete)/],
  ['waiting', /\b(wait|block|hold|feedback)/],
  ['in_progress', /\b(progress|review|doing|qa|testing)/],
  ['todo', /\b(to do|todo|backlog|open|new|selected)/],
];

// Wizard: a pre-filled bucket for a status name, or null when nothing fits.
export function guessBucket(status: string): Bucket | null {
  const s = status.toLowerCase();
  return GUESSES.find(([, re]) => re.test(s))?.[0] ?? null;
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

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

// Wizard preview: how each sample ticket maps. Only the ticket's own fields are read (no parents).
export function previewRows(
  samples: Ticket[], wf: Workflow, now: Date,
): Array<{ id: string; title: string; project: string; bucket: string; sprint: boolean; urgent: boolean }> {
  return samples.map((t) => {
    const m = mapTicket([t], wf, now);
    return {
      id: t.id,
      title: oneLine(t.title),
      project: m.codes.length ? m.codes.join(', ') : 'no project',
      bucket: m.bucket ? BUCKET_LABEL[m.bucket] : 'not mapped',
      sprint: m.sprint !== null,
      urgent: m.urgent,
    };
  });
}
