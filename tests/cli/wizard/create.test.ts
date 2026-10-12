import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { runCreate } from '../../../src/cli/wizard/create';
import { inviteText } from '../../../src/cli/wizard/invite';
import type { WizardDeps } from '../../../src/cli/wizard/connect';
import type { AsanaTask } from '../../../src/core/asana';
import { guessBucket, previewRows, projectOptions, suggestCode } from '../../../src/core/mapping';
import type { Gh, RunGit } from '../../../src/core/repo';
import { loadSites, loadTeam } from '../../../src/core/team';
import type { JiraAuth } from '../../../src/core/tickets/jira';
import type { Discovery, Ticket, TicketSource } from '../../../src/core/tickets/types';
import { RIXFLOW_VERSION } from '../../../src/core/version';
import { loadWorkflow, type Workflow } from '../../../src/core/workflow';
import { hubWithRemote } from '../../gitHub';
import { scriptedIo } from './io';

const noKeychain = () => { throw new Error('no keychain'); };
const NOW = new Date('2026-10-08T10:00:00Z');

const ticket = (over: Partial<Ticket>): Ticket => ({
  id: 'WEB-1', title: 'Fix the login page', notes: '', modifiedAt: '2026-10-01T00:00:00Z', due: null, url: null, parent: null,
  status: 'In Progress', priority: null, fields: [], components: [], labels: [], containers: ['WEB'], sections: [], sprints: [],
  restricted: false, ...over,
});

const SAMPLES: Ticket[] = [
  ticket({ components: ['Acme site'], priority: 'Highest', sprints: [{ name: 'Sprint 7', active: true, boardId: 12 }] }),
  ticket({ id: 'WEB-2', title: 'Update the footer', components: ['Globex web'], status: 'To Do', priority: 'Low' }),
  ticket({ id: 'OPS-7', title: 'Rotate certs', containers: ['OPS'], status: 'Waiting for feedback' }),
];

function fakeJira(samples: Ticket[] = SAMPLES) {
  const calls: Array<{ url: string; auth: JiraAuth; projects: string[] }> = [];
  const sampled: string[][] = [];
  const makeJira = (url: string, auth: JiraAuth, projects: string[]): TicketSource & Discovery => {
    calls.push({ url, auth, projects });
    return {
      kind: 'jira', label: 'Jira', normalizeId: (s) => s,
      whoAmI: async () => ({ id: 'acc-1', name: 'Me' }),
      myTickets: async () => samples,
      ticket: async (id) => ticket({ id }),
      comments: async () => [],
      scopes: async () => [{ id: 'WEB', name: 'Website' }, { id: 'OPS', name: 'Operations' }, { id: 'HR', name: 'People' }],
      sample: async (scope) => { sampled.push(scope); return samples; },
      statuses: async () => ['To Do', 'In Progress', 'Waiting for feedback', 'Done'],
      priorities: async () => ['Highest', 'High', 'Medium', 'Low'],
      boards: async () => [{ id: 12, name: 'Acme board' }],
    };
  };
  return { calls, sampled, makeJira };
}

// Real git for checkReach against local bare remotes (no network: local paths only).
const realGit: RunGit = (args, env, cwd) =>
  new Promise((resolve) => {
    execFile('git', args, { env, cwd, encoding: 'utf8' }, (err, stdout) => resolve({ ok: !err, stdout: err ? '' : stdout }));
  });
const noGh: Gh = { available: async () => false, createPrivate: async () => { throw new Error('unused'); } };

function machine(who = 'me') {
  const root = mkdtempSync(join(tmpdir(), 'create-'));
  const home = join(root, `home-${who}`);
  mkdirSync(home, { recursive: true });
  return {
    root, home, remote: join(root, 'remote.git'),
    cfg: join(home, 'cfg'),
    hub: join(home, 'hub'),
    env: { ...process.env, HOME: home, RIXFLOW_DIR: join(home, 'hub'), RIXFLOW_CONFIG_DIR: join(home, 'cfg') } as NodeJS.ProcessEnv,
  };
}

async function emptyRemote(path: string) {
  await new Promise<void>((res, rej) => execFile('git', ['init', '-q', '--bare', '-b', 'main', path], (e) => (e ? rej(e) : res())));
}

const deps = (over: Partial<WizardDeps>): WizardDeps => ({
  cliPath: join(__dirname, '..', '..', '..', 'plugin', 'dist', 'hub.cjs'),
  tokenExec: noKeychain,
  runGit: realGit,
  gh: noGh,
  now: () => NOW,
  ...over,
});

// Answers up to (not including) the preview choice.
const head = (url = 'https://acme.atlassian.net') => [
  'me', '1', '2', url, 'me@example.com', 'jira-tok-1', // you, tracker, connect
  '1,2', // Jira projects WEB, OPS
  '1', // project source: Component
  '', 'gl', // Acme site keeps AS; Globex web becomes GL
  '', '', '', '', // statuses keep the guesses
  '2', // sprints: board 12
  '', // urgent keeps Highest
];
const tail = (repo: string, home: string) => [
  'sam:dev', 'pat:pm', '', // teammates
  '', '', // folders keep their defaults
  repo, // hub repo
  join(home, 'projects'), 'n', // self-join: projects folder, settings
];

const EXPECTED: Workflow = {
  requires: RIXFLOW_VERSION,
  legacy: false,
  tracker: { type: 'jira', url: 'https://acme.atlassian.net', flavor: 'cloud', projects: ['WEB', 'OPS'] },
  project: { from: 'component', field: null, values: { 'Acme site': 'AS', 'Globex web': 'GL' } },
  status: { field: null, todo: ['To Do'], in_progress: ['In Progress'], waiting: ['Waiting for feedback'], done: ['Done'] },
  sprints: { mode: 'jira-sprints', board: 12 },
  urgent: { field: null, values: ['Highest'] },
};

const git = (args: string[]) =>
  new Promise<string>((res, rej) => execFile('git', args, { encoding: 'utf8' }, (e, out) => (e ? rej(e) : res(out))));

describe('runCreate', () => {
  it('a scripted Jira Cloud create builds, saves and pushes the hub', async () => {
    const m = machine();
    await emptyRemote(m.remote);
    const j = fakeJira();
    const io = scriptedIo([...head(), '1', ...tail(m.remote, m.home)]);
    await runCreate(io, deps({ makeJira: j.makeJira }), m.env);

    expect(loadWorkflow(m.hub)).toEqual(EXPECTED);
    const local = (await git(['-C', m.hub, 'rev-parse', 'HEAD'])).trim();
    expect((await git(['--git-dir', m.remote, 'rev-parse', 'main'])).trim()).toBe(local);
    expect(await git(['--git-dir', m.remote, 'show', 'main:config/workflow.yml'])).toBe(readFileSync(join(m.hub, 'config', 'workflow.yml'), 'utf8'));
    expect(loadTeam(m.hub)).toEqual([{ name: 'me', role: 'dev' }, { name: 'sam', role: 'dev' }, { name: 'pat', role: 'pm' }]);
    expect(loadSites(m.hub)).toEqual({ AS: { folder: 'acme-site' }, GL: { folder: 'globex-web' } });

    expect(YAML.parse(readFileSync(join(m.cfg, 'config.yml'), 'utf8'))).toEqual({
      name: 'me', role: 'dev', projectsRoot: join(m.home, 'projects'), jiraEmail: 'me@example.com', siteFolders: {}, taskSites: {},
    });
    expect(readFileSync(join(m.cfg, 'jira-token'), 'utf8')).toBe('jira-tok-1');
    expect(existsSync(join(m.hub, '.git', 'hooks', 'pre-commit'))).toBe(true);
    expect(existsSync(join(m.cfg, 'setup-progress.json'))).toBe(false);
    expect(j.sampled.every((s) => s.join() === 'WEB,OPS')).toBe(true);

    const out = io.logs.join('\n');
    expect(out).toMatch(/WEB-1 +Fix the login page +AS +in progress +yes +yes/);
    expect(out).toMatch(/OPS-7 +Rotate certs +no project +waiting +no +no/);
    expect(out).toContain('https://github.com/hnikoloski/rixflow#installation');
    expect(out).toContain(m.remote);
    expect(out).not.toContain('jira-tok-1');
    expect(io.left()).toBe(0);
  });

  it('preview can go back to statuses, reruns them and returns to the preview', async () => {
    const m = machine();
    await emptyRemote(m.remote);
    const j = fakeJira();
    const io = scriptedIo([
      ...head(), '4', // back to statuses
      '', '', '1', '', // "Waiting for feedback" becomes to do
      '2', '', // sprints and urgent run again
      '1', ...tail(m.remote, m.home),
    ]);
    await runCreate(io, deps({ makeJira: j.makeJira }), m.env);
    const asked = io.logs.filter((l) => l.startsWith('Is this right?')).length;
    expect(asked).toBe(2);
    expect(io.logs.filter((l) => l.includes('Status "To Do" means')).length).toBe(2);
    expect(loadWorkflow(m.hub).status).toEqual({
      field: null, todo: ['To Do', 'Waiting for feedback'], in_progress: ['In Progress'], waiting: [], done: ['Done'],
    });
  });

  it('resumes after connect without asking for the login again', async () => {
    const m = machine();
    await emptyRemote(m.remote);
    const j = fakeJira();
    const first = scriptedIo(head().slice(0, 7));
    await expect(runCreate(first, deps({ makeJira: j.makeJira }), m.env)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(readFileSync(join(m.cfg, 'setup-progress.json'), 'utf8')).not.toMatch(/jira-tok-1|@/);
    const io = scriptedIo(['y', ...head().slice(7), '1', ...tail(m.remote, m.home)]);
    await runCreate(io, deps({ makeJira: j.makeJira }), m.env);
    expect(io.asked[0]).toMatch(/Continue where you stopped \(connect\)/);
    expect(io.asked.some((q) => /token|email/i.test(q))).toBe(false);
    expect(j.calls.at(-1)?.auth).toEqual({ flavor: 'cloud', email: 'me@example.com', token: 'jira-tok-1' });
    expect(loadWorkflow(m.hub)).toEqual(EXPECTED);
  });

  it('refuses a remote that already has commits', async () => {
    const h = await hubWithRemote();
    const m = machine();
    const j = fakeJira();
    const io = scriptedIo([...head(), '1', 'sam:dev', '', '', '', h.remote]);
    const err = await runCreate(io, deps({ makeJira: j.makeJira }), m.env).catch((e) => e);
    expect(err).toMatchObject({ code: 'REPO_NOT_EMPTY' });
    expect(err.message).toMatch(/empty/);
    expect(existsSync(m.hub)).toBe(false);
    // The answers so far are kept: running again continues at the repo step.
    expect(JSON.parse(readFileSync(join(m.cfg, 'setup-progress.json'), 'utf8')).done.at(-1)).toBe('folders');
  });

  it('refuses a public remote', async () => {
    const m = machine();
    const j = fakeJira();
    const io = scriptedIo([...head(), '1', '', '', '', 'git@github.com:acme/hub.git']);
    const err = await runCreate(io, deps({ makeJira: j.makeJira, runGit: async () => ({ ok: true, stdout: '' }) }), m.env).catch((e) => e);
    expect(err).toMatchObject({ code: 'PUBLIC_HUB' });
    expect(existsSync(m.hub)).toBe(false);
  });

  it('offers gh and uses the private repo it creates', async () => {
    const m = machine();
    await emptyRemote(m.remote);
    const j = fakeJira();
    const created: string[] = [];
    const gh: Gh = { available: async () => true, createPrivate: async (n) => { created.push(n); return m.remote; } };
    const io = scriptedIo([...head(), '1', '', '', '', 'y', 'acme/hub', join(m.home, 'projects'), 'n']);
    await runCreate(io, deps({ makeJira: j.makeJira, gh }), m.env);
    expect(created).toEqual(['acme/hub']);
    expect((await git(['--git-dir', m.remote, 'rev-parse', 'main'])).trim()).toBe((await git(['-C', m.hub, 'rev-parse', 'HEAD'])).trim());
  });

  it('Asana: workspace goes in the workflow, and sprints are none when no section looks like a sprint', async () => {
    const m = machine();
    await emptyRemote(m.remote);
    const task: AsanaTask = {
      gid: '1001', name: 'Acme homepage', modified_at: '2026-10-01T00:00:00Z',
      memberships: [{ project: { gid: '9', name: 'Acme web' }, section: { gid: '8', name: 'Backlog' } }],
      custom_fields: [{ name: 'Status', display_value: 'In progress' }, { name: 'Priority', display_value: 'Urgent' }],
    };
    const makeAsana = () => ({
      getMe: async () => ({ gid: '42', name: 'Me', workspaces: [{ gid: '111', name: 'Acme' }] }),
      getMyTasks: async () => [task], getTask: async () => task, getComments: async () => [],
    });
    const io = scriptedIo([
      'me', '2', '1', 'tok-a', // pm, Asana
      '3', '', // project source: Asana project (after the Status and Priority fields); "Acme web" keeps AW
      '', // status keeps its guess
      '', // urgent keeps Urgent
      '1', '', '', m.remote, join(m.home, 'projects'), 'n',
    ]);
    await runCreate(io, deps({ makeAsana }), m.env);
    expect(loadWorkflow(m.hub)).toEqual({
      requires: RIXFLOW_VERSION, legacy: false,
      tracker: { type: 'asana', workspace: '111' },
      project: { from: 'asana-project', field: null, values: { 'Acme web': 'AW' } },
      status: { field: 'Status', todo: [], in_progress: ['In progress'], waiting: [], done: [] },
      sprints: { mode: 'none' },
      urgent: { field: 'Priority', values: ['Urgent'] },
    });
    expect(io.logs.join('\n')).toMatch(/No section name looks like a sprint/);
    expect(loadTeam(m.hub)).toEqual([{ name: 'me', role: 'pm' }]);
    expect(YAML.parse(readFileSync(join(m.cfg, 'config.yml'), 'utf8')).asanaWorkspace).toBeUndefined();
  });
});

describe('suggestCode', () => {
  it('uses word initials and adds a number on a clash', () => {
    expect(suggestCode('Acme site', new Set())).toBe('AS');
    expect(suggestCode('Acme site', new Set(['AS']))).toBe('AS2');
    expect(suggestCode('Acme site', new Set(['AS', 'AS2']))).toBe('AS3');
    expect(suggestCode('globex web shop and more', new Set())).toBe('GWSA');
    expect(suggestCode('WEB', new Set())).toBe('WEB');
    expect(suggestCode('Marketing', new Set())).toBe('MA');
    expect(suggestCode('!!', new Set())).toMatch(/^[A-Z0-9]{2,4}$/);
  });
});

describe('guessBucket', () => {
  it('guesses from common status words', () => {
    expect(guessBucket('Done')).toBe('done');
    expect(guessBucket('Closed')).toBe('done');
    expect(guessBucket('In Progress')).toBe('in_progress');
    expect(guessBucket('In Review')).toBe('in_progress');
    expect(guessBucket('Waiting for feedback')).toBe('waiting');
    expect(guessBucket('Blocked')).toBe('waiting');
    expect(guessBucket('To Do')).toBe('todo');
    expect(guessBucket('Selected for Development')).toBe('todo');
    expect(guessBucket('Something else')).toBeNull();
  });
});

describe('projectOptions', () => {
  it('lists only sources with values, with up to 3 distinct examples', () => {
    const samples = [
      ticket({ components: ['A', 'B'], fields: [{ name: 'Client', value: 'Acme' }] }),
      ticket({ components: ['B', 'C', 'D'] }),
    ];
    expect(projectOptions(samples, 'jira')).toEqual([
      { from: 'custom-field', field: 'Client', label: 'Field "Client"', examples: ['Acme'] },
      { from: 'component', field: null, label: 'Component', examples: ['A', 'B', 'C'] },
      { from: 'jira-project', field: null, label: 'Jira project', examples: ['WEB'] },
    ]);
    expect(projectOptions([ticket({ containers: ['Acme web'] })], 'asana')).toEqual([
      { from: 'asana-project', field: null, label: 'Asana project', examples: ['Acme web'] },
    ]);
  });
});

describe('previewRows', () => {
  it('shows "no project" for a ticket no value maps', () => {
    const rows = previewRows(SAMPLES, EXPECTED, NOW);
    expect(rows[2]).toEqual({ id: 'OPS-7', title: 'Rotate certs', project: 'no project', bucket: 'waiting', sprint: false, urgent: false });
    expect(rows[0]).toEqual({ id: 'WEB-1', title: 'Fix the login page', project: 'AS', bucket: 'in progress', sprint: true, urgent: true });
  });
});

describe('inviteText', () => {
  it('names the hub, every teammate and the install steps, and nothing private', () => {
    const text = inviteText('https://bob:tok-123@example.com/acme/hub.git', [
      { name: 'me', role: 'dev' }, { name: 'sam', role: 'dev' }, { name: 'pat', role: 'pm' },
    ], 'me');
    expect(text).toContain('https://example.com/acme/hub.git');
    for (const n of ['sam', 'pat']) expect(text).toContain(n);
    expect(text).toContain('https://github.com/hnikoloski/rixflow#installation');
    expect(text).toContain('/plugin marketplace add hnikoloski/rixflow');
    expect(text).toContain('/plugin install rixflow-ui@rixflow');
    expect(text).not.toContain('tok-123');
    expect(text).not.toContain('bob');
    expect(text).not.toMatch(/[^\s@]+@[^\s@]+\.[a-z]+/i);
  });
});
