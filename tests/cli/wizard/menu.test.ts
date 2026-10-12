import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { runInit } from '../../../src/cli/init';
import type { WizardDeps } from '../../../src/cli/wizard/connect';
import { runMenu } from '../../../src/cli/wizard/menu';
import { storedSource } from '../../../src/cli/wizard/connect';
import type { AsanaTask } from '../../../src/core/asana';
import { loadSites, loadTeam } from '../../../src/core/team';
import { getToken } from '../../../src/core/token';
import type { Discovery, Ticket, TicketSource } from '../../../src/core/tickets/types';
import type { Ctx } from '../../../src/core/types';
import { RIXFLOW_VERSION } from '../../../src/core/version';
import { loadWorkflow, writeWorkflow, type Workflow } from '../../../src/core/workflow';
import { hubWithRemote } from '../../gitHub';
import { scriptedIo } from './io';

const MENU = {
  addTeammate: '1', removeTeammate: '2', addProject: '3', renameProject: '4',
  redoMapping: '5', reconnect: '6', startOver: '7', exit: '8',
};

const noKeychain = () => { throw new Error('no keychain'); };
const deps = (over: Partial<WizardDeps> = {}): WizardDeps => ({
  cliPath: join(__dirname, '..', '..', '..', 'plugin', 'dist', 'hub.cjs'),
  tokenExec: noKeychain,
  now: () => new Date('2026-10-08T10:00:00Z'),
  ...over,
});

async function setUp(user = 'me') {
  const h = await hubWithRemote(['me', 'pm']);
  const ctx: Ctx = h.person(user);
  mkdirSync(ctx.configDir, { recursive: true });
  writeFileSync(join(ctx.configDir, 'config.yml'), YAML.stringify({ ...ctx.user, siteFolders: {}, taskSites: {} }));
  const env = { ...process.env, HOME: h.root, RIXFLOW_DIR: ctx.hubDir, RIXFLOW_CONFIG_DIR: ctx.configDir } as NodeJS.ProcessEnv;
  const inHub = (...args: string[]) => h.git(['-C', ctx.hubDir, ...args]);
  return { ...h, ctx, env, inHub };
}

describe('runMenu', () => {
  it('offers the team changes, reconnect, start over and exit, but no project removal or system switch', async () => {
    const s = await setUp();
    const io = scriptedIo([MENU.exit]);
    await runMenu(io, deps(), s.ctx, s.env);
    const menu = io.logs.join('\n');
    for (const label of ['Add a teammate', 'Remove a teammate', 'Add a project', 'Rename or move a project', 'Redo the ticket mapping',
      'Reconnect my ticket account', 'Start over on this machine', 'Exit']) expect(menu).toContain(label);
    expect(menu).not.toMatch(/remove a project|delete a project|switch/i);
  });

  it('adds a teammate in one commit that touches only config/team.yml, and pushes it', async () => {
    const s = await setUp();
    writeFileSync(join(s.ctx.hubDir, 'people', 'me', 'draft.md'), 'not part of the team change\n');
    const io = scriptedIo([MENU.addTeammate, 'sam', '1', MENU.exit]);
    await runMenu(io, deps(), s.ctx, s.env);
    expect(loadTeam(s.ctx.hubDir)).toEqual([{ name: 'me', role: 'dev' }, { name: 'pm', role: 'pm' }, { name: 'sam', role: 'dev' }]);
    expect(s.inHub('log', '-1', '--format=%s').trim()).toBe('chore: add teammate sam (me)');
    expect(s.inHub('show', '--name-only', '--format=', 'HEAD').trim()).toBe('config/team.yml');
    expect(s.inHub('status', '--porcelain').trim()).toBe('?? people/me/draft.md');
    expect(s.git(['--git-dir', s.remote, 'show', 'main:config/team.yml'])).toContain('sam');
    expect(io.logs.join('\n')).toMatch(/sam.*synced/);
  });

  it('refuses a name already on the team or one that breaks the name rule', async () => {
    const s = await setUp();
    const io = scriptedIo([MENU.addTeammate, 'pm', 'Bad Name', 'sam', '2', MENU.exit]);
    await runMenu(io, deps(), s.ctx, s.env);
    expect(io.logs.join('\n')).toMatch(/pm is already on the team/);
    expect(loadTeam(s.ctx.hubDir).at(-1)).toEqual({ name: 'sam', role: 'pm' });
  });

  it('removes a teammate from team.yml only; their files stay in the hub', async () => {
    const s = await setUp();
    const io = scriptedIo([MENU.removeTeammate, '1', 'y', MENU.exit]);
    await runMenu(io, deps(), s.ctx, s.env);
    expect(loadTeam(s.ctx.hubDir)).toEqual([{ name: 'me', role: 'dev' }]);
    expect(existsSync(join(s.ctx.hubDir, 'people', 'pm', '_index.md'))).toBe(true);
    expect(s.inHub('show', '--name-status', '--format=', 'HEAD').trim()).toBe('M\tconfig/team.yml');
    expect(s.inHub('log', '-1', '--format=%s').trim()).toBe('chore: remove teammate pm (me)');
  });

  it('adds a project with a name and a folder', async () => {
    const s = await setUp();
    const io = scriptedIo([MENU.addProject, 'gl', 'Globex web', '', MENU.exit]);
    await runMenu(io, deps(), s.ctx, s.env);
    expect(loadSites(s.ctx.hubDir)).toEqual({ AC: { folder: 'acme' }, GL: { name: 'Globex web', folder: 'globex-web' } });
    expect(s.inHub('show', '--name-only', '--format=', 'HEAD').trim()).toBe('config/sites.yml');
    expect(s.inHub('log', '-1', '--format=%s').trim()).toBe('chore: add project GL (me)');
  });

  it('renames and moves a project but keeps its code and its shared/sites/AC/ notes', async () => {
    const s = await setUp();
    mkdirSync(join(s.ctx.hubDir, 'shared', 'sites', 'AC'), { recursive: true });
    writeFileSync(join(s.ctx.hubDir, 'shared', 'sites', 'AC', 'deploy.md'), '# Deploy\n');
    s.inHub('add', '-A');
    s.inHub('commit', '-q', '-m', 'notes');
    const io = scriptedIo([MENU.renameProject, '1', 'Acme site', 'acme-site', MENU.exit]);
    await runMenu(io, deps(), s.ctx, s.env);
    expect(io.logs.join('\n')).toContain("The short code (AC) can't change: it's part of saved notes and links.");
    expect(loadSites(s.ctx.hubDir)).toEqual({ AC: { name: 'Acme site', folder: 'acme-site' } });
    expect(readFileSync(join(s.ctx.hubDir, 'shared', 'sites', 'AC', 'deploy.md'), 'utf8')).toBe('# Deploy\n');
    expect(s.inHub('show', '--name-only', '--format=', 'HEAD').trim()).toBe('config/sites.yml');
  });

  it('redo the mapping on a legacy hub warns first, then writes workflow.yml with requires', async () => {
    const s = await setUp();
    writeFileSync(join(s.ctx.configDir, 'config.yml'), YAML.stringify({ ...s.ctx.user, asanaWorkspace: '111' }));
    writeFileSync(join(s.ctx.configDir, 'asana-token'), 'tok-a', { mode: 0o600 });
    const ctx: Ctx = { ...s.ctx, user: { ...s.ctx.user, asanaWorkspace: '111' } };
    const task: AsanaTask = {
      gid: '1001', name: 'Acme homepage', modified_at: '2026-10-01T00:00:00Z',
      memberships: [{ project: { gid: '9', name: 'Acme web' }, section: { gid: '8', name: 'Backlog' } }],
      custom_fields: [{ name: 'Website', display_value: 'AC' }, { name: 'Status', display_value: 'In progress' }, { name: 'Priority', display_value: 'Urgent' }],
    };
    const tokens: string[] = [];
    const makeAsana = (t: string) => {
      tokens.push(t);
      return {
        getMe: async () => ({ gid: '42', name: 'Me', workspaces: [{ gid: '111', name: 'Acme' }] }),
        getMyTasks: async () => [task], getTask: async () => task, getComments: async () => [],
      };
    };
    // Declining the warning changes nothing.
    const no = scriptedIo([MENU.redoMapping, 'n', MENU.exit]);
    await runMenu(no, deps({ makeAsana }), ctx, s.env);
    expect(no.logs.join('\n')).toContain(`Everyone on the team must update to RixFlow ${RIXFLOW_VERSION} first. Older copies will ignore these settings.`);
    expect(existsSync(join(s.ctx.hubDir, 'config', 'workflow.yml'))).toBe(false);

    const io = scriptedIo([
      MENU.redoMapping, 'y',
      '', // project source keeps the current answer (the Website field)
      '', // "AC" keeps AC
      '', // status keeps its guess
      '', // urgent keeps Urgent (the current answer, any case)
      '', '', '', // the legacy urgent values the sample lacks (critical, p0, highest) are kept
      '1', // accept the preview
      MENU.exit,
    ]);
    await runMenu(io, deps({ makeAsana }), ctx, s.env);
    expect(io.logs.join('\n')).toContain(`Everyone on the team must update to RixFlow ${RIXFLOW_VERSION} first.`);
    expect(io.logs.join('\n')).toMatch(/Some tickets as RixFlow will see them/);
    expect(tokens).toEqual(['tok-a']); // the stored token, never asked again
    const expected: Workflow = {
      requires: RIXFLOW_VERSION, legacy: false,
      tracker: { type: 'asana', workspace: null },
      project: { from: 'custom-field', field: 'Website', values: { AC: 'AC' } },
      status: { field: 'Status', todo: [], in_progress: ['In progress'], waiting: [], done: [] },
      sprints: { mode: 'none' },
      urgent: { field: 'Priority', values: ['Urgent', 'critical', 'p0', 'highest'] },
    };
    expect(loadWorkflow(s.ctx.hubDir)).toEqual(expected);
    expect(readFileSync(join(s.ctx.hubDir, 'config', 'workflow.yml'), 'utf8')).toMatch(new RegExp(`^requires: ${RIXFLOW_VERSION.replace(/\./g, '\\.')}`));
    expect(readFileSync(join(s.ctx.hubDir, 'config', 'workflow.yml'), 'utf8')).not.toContain('tok-a');
    expect(s.inHub('show', '--name-only', '--format=', 'HEAD').trim()).toBe('config/workflow.yml');
    expect(s.inHub('log', '-1', '--format=%s').trim()).toBe('chore: redo the ticket mapping (me)');
    expect(existsSync(join(s.ctx.configDir, 'setup-progress.json'))).toBe(false);
  });

  // A redo where the sample lacks a project value, a status and an urgent priority the team mapped before.
  const commitWorkflow = (s: Awaited<ReturnType<typeof setUp>>, wf: Workflow) => {
    writeWorkflow(s.ctx.hubDir, wf);
    s.inHub('add', '-A');
    s.inHub('commit', '-q', '-m', 'workflow');
  };
  const keepRun = (keep: string) => [
    MENU.redoMapping,
    '', // project source keeps the current answer
    '', // the sampled value keeps its code
    keep, // kept from before: the project value not in the sample
  ];

  it('redo on a Jira workflow keeps mapped values the sample lacks, and - removes them', async () => {
    const s = await setUp();
    const wf: Workflow = {
      requires: RIXFLOW_VERSION, legacy: false,
      tracker: { type: 'jira', url: 'https://acme.atlassian.net', flavor: 'cloud', projects: ['WEB'] },
      project: { from: 'component', field: null, values: { 'Acme site': 'AC', 'Globex web': 'GL' } },
      status: { field: null, todo: ['To Do'], in_progress: ['In Progress'], waiting: ['QA Review'], done: ['Done'] },
      sprints: { mode: 'none' }, urgent: { field: null, values: ['Blocker'] },
    };
    commitWorkflow(s, wf);
    writeFileSync(join(s.ctx.configDir, 'config.yml'), YAML.stringify({ ...s.ctx.user, jiraEmail: 'me@example.com', jiraUrl: 'https://acme.atlassian.net' }));
    writeFileSync(join(s.ctx.configDir, 'jira-token'), 'tok-j', { mode: 0o600 });
    const ctx: Ctx = { ...s.ctx, user: { ...s.ctx.user, jiraEmail: 'me@example.com', jiraUrl: 'https://acme.atlassian.net' } };
    const ticket: Ticket = {
      id: 'WEB-1', title: 'Fix the login page', notes: '', modifiedAt: '2026-10-01T00:00:00Z', due: null, url: null, parent: null,
      status: 'In Progress', priority: 'High', fields: [], components: ['Acme site'], labels: [], containers: ['WEB'], sections: [], sprints: [], restricted: false,
    };
    const makeJira = (): TicketSource & Discovery => ({
      kind: 'jira', label: 'Jira', normalizeId: (x) => x,
      whoAmI: async () => ({ id: 'acc-1', name: 'Me' }),
      myTickets: async () => [ticket], ticket: async () => ticket, comments: async () => [],
      scopes: async () => [], sample: async () => [ticket], statuses: async () => ['To Do', 'In Progress', 'Done'],
      priorities: async () => ['Highest', 'High'], boards: async () => [],
    });
    const statuses = ['', '', '']; // To Do, In Progress, Done keep their current buckets
    const keep = scriptedIo([...keepRun(''), ...statuses, '', '', '', '1', MENU.exit]);
    await runMenu(keep, deps({ makeJira }), ctx, s.env);
    expect(keep.logs.join('\n')).toContain('Kept from before');
    expect(loadWorkflow(s.ctx.hubDir)).toEqual(wf);

    const drop = scriptedIo([...keepRun('-'), ...statuses, '-', '', '-', '1', MENU.exit]);
    await runMenu(drop, deps({ makeJira }), ctx, s.env);
    expect(loadWorkflow(s.ctx.hubDir)).toEqual({
      ...wf,
      project: { ...wf.project, values: { 'Acme site': 'AC' } },
      status: { ...wf.status, waiting: [] },
      urgent: { field: null, values: [] },
    });
    expect(drop.left()).toBe(0);
  });

  it('redo on an Asana workflow keeps mapped values the sample lacks, and - removes them', async () => {
    const s = await setUp();
    const wf: Workflow = {
      requires: RIXFLOW_VERSION, legacy: false,
      tracker: { type: 'asana', workspace: '111' },
      project: { from: 'custom-field', field: 'Website', values: { AC: 'AC', GL: 'GL' } },
      status: { field: 'Status', todo: [], in_progress: ['In progress'], waiting: ['On hold'], done: [] },
      sprints: { mode: 'none' }, urgent: { field: 'Priority', values: ['Urgent', 'Critical'] },
    };
    commitWorkflow(s, wf);
    writeFileSync(join(s.ctx.configDir, 'asana-token'), 'tok-a', { mode: 0o600 });
    const task: AsanaTask = {
      gid: '1001', name: 'Acme homepage', modified_at: '2026-10-01T00:00:00Z',
      memberships: [{ project: { gid: '9', name: 'Acme web' }, section: { gid: '8', name: 'Backlog' } }],
      custom_fields: [{ name: 'Website', display_value: 'AC' }, { name: 'Status', display_value: 'In progress' }, { name: 'Priority', display_value: 'Urgent' }],
    };
    const makeAsana = () => ({
      getMe: async () => ({ gid: '42', name: 'Me', workspaces: [{ gid: '111', name: 'Acme' }] }),
      getMyTasks: async () => [task], getTask: async () => task, getComments: async () => [],
    });
    const keep = scriptedIo([...keepRun(''), '', '', '', '', '1', MENU.exit]);
    await runMenu(keep, deps({ makeAsana }), s.ctx, s.env);
    expect(keep.logs.join('\n')).toContain('Kept from before');
    expect(loadWorkflow(s.ctx.hubDir)).toEqual(wf);

    const drop = scriptedIo([...keepRun('-'), '', '-', '', '-', '1', MENU.exit]);
    await runMenu(drop, deps({ makeAsana }), s.ctx, s.env);
    expect(loadWorkflow(s.ctx.hubDir)).toEqual({
      ...wf,
      project: { ...wf.project, values: { AC: 'AC' } },
      status: { ...wf.status, waiting: [] },
      urgent: { field: 'Priority', values: ['Urgent'] },
    });
    expect(drop.left()).toBe(0);
  });

  it('start over removes this machine\'s setup and tokens but leaves the hub clone untouched', async () => {
    const s = await setUp();
    const cfg = s.ctx.configDir;
    for (const f of ['asana-token', 'jira-token', 'setup-progress.json', 'status-cache.json']) writeFileSync(join(cfg, f), 'x');
    writeFileSync(join(cfg, 'state.json'), '{}');
    const before = { head: s.inHub('rev-parse', 'HEAD'), files: readdirSync(s.ctx.hubDir, { recursive: true }).sort() };
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ''; };
    const io = scriptedIo([MENU.startOver, 'y']);
    await runMenu(io, deps({ tokenExec: exec }), s.ctx, s.env);
    for (const f of ['config.yml', 'asana-token', 'jira-token', 'setup-progress.json', 'status-cache.json']) expect(existsSync(join(cfg, f))).toBe(false);
    expect(existsSync(join(cfg, 'state.json'))).toBe(true);
    const cleared = calls.map((c) => c.join(' '));
    expect(cleared.some((c) => c.endsWith('asana:me'))).toBe(true);
    expect(cleared.some((c) => c.endsWith('jira:me'))).toBe(true);
    expect(s.inHub('status', '--porcelain')).toBe('');
    expect(s.inHub('rev-parse', 'HEAD')).toBe(before.head);
    expect(readdirSync(s.ctx.hubDir, { recursive: true }).sort()).toEqual(before.files);
    expect(io.left()).toBe(0);
  });

  it('start over also removes the legacy shared Asana login 0.2.0 stored, so no Asana token is left', async () => {
    const s = await setUp();
    const cfg = s.ctx.configDir;
    writeFileSync(join(cfg, 'asana-token'), 'legacy-file-tok', { mode: 0o600 });
    // A fake keychain (secret-tool / security style): account -> token.
    const items = new Map<string, string>([['asana', 'legacy-tok'], ['asana:me', 'own-tok']]);
    const exec = (cmd: string, args: string[]) => {
      const account = args[args.indexOf(cmd === 'security' ? '-a' : 'account') + 1];
      const op = args[0];
      if (op === 'lookup' || op === 'find-generic-password') {
        const v = items.get(account);
        if (v === undefined) throw new Error('not found');
        return v;
      }
      if (op === 'clear' || op === 'delete-generic-password') { items.delete(account); return ''; }
      throw new Error(`unexpected ${op}`);
    };
    expect(getToken(cfg, {}, exec, 'me', 'asana')).toBe('own-tok');
    const io = scriptedIo([MENU.startOver, 'y']);
    await runMenu(io, deps({ tokenExec: exec }), s.ctx, s.env);
    expect([...items.keys()]).toEqual([]);
    expect(existsSync(join(cfg, 'asana-token'))).toBe(false);
    expect(getToken(cfg, {}, exec, 'me', 'asana')).toBeNull();
  });

  it('start over asks first and does nothing when declined', async () => {
    const s = await setUp();
    const io = scriptedIo([MENU.startOver, 'n', MENU.exit]);
    await runMenu(io, deps(), s.ctx, s.env);
    expect(existsSync(join(s.ctx.configDir, 'config.yml'))).toBe(true);
  });
});

describe('runInit on a set-up machine', () => {
  const jiraTicket: Ticket = {
    id: 'WEB-1', title: 'Fix the login page', notes: '', modifiedAt: '2026-10-01T00:00:00Z', due: null, url: null, parent: null,
    status: 'In Progress', priority: null, fields: [], components: [], labels: [], containers: ['WEB'], sections: [], sprints: [], restricted: false,
  };
  const makeJira = (): TicketSource & Discovery => ({
    kind: 'jira', label: 'Jira', normalizeId: (x) => x,
    whoAmI: async () => ({ id: 'acc-1', name: 'Me' }),
    myTickets: async () => [jiraTicket], ticket: async () => jiraTicket, comments: async () => [],
    scopes: async () => [], sample: async () => [jiraTicket], statuses: async () => [], priorities: async () => [], boards: async () => [],
  });

  it('a Jira machine sees the menu and reconnects to Jira, never asked for an Asana token', async () => {
    const s = await setUp();
    writeWorkflow(s.ctx.hubDir, {
      requires: RIXFLOW_VERSION, legacy: false,
      tracker: { type: 'jira', url: 'https://acme.atlassian.net', flavor: 'cloud', projects: ['WEB'] },
      project: { from: 'component', field: null, values: { 'Acme site': 'AC' } },
      status: { field: null, todo: ['To Do'], in_progress: ['In Progress'], waiting: [], done: ['Done'] },
      sprints: { mode: 'none' }, urgent: { field: null, values: [] },
    });
    s.inHub('add', '-A');
    s.inHub('commit', '-q', '-m', 'workflow');
    const io = scriptedIo(['yes', MENU.reconnect, 'me@example.com', 'jira-tok', MENU.exit]);
    await runInit(io, '/x/hub.cjs', s.env, { makeJira, tokenExec: noKeychain });
    expect(io.logs.join('\n')).toContain('Reconnect my ticket account');
    expect(io.logs.join('\n')).not.toContain('Join an existing team');
    expect([...io.asked, ...io.logs].join('\n')).not.toMatch(/asana/i);
    expect(readFileSync(join(s.ctx.configDir, 'jira-token'), 'utf8')).toBe('jira-tok');
    expect(YAML.parse(readFileSync(join(s.ctx.configDir, 'config.yml'), 'utf8')).jiraEmail).toBe('me@example.com');
    expect(YAML.parse(readFileSync(join(s.ctx.configDir, 'config.yml'), 'utf8')).jiraUrl).toBe('https://acme.atlassian.net');
  });

  const jiraWorkflow = (url: string): Workflow => ({
    requires: RIXFLOW_VERSION, legacy: false,
    tracker: { type: 'jira', url, flavor: 'cloud', projects: ['WEB'] },
    project: { from: 'component', field: null, values: { 'Acme site': 'AC' } },
    status: { field: null, todo: ['To Do'], in_progress: ['In Progress'], waiting: [], done: ['Done'] },
    sprints: { mode: 'none' }, urgent: { field: null, values: [] },
  });

  it('the stored Jira token is never used for an address other than the one this machine pinned', () => {
    const calls: string[] = [];
    const spy = (url: string) => { calls.push(url); return makeJira(); };
    const user = { name: 'me', configDir: '/nowhere', jiraEmail: 'me@example.com', jiraUrl: 'https://acme.atlassian.net' };
    const env = { JIRA_TOKEN: 'tok-secret' };
    expect(storedSource(deps({ makeJira: spy }), jiraWorkflow('https://globex.example.com'), user, env)).toBeNull();
    expect(storedSource(deps({ makeJira: spy }), jiraWorkflow('https://acme.atlassian.net'), { ...user, jiraUrl: undefined }, env)).toBeNull();
    expect(calls).toEqual([]);
    expect(storedSource(deps({ makeJira: spy }), jiraWorkflow('https://acme.atlassian.net'), user, env)).not.toBeNull();
    expect(calls).toEqual(['https://acme.atlassian.net']);
  });

  it('reconnect after the team\'s Jira address changed names the new address, then pins it', async () => {
    const s = await setUp();
    writeWorkflow(s.ctx.hubDir, jiraWorkflow('https://acme.atlassian.net'));
    s.inHub('add', '-A');
    s.inHub('commit', '-q', '-m', 'workflow');
    writeFileSync(join(s.ctx.configDir, 'config.yml'), YAML.stringify({ ...s.ctx.user, jiraEmail: 'me@example.com', jiraUrl: 'https://jira.globex.example.com' }));
    writeFileSync(join(s.ctx.configDir, 'jira-token'), 'old-tok', { mode: 0o600 });
    const tokens: string[] = [];
    const spy = (_u: string, auth: { token: string }) => { tokens.push(auth.token); return makeJira(); };
    const io = scriptedIo(['yes', MENU.reconnect, 'me@example.com', 'new-tok', MENU.exit]);
    await runInit(io, '/x/hub.cjs', s.env, { makeJira: spy, tokenExec: noKeychain });
    expect(io.logs.join('\n')).toContain("The team's Jira address is https://acme.atlassian.net (this machine used https://jira.globex.example.com)");
    expect(tokens).toEqual(['new-tok']);
    const cfg = YAML.parse(readFileSync(join(s.ctx.configDir, 'config.yml'), 'utf8'));
    expect(cfg.jiraUrl).toBe('https://acme.atlassian.net');
    expect(readFileSync(join(s.ctx.configDir, 'jira-token'), 'utf8')).toBe('new-tok');
  });
});
