import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { isMapping, loadSites, loadTeam, saveSites, saveTeam } from '../../core/team';
import { describeSync, persistConfig } from '../../core/runtime';
import { isSafeFolder } from '../../core/template';
import type { Discovery, Ticket, TicketSource, TrackerKind } from '../../core/tickets/types';
import { deleteLegacyToken, deleteToken, tokenEnvVar } from '../../core/token';
import { HubError, assertName, type Ctx, type Role } from '../../core/types';
import { WORKFLOW_REQUIRES } from '../../core/version';
import { jiraUrlChanged, loadWorkflow, writeWorkflow, type Workflow } from '../../core/workflow';
import type { InitIo } from '../init';
import { connect, scopeLabel, storedSource, type Connection, type WizardDeps } from './connect';
import { mappingAnswers, mappingSteps, slug, workflowOf } from './create';
import { runStepsFrom } from './progress';
import { askValid, choose, confirm } from './prompts';

type Action = 'add-member' | 'remove-member' | 'add-project' | 'change-project' | 'mapping' | 'reconnect' | 'start-over' | 'exit';
type Source = TicketSource & Discovery;

// Spec §7.5: removing a project and switching ticket systems are deliberately not offered.
const ACTIONS: Array<{ value: Action; label: string }> = [
  { value: 'add-member', label: 'Add a teammate' },
  { value: 'remove-member', label: 'Remove a teammate' },
  { value: 'add-project', label: 'Add a project' },
  { value: 'change-project', label: 'Rename or move a project' },
  { value: 'mapping', label: 'Redo the ticket mapping' },
  { value: 'reconnect', label: 'Reconnect my ticket account' },
  { value: 'start-over', label: 'Start over on this machine' },
  { value: 'exit', label: 'Exit' },
];
const NO_HUB_ACTIONS = ACTIONS.filter((a) => a.value === 'start-over' || a.value === 'exit');

const SITE = /^[A-Z0-9]{1,10}$/;
const SAMPLE_COUNT = 50;
const KINDS: TrackerKind[] = ['asana', 'jira'];
const MACHINE_FILES = ['setup-progress.json', 'status-cache.json', 'config.yml'];

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
const validName = (s: string) => (clean(s).length <= 60 ? null : 'Please keep the name under 60 characters.');
const validFolder = (s: string) => (isSafeFolder(s) ? null : 'Please use one folder name: letters, digits, dots, dashes or underscores, no slashes.');

// The first screen on a machine that is already set up: change the team's setup (one config/
// commit per change, synced like any other write), reconnect this person's ticket account, or
// reset this machine. Loops until Exit; a HubError inside an action is shown and the menu returns.
export async function runMenu(io: InitIo, deps: WizardDeps, ctx: Ctx, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const hub = existsSync(join(ctx.hubDir, '.git'));
  io.log(`This machine is set up for ${ctx.user.name}.`);
  if (!hub) {
    io.log(`The team hub is not on this machine (${ctx.hubDir}). Choose "Start over on this machine", then run setup again to join the team.`);
  }
  const user = ctx.user.name;

  // Each team change starts from the hub's latest config/ and ends as one commit of it.
  const refresh = () => persistConfig(ctx, `chore: update team setup (${user})`, {}, env);
  const save = async (what: string, done: string) => {
    const res = await persistConfig(ctx, `chore: ${what} (${user})`, {}, env);
    io.log(`${done}: ${describeSync(res)}.`);
  };

  const actions: Record<Exclude<Action, 'exit' | 'start-over'>, () => Promise<void>> = {
    async 'add-member'() {
      await refresh();
      const team = loadTeam(ctx.hubDir);
      const name = await askValid(io, "Teammate's name (lower-case letters, digits and dashes, e.g. sam):", (s) => {
        try { assertName(s); } catch { return 'Please use lower-case letters, digits and dashes, starting with a letter or digit.'; }
        return team.some((m) => m.name === s) ? `${s} is already on the team.` : null;
      });
      const role = await choose<Role>(io, `${name}'s role:`, [
        { value: 'dev', label: 'dev (works on tickets)' },
        { value: 'pm', label: 'pm (plans and hands out tickets)' },
      ]);
      saveTeam(ctx.hubDir, [...team, { name, role }]);
      await save(`add teammate ${name}`, `Added ${name} to the team`);
    },
    async 'remove-member'() {
      await refresh();
      const team = loadTeam(ctx.hubDir);
      const others = team.filter((m) => m.name !== user);
      if (others.length === 0) { io.log('Nobody else is on the team.'); return; }
      const name = await choose(io, 'Who should come off the team list?', others.map((m) => ({ value: m.name, label: `${m.name} (${m.role})` })));
      if (!(await confirm(io, `Take ${name} off the team list? Their notes and messages stay in the hub.`, false))) return;
      saveTeam(ctx.hubDir, team.filter((m) => m.name !== name));
      await save(`remove teammate ${name}`, `Took ${name} off the team list`);
    },
    async 'add-project'() {
      await refresh();
      const sites = loadSites(ctx.hubDir);
      const code = (await askValid(io, 'Short code for the project (1 to 10 capital letters or digits, e.g. AC):', (s) => {
        const c = s.toUpperCase();
        if (!SITE.test(c)) return 'Please use 1 to 10 capital letters or digits.';
        return Object.hasOwn(sites, c) ? `${c} is already a project.` : null;
      })).toUpperCase();
      const name = clean(await askValid(io, `Name of project ${code} (optional, e.g. Acme site):`, validName));
      const folder = await askValid(io, `Folder for project ${code} (inside each person's projects folder):`, validFolder, slug(name) || code.toLowerCase());
      saveSites(ctx.hubDir, { ...sites, [code]: { ...(name ? { name } : {}), folder } });
      await save(`add project ${code}`, `Added project ${code}`);
      if (!loadWorkflow(ctx.hubDir).legacy) io.log(`To have tickets show under ${code}, choose "Redo the ticket mapping" and give a ticket value the code ${code}.`);
    },
    async 'change-project'() {
      await refresh();
      const sites = loadSites(ctx.hubDir);
      const codes = Object.keys(sites);
      if (codes.length === 0) { io.log('The team has no projects yet. Choose "Add a project" first.'); return; }
      const code = await choose(io, 'Which project?', codes.map((c) => ({
        value: c, label: `${c}${sites[c].name ? ` ${clean(sites[c].name as string)}` : ''} (folder ${sites[c].folder})`,
      })));
      const site = sites[code];
      io.log(`The short code (${code}) can't change: it's part of saved notes and links.`);
      const name = clean(await askValid(io, `Name of project ${code}:`, validName, site.name));
      const folder = await askValid(io, `Folder for project ${code}:`, validFolder, site.folder);
      if (name === (site.name ?? '') && folder === site.folder) { io.log('Nothing changed.'); return; }
      const { name: _old, ...rest } = site;
      saveSites(ctx.hubDir, { ...sites, [code]: { ...(name ? { name } : {}), ...rest, folder } });
      await save(`change project ${code}`, `Saved project ${code}`);
    },
    async mapping() {
      await refresh();
      if (!existsSync(join(ctx.hubDir, 'config', 'workflow.yml'))) {
        io.log(`Everyone on the team must update to RixFlow ${WORKFLOW_REQUIRES} first. Older copies will ignore these settings.`);
        if (!(await confirm(io, 'Continue?', false))) return;
      }
      const current = loadWorkflow(ctx.hubDir);
      const wf = await redoMapping(io, deps, ctx, current, env);
      const sites = await foldersForNewCodes(io, loadSites(ctx.hubDir), wf);
      writeWorkflow(ctx.hubDir, wf);
      if (sites) saveSites(ctx.hubDir, sites);
      await save('redo the ticket mapping', 'Saved the ticket mapping');
    },
    async reconnect() {
      const wf = loadWorkflow(ctx.hubDir);
      if (wf.tracker.type === 'jira' && jiraUrlChanged(wf, ctx.user)) {
        io.log(`The team's Jira address is ${clean(wf.tracker.url)}${ctx.user.jiraUrl ? ` (this machine used ${clean(ctx.user.jiraUrl)})` : ''}. Sign in only if you trust that address.`);
      }
      const conn = await connect(io, deps, wf, { name: user, configDir: ctx.configDir });
      updateMachineConfig(ctx.configDir, machineFacts(conn));
    },
  };

  for (;;) {
    const action = await choose(io, 'What would you like to do?', hub ? ACTIONS : NO_HUB_ACTIONS);
    if (action === 'exit') return;
    if (action === 'start-over') {
      if (await startOver(io, deps, ctx.configDir, ctx.user.name, env)) return;
      continue;
    }
    try {
      await actions[action]();
    } catch (e) {
      if (!(e instanceof HubError) || e.code === 'ABORTED') throw e;
      io.log(e.message);
    }
  }
}

// Steps 3-7 of Create, pre-filled from the current workflow. The tracker and its scope never change.
async function redoMapping(io: InitIo, deps: WizardDeps, ctx: Ctx, current: Workflow, env: NodeJS.ProcessEnv): Promise<Workflow> {
  const user = {
    name: ctx.user.name, configDir: ctx.configDir, jiraEmail: ctx.user.jiraEmail, jiraUrl: ctx.user.jiraUrl, asanaWorkspace: ctx.user.asanaWorkspace,
  };
  let src: Source | undefined;
  let cached: Ticket[] | undefined;
  const source = async (): Promise<Source> => {
    if (src) return src;
    const stored = storedSource(deps, current, user, env);
    if (stored) src = stored as Source;
    else {
      io.log(current.tracker.type === 'jira' && jiraUrlChanged(current, user)
        ? `The team's Jira address is ${clean(current.tracker.url)}, not the one this machine connected to. Sign in again only if you trust that address.`
        : 'Your ticket login was not found on this machine; please sign in again.');
      const conn = await connect(io, deps, current, user);
      updateMachineConfig(ctx.configDir, machineFacts(conn));
      src = conn.source as Source;
    }
    return src;
  };
  const scope = current.tracker.type === 'jira' ? current.tracker.projects : [];
  const samples = async (): Promise<Ticket[]> => {
    cached ??= await (await source()).sample(scope, SAMPLE_COUNT);
    if (cached.length === 0) {
      throw new HubError('NO_TICKETS', `RixFlow found no open tickets in ${scopeLabel(current)} to learn from, so the mapping was not changed.`);
    }
    return cached;
  };
  const now = () => (deps.now ?? (() => new Date()))();
  return workflowOf(await runStepsFrom(mappingSteps(io, { source, samples, now }), mappingAnswers(current)));
}

// A redo can give tickets codes the team has no project for yet. Each new code gets a folder,
// as in Create, so its tickets open in a project folder and notes can name it. Codes no longer
// mapped stay in sites.yml: saved notes and links still use them. Returns null when nothing is new.
async function foldersForNewCodes(io: InitIo, sites: ReturnType<typeof loadSites>, wf: Workflow): Promise<ReturnType<typeof loadSites> | null> {
  const fresh = new Map<string, string>();
  for (const [value, code] of Object.entries(wf.project.values)) if (!Object.hasOwn(sites, code) && !fresh.has(code)) fresh.set(code, value);
  if (fresh.size === 0) return null;
  io.log("New projects need a folder inside each person's projects folder. Press Enter to keep the suggestion.");
  const out = { ...sites };
  for (const [code, value] of fresh) {
    out[code] = { folder: await askValid(io, `Folder for project ${code} (${clean(value)}):`, validFolder, slug(value) || code.toLowerCase()) };
  }
  return out;
}

// The machine facts a connect produced (jiraEmail, jiraUrl, asanaWorkspace), for config.yml.
function machineFacts(conn: Connection): Record<string, string> {
  return {
    ...(conn.jiraEmail ? { jiraEmail: conn.jiraEmail } : {}),
    ...(conn.jiraUrl ? { jiraUrl: conn.jiraUrl } : {}),
    ...(conn.asanaWorkspace ? { asanaWorkspace: conn.asanaWorkspace } : {}),
  };
}

// Machine facts from a reconnect (jiraEmail, jiraUrl, asanaWorkspace), merged into config.yml as written.
function updateMachineConfig(configDir: string, patch: Record<string, string>): void {
  if (Object.keys(patch).length === 0) return;
  const path = join(configDir, 'config.yml');
  const raw: unknown = YAML.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, YAML.stringify({ ...(isMapping(raw) ? raw : {}), ...patch }));
}

// Setup on a machine whose config.yml cannot be read: say which file and why, then offer only
// "Start over on this machine" or "Exit".
export async function runBrokenConfigMenu(
  io: InitIo, deps: WizardDeps, configDir: string, reason: string, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  io.log(`RixFlow can't read this machine's settings: ${clean(reason)}`);
  io.log('Fix the file by hand and run setup again, or start over on this machine.');
  for (;;) {
    const action = await choose(io, 'What would you like to do?', NO_HUB_ACTIONS);
    if (action === 'exit') return;
    if (await startOver(io, deps, configDir, nameIn(configDir), env)) return;
  }
}

// The person's name from a config.yml that does not parse, when a plain `name:` line still holds a
// valid one, so start over can remove that person's stored logins too.
function nameIn(configDir: string): string | undefined {
  try {
    const m = /^name:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(readFileSync(join(configDir, 'config.yml'), 'utf8'));
    if (!m) return undefined;
    assertName(m[1]);
    return m[1];
  } catch {
    return undefined;
  }
}

// Resets this machine only: config.yml, this user's tokens for every system (and 0.2.0's shared
// Asana login, which would otherwise still be found), the progress file
// and the status cache. The hub clone is never touched. Returns true when it ran.
async function startOver(io: InitIo, deps: WizardDeps, configDir: string, user: string | undefined, env: NodeJS.ProcessEnv): Promise<boolean> {
  io.log('Starting over removes RixFlow\'s setup from this machine: your settings and your stored ticket logins. The team hub is not changed.');
  if (!(await confirm(io, 'Start over on this machine?', false))) return false;
  if (user) for (const kind of KINDS) deleteToken(configDir, deps.tokenExec, user, kind);
  else {
    for (const kind of KINDS) rmSync(join(configDir, `${kind}-token`), { force: true });
    io.log('Your name could not be read from the settings, so a token stored in your keychain may remain. Remove the "rixflow" items from your keychain by hand if you want them gone.');
  }
  deleteLegacyToken(configDir, deps.tokenExec);
  for (const f of MACHINE_FILES) rmSync(join(configDir, f), { force: true });
  for (const kind of KINDS) {
    const v = tokenEnvVar(kind);
    if (env[v]) io.log(`${v} is set in your environment; RixFlow still uses it until you unset it.`);
  }
  io.log('This machine is reset. Run setup again to join or create a team.');
  return true;
}
