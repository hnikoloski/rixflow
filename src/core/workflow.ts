import { existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { writeGuarded } from './hubfs';
import { scrub } from './scrub';
import { isMapping, readYaml } from './team';
import { HubError, assertSiteCode } from './types';
import { RIXFLOW_VERSION } from './version';

export interface Workflow {
  requires: string | null;
  legacy: boolean; // true only for LEGACY_WORKFLOW
  tracker:
    | { type: 'asana'; workspace: string | null }
    | { type: 'jira'; url: string; flavor: 'cloud' | 'server'; projects: string[] };
  project: {
    from: 'custom-field' | 'asana-project' | 'component' | 'label' | 'jira-project';
    field: string | null;
    values: Record<string, string> | 'codes'; // 'codes': the value already is a comma-separated code list
  };
  status: { field: string | null; todo: string[]; in_progress: string[]; waiting: string[]; done: string[] };
  sprints: { mode: 'none' } | { mode: 'asana-sections' } | { mode: 'jira-sprints'; board: number | null };
  urgent: { field: string | null; values: string[] };
}

const LEGACY: Workflow = {
  requires: null,
  legacy: true,
  tracker: { type: 'asana', workspace: null },
  project: { from: 'custom-field', field: 'Website', values: 'codes' },
  status: { field: 'Status', todo: [], in_progress: ['in progress'], waiting: [], done: [] },
  sprints: { mode: 'asana-sections' },
  urgent: { field: 'Priority', values: ['urgent', 'critical', 'p0', 'highest'] },
};

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') Object.values(v).forEach(deepFreeze);
  return Object.freeze(v);
}

// Frozen so callers cannot mutate the shared default; loadWorkflow hands out fresh copies.
export const LEGACY_WORKFLOW: Workflow = deepFreeze(structuredClone(LEGACY));

const FILE = 'config/workflow.yml';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const FROMS = ['custom-field', 'asana-project', 'component', 'label', 'jira-project'] as const;
const BUCKETS = ['todo', 'in_progress', 'waiting', 'done'] as const;

// A workflow.yml whose `requires` is newer than this RixFlow: its ticket features are skipped.
export class WorkflowTooNew extends HubError {
  constructor(readonly requires: string) {
    super('WORKFLOW_TOO_NEW', `This team's setup needs RixFlow ${requires} or newer. Update RixFlow: /plugin update rixflow-ui@rixflow`);
  }
}

function fail(reason: string): never {
  throw new HubError('BAD_CONFIG', `${FILE}: ${reason}`);
}

export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new HubError('BAD_CONFIG', `invalid version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function optString(v: unknown, what: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') fail(`${what} must be a string`);
  const s = String(v).trim();
  return s === '' ? null : s;
}

function stringList(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' || typeof x === 'number')) {
    fail(`${what} must be a list of strings`);
  }
  return v.map((x) => String(x));
}

function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = raw[key];
  if (v === undefined || v === null) return {};
  if (!isMapping(v)) fail(`${key} must be a mapping`);
  return v;
}

function parseTracker(raw: Record<string, unknown>): Workflow['tracker'] {
  const t = section(raw, 'tracker');
  if (t.type === 'asana') return { type: 'asana', workspace: optString(t.workspace, 'tracker.workspace') };
  if (t.type === 'jira') {
    const rawUrl = optString(t.url, 'tracker.url');
    if (!rawUrl) fail('jira tracker needs a url');
    if (t.flavor !== 'cloud' && t.flavor !== 'server') fail('jira tracker needs flavor: cloud or server');
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      fail(`jira url is not a valid URL: ${rawUrl}`);
    }
    if (u.protocol !== 'https:') fail('jira url must use https');
    const url = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    return { type: 'jira', url, flavor: t.flavor, projects: stringList(t.projects, 'tracker.projects') };
  }
  return fail(`unknown tracker type: ${String(t.type)}`);
}

function parseProject(raw: Record<string, unknown>): Workflow['project'] {
  const p = section(raw, 'project');
  const from = p.from;
  if (!FROMS.includes(from as (typeof FROMS)[number])) fail(`unknown project source: ${String(from)}`);
  const field = optString(p.field, 'project.field');
  if (from === 'custom-field' && !field) fail('project source custom-field needs a field');
  let values: Record<string, string> | 'codes';
  if (p.values === undefined || p.values === null || p.values === 'codes') {
    values = 'codes';
  } else if (isMapping(p.values)) {
    values = {};
    for (const [k, code] of Object.entries(p.values)) {
      try {
        assertSiteCode(code);
      } catch {
        fail(`invalid project code for "${k}": ${String(code)}`);
      }
      values[k] = code as string;
    }
  } else {
    fail("project.values must be a mapping or 'codes'");
  }
  return { from: from as Workflow['project']['from'], field, values };
}

function parseStatus(raw: Record<string, unknown>): Workflow['status'] {
  const s = section(raw, 'status');
  const out = { field: optString(s.field, 'status.field'), todo: [], in_progress: [], waiting: [], done: [] } as Workflow['status'];
  const seen = new Map<string, string>();
  for (const b of BUCKETS) {
    out[b] = stringList(s[b], `status.${b}`);
    for (const name of out[b]) {
      const key = name.toLowerCase();
      const prev = seen.get(key);
      if (prev !== undefined) fail(`status "${name}" is listed in both ${prev} and ${b}`);
      seen.set(key, b);
    }
  }
  return out;
}

function parseSprints(raw: Record<string, unknown>): Workflow['sprints'] {
  const s = section(raw, 'sprints');
  const mode = s.mode === undefined || s.mode === null ? 'none' : s.mode;
  if (mode === 'none') return { mode: 'none' };
  if (mode === 'asana-sections') return { mode: 'asana-sections' };
  if (mode === 'jira-sprints') {
    if (s.board === undefined || s.board === null) return { mode: 'jira-sprints', board: null };
    if (typeof s.board !== 'number' || !Number.isInteger(s.board) || s.board < 0) fail('sprints.board must be a whole number');
    return { mode: 'jira-sprints', board: s.board };
  }
  return fail(`unknown sprints mode: ${String(mode)}`);
}

export function loadWorkflow(hubDir: string, version: string = RIXFLOW_VERSION): Workflow {
  const path = join(hubDir, FILE);
  if (!existsSync(path)) return structuredClone(LEGACY);
  const raw = readYaml(path, FILE);
  let requires: string | null = null;
  if (raw.requires !== undefined && raw.requires !== null && raw.requires !== '') {
    if (typeof raw.requires !== 'string' || !SEMVER.test(raw.requires)) fail('requires must be a version like 0.3.0');
    requires = raw.requires;
    if (compareVersions(requires, version) > 0) throw new WorkflowTooNew(requires);
  }
  const urgent = section(raw, 'urgent');
  return {
    requires,
    legacy: false,
    tracker: parseTracker(raw),
    project: parseProject(raw),
    status: parseStatus(raw),
    sprints: parseSprints(raw),
    urgent: { field: optString(urgent.field, 'urgent.field'), values: stringList(urgent.values, 'urgent.values') },
  };
}

export function workflowToYaml(wf: Workflow): string {
  const { legacy: _legacy, requires, ...rest } = wf;
  return YAML.stringify(requires === null ? rest : { requires, ...rest });
}

export function writeWorkflow(hubDir: string, wf: Workflow): void {
  writeGuarded(join(hubDir, FILE), scrub(workflowToYaml(wf)));
}
