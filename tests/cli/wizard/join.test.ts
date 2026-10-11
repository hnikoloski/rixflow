import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { runJoin } from '../../../src/cli/wizard/join';
import type { WizardDeps } from '../../../src/cli/wizard/connect';
import type { AsanaTask } from '../../../src/core/asana';
import { loadWorkflow, writeWorkflow, type Workflow } from '../../../src/core/workflow';
import type { JiraAuth } from '../../../src/core/tickets/jira';
import type { Ticket, TicketSource } from '../../../src/core/tickets/types';
import { HubError } from '../../../src/core/types';
import { hubWithRemote } from '../../gitHub';
import { scriptedIo } from './io';

const noKeychain = () => { throw new Error('no keychain'); };

// requires stays null until the version bump to 0.3.0 lands.
const JIRA_WF: Workflow = {
  requires: null,
  legacy: false,
  tracker: { type: 'jira', url: 'https://acme.atlassian.net', flavor: 'cloud', projects: ['WEB', 'OPS'] },
  project: { from: 'jira-project', field: null, values: { WEB: 'AC' } },
  status: { field: null, todo: ['To Do'], in_progress: ['In Progress'], waiting: [], done: ['Done'] },
  sprints: { mode: 'none' },
  urgent: { field: null, values: ['Highest'] },
};

const ticket = (over: Partial<Ticket>): Ticket => ({
  id: 'WEB-1', title: 'Fix the login page', notes: '', modifiedAt: '2026-10-01T00:00:00Z', due: null, url: null, parent: null,
  status: 'In Progress', priority: null, fields: [], components: [], labels: [], containers: ['WEB'], sections: [], sprints: [],
  restricted: false, ...over,
});

function fakeJira(tickets: Ticket[], failFirst?: string) {
  const calls: Array<{ url: string; auth: JiraAuth; projects: string[] }> = [];
  const makeJira = (url: string, auth: JiraAuth, projects: string[]): TicketSource => {
    calls.push({ url, auth, projects });
    const fail = failFirst && calls.length === 1 ? failFirst : undefined;
    return {
      kind: 'jira', label: 'Jira', normalizeId: (s) => s,
      whoAmI: async () => { if (fail) throw new HubError(fail, 'raw error'); return { id: 'acc-1', name: 'Me' }; },
      myTickets: async () => tickets,
      ticket: async (id) => ticket({ id }),
      comments: async () => [],
    };
  };
  return { calls, makeJira };
}

const asanaTask = (gid: string, name: string): AsanaTask => ({
  gid, name, modified_at: '2026-10-01T00:00:00Z',
  memberships: [{ project: { gid: '9', name: 'Acme web' }, section: { gid: '8', name: 'Backlog' } }],
  custom_fields: [{ name: 'Website', display_value: 'AC' }, { name: 'Status', display_value: 'In progress' }],
});

function fakeAsana(tasks: AsanaTask[]) {
  const tokens: string[] = [];
  const makeAsana = (token: string) => {
    tokens.push(token);
    return {
      getMe: async () => ({ gid: '42', name: 'Me', workspaces: [{ gid: '111', name: 'Acme' }] }),
      getMyTasks: async () => tasks,
      getTask: async (gid: string) => asanaTask(gid, 'parent'),
      getComments: async () => [],
    };
  };
  return { tokens, makeAsana };
}

async function jiraHub(members = ['me', 'pm']) {
  const h = await hubWithRemote(members);
  const setup = h.person('setup');
  writeWorkflow(setup.hubDir, JIRA_WF);
  h.git(['-C', setup.hubDir, 'add', 'config/workflow.yml']);
  h.git(['-C', setup.hubDir, 'commit', '-q', '-m', 'chore: workflow']);
  h.git(['-C', setup.hubDir, 'push', '-q', 'origin', 'main']);
  return h;
}

function machine(root: string, who: string, extra: Record<string, string> = {}) {
  const home = join(root, `home-${who}`);
  mkdirSync(home, { recursive: true });
  return {
    home,
    cfg: join(home, 'cfg'),
    hub: join(home, 'hub'),
    env: { ...process.env, HOME: home, RIXFLOW_DIR: join(home, 'hub'), RIXFLOW_CONFIG_DIR: join(home, 'cfg'), ...extra } as NodeJS.ProcessEnv,
  };
}

const deps = (over: Partial<WizardDeps>): WizardDeps => ({
  cliPath: join(__dirname, '..', '..', '..', 'plugin', 'dist', 'hub.cjs'),
  tokenExec: noKeychain,
  runGit: async () => ({ ok: false, stdout: '' }),
  now: () => new Date('2026-10-08T10:00:00Z'),
  ...over,
});

describe('runJoin', () => {
  it('joining a legacy Asana hub writes the same config.yml as today', async () => {
    const h = await hubWithRemote();
    const m = machine(h.root, 'me');
    const projects = join(m.home, 'projects');
    const a = fakeAsana([asanaTask('1001', 'Acme homepage')]);
    const io = scriptedIo([h.remote, '1', projects, 'tok-asana-1', 'y', 'n']);
    await runJoin(io, deps({ makeAsana: a.makeAsana }), m.env);
    expect(readFileSync(join(m.cfg, 'config.yml'), 'utf8')).toBe(YAML.stringify({
      name: 'me', role: 'dev', projectsRoot: projects, asanaWorkspace: '111', siteFolders: {}, taskSites: {},
    }));
    expect(a.tokens).toEqual(['tok-asana-1']);
    expect(readFileSync(join(m.cfg, 'asana-token'), 'utf8')).toBe('tok-asana-1');
    expect(existsSync(join(m.hub, '.git', 'hooks', 'pre-commit'))).toBe(true);
    expect(existsSync(join(m.cfg, 'setup-progress.json'))).toBe(false);
    const out = io.logs.join('\n');
    expect(out).toContain('1001');
    expect(out).toContain('Acme homepage');
    expect(out).toContain('AC');
    expect(out).not.toContain('tok-asana-1');
  });

  it('joining a Jira hub stores jiraEmail and a jira token', async () => {
    const h = await jiraHub();
    const m = machine(h.root, 'me');
    const j = fakeJira([ticket({}), ticket({ id: 'OPS-7', title: 'Rotate certs', containers: ['OPS'], status: 'To Do' })]);
    const io = scriptedIo([h.remote, '1', join(m.home, 'p'), 'me@example.com', 'jira-tok-1', 'y', 'n']);
    await runJoin(io, deps({ makeJira: j.makeJira }), m.env);
    const cfg = YAML.parse(readFileSync(join(m.cfg, 'config.yml'), 'utf8'));
    expect(cfg.jiraEmail).toBe('me@example.com');
    expect(cfg.asanaWorkspace).toBeUndefined();
    expect(readFileSync(join(m.cfg, 'jira-token'), 'utf8')).toBe('jira-tok-1');
    expect(existsSync(join(m.cfg, 'asana-token'))).toBe(false);
    expect(j.calls[0]).toEqual({ url: 'https://acme.atlassian.net', auth: { flavor: 'cloud', email: 'me@example.com', token: 'jira-tok-1' }, projects: ['WEB', 'OPS'] });
    const out = io.logs.join('\n');
    expect(out).toMatch(/WEB-1.*Fix the login page.*AC.*in progress/);
    expect(out).toMatch(/OPS-7.*Rotate certs.*no project.*to do/);
    expect(out).not.toContain('jira-tok-1');
    expect(io.asked.some((q) => /Jira API token/.test(q))).toBe(true);
  });

  it('two joiners end with identical team answers and none in config.yml (anti-goal 3)', async () => {
    const h = await jiraHub();
    const results = [];
    for (const [who, n] of [['me', '1'], ['pm', '2']] as const) {
      const m = machine(h.root, who);
      const j = fakeJira([ticket({})]);
      await runJoin(scriptedIo([h.remote, n, join(m.home, 'p'), `${who}@example.com`, `tok-${who}`, 'y', 'n']), deps({ makeJira: j.makeJira }), m.env);
      const text = readFileSync(join(m.cfg, 'config.yml'), 'utf8');
      const cfg = YAML.parse(text);
      expect(Object.keys(cfg).sort()).toEqual(['jiraEmail', 'name', 'projectsRoot', 'role', 'siteFolders', 'taskSites']);
      expect(cfg.siteFolders).toEqual({});
      expect(cfg.taskSites).toEqual({});
      for (const team of ['atlassian', 'WEB', 'OPS', 'In Progress', 'Highest', 'tracker', 'workflow']) expect(text).not.toContain(team);
      results.push(loadWorkflow(m.hub));
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual(JIRA_WF);
  });

  it('join warns when the account sees no tickets', async () => {
    const h = await jiraHub();
    const m = machine(h.root, 'me');
    const j = fakeJira([]);
    const io = scriptedIo([h.remote, '1', join(m.home, 'p'), 'me@example.com', 'tok-x', 'n']);
    await runJoin(io, deps({ makeJira: j.makeJira }), m.env);
    expect(io.logs).toContain(
      "Your account can't see any open tickets in WEB, OPS. Check that you have access to those projects in Jira, then run setup again.",
    );
    expect(io.asked.some((q) => /look right/.test(q))).toBe(false);
  });

  it('explains a rejected login in plain words and asks again, never echoing the token', async () => {
    const h = await jiraHub();
    const m = machine(h.root, 'me');
    const j = fakeJira([ticket({})], 'JIRA_AUTH');
    const io = scriptedIo([h.remote, '1', join(m.home, 'p'), 'me@example.com', 'bad-tok', '', 'good-tok', 'y', 'n']);
    await runJoin(io, deps({ makeJira: j.makeJira }), m.env);
    const out = io.logs.join('\n');
    expect(out).toMatch(/Jira did not accept/);
    expect(out).not.toContain('bad-tok');
    expect(out).not.toContain('good-tok');
    expect(out).not.toContain('raw error');
    expect(readFileSync(join(m.cfg, 'jira-token'), 'utf8')).toBe('good-tok');
  });

  it('explains a network failure and stops after three tries without storing anything', async () => {
    const h = await jiraHub();
    const m = machine(h.root, 'me');
    const makeJira: WizardDeps['makeJira'] = () => ({
      kind: 'jira', label: 'Jira', normalizeId: (s) => s,
      whoAmI: async () => { throw new HubError('JIRA_NETWORK', 'x'); },
      myTickets: async () => [], ticket: async () => ticket({}), comments: async () => [],
    });
    const io = scriptedIo([h.remote, '1', join(m.home, 'p'), 'me@example.com', 't1', '', 't2', '', 't3']);
    await expect(runJoin(io, deps({ makeJira }), m.env)).rejects.toMatchObject({ code: 'CONNECT_FAILED' });
    expect(io.logs.join('\n')).toContain('Could not reach Jira at https://acme.atlassian.net');
    expect(existsSync(join(m.cfg, 'jira-token'))).toBe(false);
    expect(existsSync(join(m.cfg, 'config.yml'))).toBe(false);
  });

  it('refuses a public hub URL and names what to do', async () => {
    const h = await hubWithRemote();
    const m = machine(h.root, 'me');
    const io = scriptedIo(['git@github.com:acme/hub.git']);
    const err = await runJoin(io, deps({ runGit: async () => ({ ok: true, stdout: '' }) }), m.env).catch((e) => e);
    expect(err).toBeInstanceOf(HubError);
    expect(err.code).toBe('PUBLIC_HUB');
    expect(err.message).toMatch(/make the repository private, or use a private one/i);
    expect(existsSync(m.hub)).toBe(false);
  });

  it('a public hub with RIXFLOW_ALLOW_PUBLIC_HUB=1 still prints a warning', async () => {
    const h = await hubWithRemote();
    const m = machine(h.root, 'me', { RIXFLOW_ALLOW_PUBLIC_HUB: '1', GIT_TERMINAL_PROMPT: '0' });
    const io = scriptedIo(['https://example.invalid/acme/hub.git']);
    await expect(runJoin(io, deps({ runGit: async () => ({ ok: true, stdout: '' }) }), m.env)).rejects.toThrow();
    expect(io.logs.join('\n')).toMatch(/WARNING: .*public/);
  });

  it('explains how to get added when the name is not on the team list', async () => {
    const h = await hubWithRemote();
    const m = machine(h.root, 'me');
    const io = scriptedIo([h.remote, '3']);
    await expect(runJoin(io, deps({}), m.env)).rejects.toThrow(
      `You're not on this team's list yet. Ask anyone on the team to add you (they run setup and choose "change team setup"), then run setup again.`,
    );
    expect(io.logs.join('\n')).toMatch(/1\) me \(dev\)\n\s+2\) pm \(pm\)/);
  });

  it('resumes after an interrupted connect step without asking for the hub again', async () => {
    const h = await jiraHub();
    const m = machine(h.root, 'me');
    const j = fakeJira([ticket({})]);
    const first = scriptedIo([h.remote, '1', join(m.home, 'p')]);
    await expect(runJoin(first, deps({ makeJira: j.makeJira }), m.env)).rejects.toMatchObject({ code: 'ABORTED' });
    const progress = readFileSync(join(m.cfg, 'setup-progress.json'), 'utf8');
    expect(progress).not.toContain('@');
    const second = scriptedIo(['y', 'me@example.com', 'tok-2', 'y', 'n']);
    await runJoin(second, deps({ makeJira: j.makeJira }), m.env);
    expect(second.asked.some((q) => /Hub git URL/.test(q))).toBe(false);
    expect(YAML.parse(readFileSync(join(m.cfg, 'config.yml'), 'utf8')).name).toBe('me');
  });
});
