import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { configDir as getConfigDir, homeDir, hubDir as getHubDir, saveUserConfig } from '../../core/config';
import { Git } from '../../core/git';
import { BUCKET_LABEL, distinctValues, guessBucket, previewRows, projectOptions, suggestCode, type Bucket } from '../../core/mapping';
import { checkReach, systemGh } from '../../core/repo';
import { findSecrets } from '../../core/scrub';
import { isCurrentSprint, parseSprintSection } from '../../core/sprint';
import type { TeamMember } from '../../core/team';
import { bootstrapHub, isSafeFolder } from '../../core/template';
import { jiraBaseUrl } from '../../core/tickets/jira';
import type { Discovery, Ticket, TicketSource } from '../../core/tickets/types';
import { HubError, assertName, type Role, type UserConfig } from '../../core/types';
import { RIXFLOW_VERSION } from '../../core/version';
import type { Workflow } from '../../core/workflow';
import { applyClaudeSettings, withAccessHint, type InitIo } from '../init';
import { connect, scopeLabel, storedSource, type Connection, type WizardDeps } from './connect';
import { inviteText } from './invite';
import { askProjectsRoot, refusePublicHub, setUpHubHooks, withoutLogin } from './join';
import { runSteps, type Step } from './progress';
import { askValid, choose, chooseMany, confirm } from './prompts';

type Answers = Record<string, unknown>;
type Source = TicketSource & Discovery;
type Pairs = Array<[string, string]>;

const SAMPLE_COUNT = 50;
const PREVIEW_COUNT = 5;
const BUCKETS: Bucket[] = ['todo', 'in_progress', 'waiting', 'done'];
const URGENT_GUESS = /highest|critical|urgent|blocker|p0/i;
const SITE = /^[A-Z0-9]{1,10}$/;
const MAPPING_STEPS = ['project-source', 'project-values', 'statuses', 'sprints', 'urgent'] as const;

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
const pairs = (v: unknown): Pairs => (Array.isArray(v) ? (v as Pairs) : []);
const scope = (a: Answers) => (a.projects as string[] | undefined) ?? [];
const isJira = (a: Answers) => (a.tracker as { type?: string } | undefined)?.type === 'jira';

function trackerOf(a: Answers): Workflow['tracker'] {
  const t = a.tracker as { type: 'asana' } | { type: 'jira'; url: string; flavor: 'cloud' | 'server' };
  if (t.type === 'jira') return { type: 'jira', url: t.url, flavor: t.flavor, projects: (a.projects as string[] | undefined) ?? [] };
  return { type: 'asana', workspace: (a.workspace as string | undefined) ?? null };
}

// The team's workflow as answered so far. Asana reads status and priority from the usual custom fields.
export function workflowOf(a: Answers): Workflow {
  const jira = isJira(a);
  const status: Workflow['status'] = { field: jira ? null : 'Status', todo: [], in_progress: [], waiting: [], done: [] };
  for (const [name, bucket] of pairs(a.statusBuckets)) status[bucket as Bucket].push(name);
  return {
    requires: RIXFLOW_VERSION,
    legacy: false,
    tracker: trackerOf(a),
    project: {
      from: (a.projectFrom as Workflow['project']['from'] | undefined) ?? (jira ? 'jira-project' : 'asana-project'),
      field: (a.projectField as string | null | undefined) ?? null,
      values: Object.fromEntries(pairs(a.projectValues)),
    },
    status,
    sprints: (a.sprints as Workflow['sprints'] | undefined) ?? { mode: 'none' },
    urgent: { field: jira ? null : 'Priority', values: (a.urgentValues as string[] | undefined) ?? [] },
  };
}

function validMember(line: string, taken: TeamMember[]): string | null {
  if (line === '') return null;
  const m = /^([^:\s]+)\s*:\s*(\S+)$/.exec(line);
  if (!m) return 'Please write name:role, for example sam:dev (or leave the line blank when done).';
  try {
    assertName(m[1]);
  } catch {
    return `"${clean(m[1])}" is not a valid name: use lower-case letters, digits and dashes, starting with a letter or digit.`;
  }
  if (m[2] !== 'dev' && m[2] !== 'pm') return 'The role must be dev or pm.';
  if (taken.some((t) => t.name === m[1])) return `${m[1]} is already on the list.`;
  return null;
}

export const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[^a-z0-9]+|[-.]+$/g, '');

function previewTable(rows: ReturnType<typeof previewRows>): string {
  const cells = [
    ['Ticket', 'Title', 'Project', 'Status', 'Sprint', 'Urgent'],
    ...rows.map((r) => [r.id, r.title.length > 40 ? `${r.title.slice(0, 39)}…` : r.title, r.project, r.bucket, r.sprint ? 'yes' : 'no', r.urgent ? 'yes' : 'no']),
  ];
  const widths = cells[0].map((_, i) => Math.max(...cells.map((c) => c[i].length)));
  return cells.map((c) => `  ${c.map((x, i) => x.padEnd(widths[i])).join('  ').trimEnd()}`).join('\n');
}

// Create's steps 3-7 (how a ticket names its project, project codes, statuses, sprints, urgent,
// preview with "go back"). Each step starts from the answers already given, so the wizard menu
// reuses them to redo the mapping from the hub's current workflow.
// Earlier answers the current sample does not show (a redo of the mapping, or a resumed wizard).
// Each is kept unless the person types - for it, so a redo never silently drops part of the mapping.
// On a fresh create the list is empty and nothing is asked.
async function keptFromBefore<T>(io: InitIo, items: T[], describe: (t: T) => string): Promise<T[]> {
  if (items.length === 0) return [];
  io.log('Kept from before (not in the tickets RixFlow looked at now). Press Enter to keep each one, or type - to remove it.');
  const out: T[] = [];
  for (const item of items) {
    const a = await askValid(io, `  ${describe(item)}:`, (s) => (s === '' || s === '-' ? null : 'Press Enter to keep it, or type - to remove it.'));
    if (a !== '-') out.push(item);
  }
  return out;
}

export interface MappingHelpers {
  source: (a: Answers) => Promise<Source>;
  samples: (a: Answers) => Promise<Ticket[]>;
  now: () => Date;
}

export function mappingSteps(io: InitIo, h: MappingHelpers): Step[] {
  return [
    {
      id: 'project-source',
      async run(a) {
        const options = projectOptions(await h.samples(a), isJira(a) ? 'jira' : 'asana');
        if (options.length === 0) {
          throw new HubError('NO_PROJECT_VALUES',
            'None of the tickets RixFlow looked at names a project (in a field, component, label or project). Add one to your tickets, then run setup again.');
        }
        const current = options.findIndex((o) => o.from === a.projectFrom && o.field === (a.projectField ?? null));
        const i = await choose(io, 'How does a ticket say which project it belongs to?',
          options.map((o, n) => ({ value: String(n), label: `${o.label} (e.g. ${o.examples.map(clean).join(', ')})` })),
          current >= 0 ? String(current) : undefined);
        const picked = options[Number(i)];
        // Codes given for another source's values do not carry over to this one.
        const changed = a.projectFrom !== undefined && (picked.from !== a.projectFrom || picked.field !== (a.projectField ?? null));
        return { projectFrom: picked.from, projectField: picked.field, ...(changed ? { projectValues: [] } : {}) };
      },
    },
    {
      id: 'project-values',
      async run(a) {
        const values = distinctValues(await h.samples(a), a.projectFrom as Workflow['project']['from'], (a.projectField as string | null) ?? null);
        const before = new Map(pairs(a.projectValues));
        io.log('Each project gets a short code (capital letters and digits, e.g. AC). Press Enter to keep the suggestion, or type - to leave a value out.');
        const taken = new Set<string>();
        const out: Pairs = [];
        for (const v of values) {
          const suggestion = before.get(v) ?? suggestCode(v, taken);
          const code = (await askValid(io, `Project code for "${clean(v)}":`,
            (s) => (s === '-' || SITE.test(s.toUpperCase()) ? null : 'Please use 1 to 10 capital letters or digits (or - to leave it out).'),
            suggestion)).toUpperCase();
          if (code === '-') continue;
          taken.add(code);
          out.push([v, code]);
        }
        const shown = new Set(values);
        for (const [v, code] of await keptFromBefore(io, pairs(a.projectValues).filter(([v]) => !shown.has(v)),
          ([v, code]) => `"${clean(v)}" -> ${code}`)) out.push([v, code]);
        if (out.length === 0) io.log('No value has a code, so every ticket will show as "no project" until the mapping is redone.');
        return { projectValues: out };
      },
    },
    {
      id: 'statuses',
      async run(a) {
        const src = await h.source(a);
        const seen = new Set<string>();
        const names: string[] = [];
        for (const s of [...(await src.statuses(scope(a))), ...(await h.samples(a)).map((t) => t.status)]) {
          if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); names.push(s); }
        }
        const earlier = pairs(a.statusBuckets).filter(([n]) => !seen.has(n.toLowerCase()));
        if (names.length === 0 && earlier.length === 0) {
          io.log(isJira(a)
            ? 'RixFlow found no statuses in these projects, so tickets will show without a status.'
            : 'No ticket has a "Status" field value, so tickets will show without a status.');
          return { statusBuckets: [] };
        }
        const before = new Map(pairs(a.statusBuckets).map(([n, b]) => [n.toLowerCase(), b]));
        const out: Pairs = [];
        if (names.length) io.log('Place each status in one of RixFlow\'s buckets. Press Enter to keep the suggestion.');
        for (const s of names) {
          const fallback = (before.get(s.toLowerCase()) as Bucket | undefined) ?? guessBucket(s) ?? undefined;
          out.push([s, await choose(io, `Status "${clean(s)}" means:`, BUCKETS.map((b) => ({ value: b, label: BUCKET_LABEL[b] })), fallback)]);
        }
        out.push(...await keptFromBefore(io, earlier, ([n, b]) => `status "${clean(n)}" -> ${BUCKET_LABEL[b as Bucket] ?? b}`));
        return { statusBuckets: out };
      },
    },
    {
      id: 'sprints',
      async run(a) {
        const src = await h.source(a);
        if (isJira(a)) {
          const boards = await src.boards(scope(a));
          if (boards.length === 0) {
            io.log('No Jira board was found for these projects, so sprints are off.');
            return { sprints: { mode: 'none' } };
          }
          const prev = a.sprints as Workflow['sprints'] | undefined;
          const pick = await choose(io, 'Does the team work in sprints?', [
            { value: 'none', label: 'No sprints' },
            ...boards.map((b) => ({ value: String(b.id), label: `Sprints of board "${clean(b.name)}" (board ${b.id})` })),
          ], prev ? (prev.mode === 'jira-sprints' ? String(prev.board) : 'none') : undefined);
          return { sprints: pick === 'none' ? { mode: 'none' } : { mode: 'jira-sprints', board: Number(pick) } };
        }
        const today = h.now();
        const sections = [...new Set((await h.samples(a)).flatMap((t) => t.sections))];
        const sprintish = sections.filter((n) => parseSprintSection(n, today.getUTCFullYear()) !== null);
        if (sprintish.length === 0) {
          io.log('No section name looks like a sprint (RixFlow reads names like "Sprint 41 | 5.10 - 9.10"), so sprints are off.');
          return { sprints: { mode: 'none' } };
        }
        const current = sprintish.find((n) => isCurrentSprint(n, today));
        io.log(`Sections that look like sprints: ${sprintish.map(clean).join(', ')}.\nCurrent sprint today: ${current ? clean(current) : 'none of them'}.`);
        const use = await confirm(io, 'Use these sections as sprints?', true);
        return { sprints: use ? { mode: 'asana-sections' } : { mode: 'none' } };
      },
    },
    {
      id: 'urgent',
      async run(a) {
        const src = await h.source(a);
        const prios = [...new Set([...(await src.priorities()), ...(await h.samples(a)).flatMap((t) => (t.priority ? [t.priority] : []))])];
        const known = new Set(prios.map((p) => p.toLowerCase()));
        const earlier = ((a.urgentValues as string[] | undefined) ?? []).filter((v) => !known.has(v.toLowerCase()));
        if (prios.length === 0 && earlier.length === 0) {
          io.log('No priority values were found, so no ticket will be marked urgent.');
          return { urgentValues: [] };
        }
        const prev = (a.urgentValues as string[] | undefined)?.map((v) => v.toLowerCase());
        const picks = prios.length === 0 ? [] : await chooseMany(io, 'Which priorities count as urgent?',
          prios.map((p) => ({ value: p, label: clean(p) })), prios.filter((p) => (prev ? prev.includes(p.toLowerCase()) : URGENT_GUESS.test(p))));
        picks.push(...await keptFromBefore(io, earlier, (v) => `urgent priority "${clean(v)}"`));
        return { urgentValues: picks };
      },
    },
    {
      id: 'preview',
      async run(a) {
        const rows = previewRows((await h.samples(a)).slice(0, PREVIEW_COUNT), workflowOf(a), h.now());
        io.log(`Some tickets as RixFlow will see them:\n${previewTable(rows)}`);
        const labels: Record<(typeof MAPPING_STEPS)[number], string> = {
          'project-source': 'Go back: how a ticket names its project',
          'project-values': 'Go back: project codes',
          statuses: 'Go back: statuses',
          sprints: 'Go back: sprints',
          urgent: 'Go back: urgent priorities',
        };
        const pick = await choose<string>(io, 'Is this right?', [
          { value: 'accept', label: 'Yes, keep this mapping' },
          ...MAPPING_STEPS.map((id) => ({ value: id, label: labels[id] })),
        ]);
        return pick === 'accept' ? {} : { goto: pick };
      },
    },
  ];
}

// The inverse of workflowOf: a workflow's answers, as the mapping steps' starting point.
export function mappingAnswers(wf: Workflow): Answers {
  const t = wf.tracker;
  const statusBuckets: Pairs = [];
  for (const b of BUCKETS) for (const name of wf.status[b]) statusBuckets.push([name, b]);
  return {
    ...(t.type === 'jira'
      ? { tracker: { type: 'jira', url: t.url, flavor: t.flavor }, projects: t.projects }
      : { tracker: { type: 'asana' }, workspace: t.workspace }),
    projectFrom: wf.project.from,
    projectField: wf.project.field,
    projectValues: wf.project.values === 'codes' ? [] : Object.entries(wf.project.values),
    statusBuckets,
    sprints: wf.sprints,
    urgentValues: wf.urgent.values,
  };
}

const REPO_HINT = 'For an ssh URL, load your key into ssh-agent (ssh-add); for an https URL, set up a git credential helper.';

// Create a team: connect the ticket system, map how its tickets name projects, statuses, sprints and
// urgency, preview real tickets, then bootstrap the hub (with workflow.yml), push it, finish this
// person's own setup and print an invite. Team answers go to the hub only; config.yml gets machine facts.
export async function runCreate(io: InitIo, deps: WizardDeps, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configDir = getConfigDir(env);
  const hubDir = getHubDir(env);
  const now = () => (deps.now ?? (() => new Date()))();
  let connection: Connection | undefined;
  let cached: Ticket[] | undefined;

  // Kept in memory only: an email never goes in the progress file.
  let jiraEmail: string | undefined;
  const isCloud = (a: Answers) => (a.tracker as { flavor?: string } | undefined)?.flavor === 'cloud';
  // The Jira address this person typed is the one this machine is pinned to.
  const pinnedUrl = (a: Answers): string | undefined => {
    const t = a.tracker as { type?: string; url?: string } | undefined;
    return t?.type === 'jira' ? jiraBaseUrl(t.url) ?? undefined : undefined;
  };
  // A resumed wizard has no email in memory; it is asked again (the token stays stored, never re-asked).
  const emailFor = async (a: Answers): Promise<string | undefined> => {
    if (!isCloud(a)) return undefined;
    jiraEmail ??= await askValid(io, 'Your Jira login email:',
      (s) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? null : 'Please enter the email address you log in to Jira with.'));
    return jiraEmail;
  };

  // config.yml marks this machine as set up, so it is written only once the hub exists (self-join).
  const saveMachine = (a: Answers, projectsRoot: string) => {
    const cfg: UserConfig = {
      name: String(a.name), role: a.role as Role, projectsRoot,
      ...(jiraEmail ? { jiraEmail } : {}),
      ...(pinnedUrl(a) ? { jiraUrl: pinnedUrl(a) } : {}),
      siteFolders: {}, taskSites: {},
    };
    saveUserConfig(configDir, cfg);
  };

  const doConnect = async (a: Answers): Promise<Connection> => {
    connection = await connect(io, deps, workflowOf(a), { name: String(a.name), configDir });
    jiraEmail = connection.jiraEmail;
    return connection;
  };

  const source = async (a: Answers): Promise<Source> => {
    if (connection) return connection.source as Source;
    const name = String(a.name);
    const stored = storedSource(deps, workflowOf(a), { name, configDir, jiraEmail: await emailFor(a), jiraUrl: pinnedUrl(a) }, env);
    if (stored) return stored as Source;
    io.log('Your ticket login was not found on this machine; please sign in again.');
    return (await doConnect(a)).source as Source;
  };

  const samples = async (a: Answers): Promise<Ticket[]> => {
    if (cached) return cached;
    const got = await (await source(a)).sample(scope(a), SAMPLE_COUNT);
    if (got.length === 0) {
      throw new HubError('NO_TICKETS',
        `RixFlow found no open tickets in ${scopeLabel(workflowOf(a))} to learn from. Check that your account can see tickets there, then run setup again (answer n to "Continue" to pick other projects).`);
    }
    cached = got;
    return got;
  };

  await runSteps(io, configDir, 'create', [
    {
      id: 'tracker',
      async run() {
        const name = await askValid(io, 'Your name on the team (lower-case letters, digits and dashes, e.g. alex):', (s) => {
          try { assertName(s); return null; } catch { return 'Please use lower-case letters, digits and dashes, starting with a letter or digit.'; }
        });
        const role = await choose<Role>(io, 'Your role:', [
          { value: 'dev', label: 'dev (works on tickets)' },
          { value: 'pm', label: 'pm (plans and hands out tickets)' },
        ]);
        const kind = await choose(io, 'Which ticket system does the team use?', [
          { value: 'asana', label: 'Asana' },
          { value: 'cloud', label: 'Jira Cloud (an address ending in .atlassian.net)' },
          { value: 'server', label: 'Jira on your own server (self-hosted)' },
        ]);
        if (kind === 'asana') return { name, role, tracker: { type: 'asana' } };
        const raw = await askValid(io, kind === 'cloud' ? 'Jira address (e.g. https://acme.atlassian.net):' : 'Jira address (e.g. https://jira.example.com):',
          (s) => (jiraBaseUrl(s) ? null : 'Please enter the https:// address you open Jira at, without anything after a ? or #.'));
        return { name, role, tracker: { type: 'jira', url: jiraBaseUrl(raw), flavor: kind } };
      },
    },
    {
      id: 'connect',
      async run(a) {
        const conn = await doConnect(a);
        if (!isJira(a)) return { workspace: conn.asanaWorkspace };
        const scopes = await (conn.source as Source).scopes();
        if (scopes.length === 0) {
          throw new HubError('NO_PROJECTS', 'Your Jira account cannot see any projects. Ask a Jira admin for access to the team\'s projects, then run setup again.');
        }
        const projects = await chooseMany(io, 'Which Jira projects does the team work in?',
          scopes.map((s) => ({ value: s.id, label: `${clean(s.name)} (${s.id})` })), [], 1);
        return { projects };
      },
    },
    ...mappingSteps(io, { source, samples, now }),
    {
      id: 'teammates',
      async run(a) {
        const members: TeamMember[] = [{ name: String(a.name), role: a.role as Role }];
        io.log('Add your teammates, one per line as name:role (role is dev or pm), e.g. sam:dev. Names use lower-case letters, digits and dashes. You are on the list already. Leave the line blank when done.');
        for (;;) {
          const line = await askValid(io, 'Teammate:', (s) => validMember(s, members));
          if (line === '') break;
          const [name, role] = line.split(':').map((x) => x.trim());
          members.push({ name, role: role as Role });
        }
        return { members };
      },
    },
    {
      id: 'folders',
      async run(a) {
        const first = new Map<string, string>();
        for (const [value, code] of pairs(a.projectValues)) if (!first.has(code)) first.set(code, value);
        if (first.size === 0) return { folders: [] };
        const before = new Map(pairs(a.folders));
        io.log("Each project has a folder inside each person's projects folder. Press Enter to keep the suggestion.");
        const out: Pairs = [];
        for (const [code, value] of first) {
          const fallback = before.get(code) ?? (slug(value) || code.toLowerCase());
          out.push([code, await askValid(io, `Folder for project ${code} (${clean(value)}):`,
            (s) => (isSafeFolder(s) ? null : 'Please use one folder name: letters, digits, dots, dashes or underscores, no slashes.'), fallback)]);
        }
        return { folders: out };
      },
    },
    {
      id: 'repo',
      async run(a) {
        const gh = deps.gh ?? systemGh();
        let url: string;
        if (await gh.available() && await confirm(io, 'GitHub CLI (gh) is signed in. Create a private GitHub repository for the hub?', true)) {
          const name = await askValid(io, 'Repository name (name, or owner/name):', (s) => (s ? null : 'Please enter a name.'), 'rixflow-hub');
          url = await gh.createPrivate(name);
          io.log(`Created the private repository ${name}.`);
        } else {
          url = await askValid(io, 'Git URL of an empty, private repository for the hub (e.g. git@github.com:acme/rixflow-hub.git):', (s) => {
            if (!s || s.startsWith('-')) return 'Please paste the git URL of an empty repository you created for the hub.';
            if (findSecrets(s).length > 0) return `Please leave the password or token out of the URL. ${REPO_HINT}`;
            return null;
          });
        }
        const shown = withoutLogin(url);
        await refusePublicHub(io, url, deps, env);
        const reach = await checkReach(url, deps.runGit);
        if (!reach.ok) {
          throw new HubError('REPO_UNREACHABLE',
            `Git could not reach ${shown} without asking for a password. Check the URL and that you have access. ${REPO_HINT} Then run setup again.`);
        }
        if (!reach.empty) {
          throw new HubError('REPO_NOT_EMPTY',
            `${shown} already has commits. The hub needs an empty repository: create a new private one (without a README), then run setup again.`);
        }
        if (existsSync(join(hubDir, '.git'))) {
          throw new HubError('ALREADY_EXISTS', `${hubDir} already holds a git repository. Move it away (or set RIXFLOW_DIR to another folder), then run setup again.`);
        }
        const members = a.members as TeamMember[];
        const sites = Object.fromEntries(pairs(a.folders).map(([code, folder]) => [code, { folder }]));
        const existed = existsSync(hubDir);
        try {
          await bootstrapHub(hubDir, members, sites, env, workflowOf(a));
          await new Git(hubDir, env).run(['remote', 'add', 'origin', url]);
          await withAccessHint(io, () => new Git(hubDir, env, { interactive: true }).run(['push', '-q', '-u', 'origin', 'main']));
        } catch (e) {
          // Nothing reached the remote: drop the half-made hub so running setup again starts this step clean.
          if (!existed) rmSync(hubDir, { recursive: true, force: true });
          throw e;
        }
        io.log(`Created the team hub and pushed it to ${shown}.`);
        return { hubUrl: url };
      },
    },
    {
      id: 'self-join',
      async run(a) {
        const projectsRoot = await askProjectsRoot(io, env);
        await emailFor(a);
        saveMachine(a, projectsRoot);
        await setUpHubHooks(io, deps, String(a.name), env);
        await applyClaudeSettings(io, join(homeDir(env), '.claude', 'settings.json'), hubDir);
        return {};
      },
    },
    {
      id: 'invite',
      async run(a) {
        io.log(`Send this to your teammates (RixFlow only prints it; nothing is sent):\n\n${inviteText(String(a.hubUrl), a.members as TeamMember[], String(a.name))}\n`);
        return {};
      },
    },
  ]);
  io.log(`Done. Hub: ${hubDir}. Config: ${configDir}.`);
}
