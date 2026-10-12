import { AsanaClient, type AsanaReader } from '../../core/asana';
import { BUCKET_LABEL, needsParents, mapTicket } from '../../core/mapping';
import type { Gh, RunGit } from '../../core/repo';
import { asanaSource } from '../../core/tickets/asana';
import { JiraClient, type JiraAuth } from '../../core/tickets/jira';
import { parentChain, type Discovery, type Ticket, type TicketSource } from '../../core/tickets/types';
import { getToken, setToken, type Exec } from '../../core/token';
import { HubError } from '../../core/types';
import type { Workflow } from '../../core/workflow';
import type { InitIo } from '../init';
import { askValid, choose } from './prompts';

type AsanaLike = AsanaReader & Pick<AsanaClient, 'getMe'>;

// Injection points for tests. The real clients are used when a factory is left out.
export interface WizardDeps {
  cliPath: string;
  runGit?: RunGit;
  gh?: Gh;
  makeAsana?: (token: string) => AsanaLike;
  makeJira?: (url: string, auth: JiraAuth, projects: string[]) => TicketSource;
  now?: () => Date;
  // Keychain access for setToken / getToken (tests pass one that always fails, so the 0600 file is used).
  tokenExec?: Exec;
}

export interface Connection {
  source: TicketSource;
  // Machine facts for config.yml. Never written to the progress file (an email is personal).
  jiraEmail?: string;
  asanaWorkspace?: string;
}

const MAX_TRIES = 3;

const makeAsana = (deps: WizardDeps, token: string): AsanaLike => (deps.makeAsana ?? ((t) => new AsanaClient(t)))(token);
const makeJira = (deps: WizardDeps, url: string, auth: JiraAuth, projects: string[]): TicketSource =>
  (deps.makeJira ?? ((u, a, p) => new JiraClient(u, a, { projects: p })))(url, auth, projects);

function asanaFrom(client: AsanaLike, wf: Workflow, workspace: string): TicketSource {
  return asanaSource(client, { workspace, statusField: wf.status.field ?? undefined, priorityField: wf.urgent.field ?? undefined });
}

export const BAD_URL =
  `The team's Jira address is not a valid https:// address. Ask a teammate to fix it: they run setup and choose "change team setup".`;

const isCode = (e: unknown, suffix: string): e is HubError => e instanceof HubError && e.code.endsWith(suffix);

function explain(e: unknown, wf: Workflow): string | null {
  const jira = wf.tracker.type === 'jira' ? wf.tracker : null;
  if (isCode(e, '_AUTH')) {
    if (!jira) return 'Asana did not accept that token. Check that you copied the whole personal access token, then try again.';
    return jira.flavor === 'cloud'
      ? 'Jira did not accept that email and API token. Check both (the email is the one you log in to Jira with), then try again.'
      : 'Jira did not accept that personal access token. Check that you copied all of it, then try again.';
  }
  if (isCode(e, '_NETWORK')) {
    return jira
      ? `Could not reach Jira at ${jira.url}. Check your network connection (and VPN, if your company needs one), then try again.`
      : 'Could not reach Asana. Check your network connection, then try again.';
  }
  return null;
}

async function askToken(io: InitIo, question: string): Promise<string> {
  if (io.closed) throw new HubError('ABORTED', 'Setup stopped. Run it again to continue where you left off.');
  const t = (await io.askHidden(question)).trim();
  if (io.closed && t === '') throw new HubError('ABORTED', 'Setup stopped. Run it again to continue where you left off.');
  return t;
}

const validEmail = (s: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? null : 'Please enter the email address you log in to Jira with.');

// Asks for this person's credentials for the team's ticket system, checks them with "who am I",
// then stores the token (keychain, else a 0600 file). The token is never printed or saved elsewhere.
export async function connect(io: InitIo, deps: WizardDeps, wf: Workflow, user: { name: string; configDir: string }): Promise<Connection> {
  const t = wf.tracker;
  let email: string | undefined;
  for (let i = 0; i < MAX_TRIES; i++) {
    let token: string;
    let conn: Connection;
    try {
      if (t.type === 'jira') {
        if (t.flavor === 'cloud') email = await askValid(io, 'Your Jira login email:', validEmail, email);
        token = await askToken(io, t.flavor === 'cloud'
          ? 'Jira API token (input hidden; create one at https://id.atlassian.com/manage-profile/security/api-tokens): '
          : 'Jira personal access token (input hidden; create one in Jira under Profile > Personal Access Tokens): ');
        if (!token) { io.log('No token entered.'); continue; }
        const auth: JiraAuth = t.flavor === 'cloud' ? { flavor: 'cloud', email: email as string, token } : { flavor: 'server', token };
        const source = makeJira(deps, t.url, auth, t.projects);
        await source.whoAmI();
        conn = t.flavor === 'cloud' ? { source, jiraEmail: email } : { source };
      } else {
        token = await askToken(io, 'Asana personal access token (input hidden): ');
        if (!token) { io.log('No token entered.'); continue; }
        const client = makeAsana(deps, token);
        const me = await client.getMe();
        let workspace = t.workspace;
        let own: string | undefined;
        if (!workspace) {
          if (me.workspaces.length === 0) throw new HubError('NO_WORKSPACE', 'Your Asana account has no workspace. Ask the team which workspace to join.');
          workspace = me.workspaces.length === 1
            ? me.workspaces[0].gid
            : await choose(io, 'Which Asana workspace does the team use?', me.workspaces.map((w) => ({ value: w.gid, label: w.name })));
          own = workspace;
        }
        conn = { source: asanaFrom(client, wf, workspace), ...(own ? { asanaWorkspace: own } : {}) };
      }
    } catch (e) {
      // A bad team URL will not get better by typing the token again.
      if (isCode(e, '_BAD_URL')) throw new HubError('JIRA_BAD_URL', BAD_URL);
      const why = explain(e, wf);
      if (why === null) throw e;
      io.log(why);
      continue;
    }
    const where = setToken(user.configDir, token, deps.tokenExec, user.name, t.type);
    io.log(`${conn.source.label} token stored in ${where === 'keychain' ? 'your keychain' : 'a private file in the config folder'}.`);
    return conn;
  }
  const label = t.type === 'jira' ? 'Jira' : 'Asana';
  throw new HubError('CONNECT_FAILED', `Could not connect to ${label} after ${MAX_TRIES} tries. Check your login and network, then run setup again.`);
}

// Rebuilds the source from what connect stored (config facts + token), for a resumed wizard.
export function storedSource(
  deps: WizardDeps, wf: Workflow, user: { name: string; configDir: string; jiraEmail?: string; asanaWorkspace?: string },
  env: Record<string, string | undefined> = process.env,
): TicketSource | null {
  const t = wf.tracker;
  const token = getToken(user.configDir, env, deps.tokenExec, user.name, t.type);
  if (!token) return null;
  if (t.type === 'jira') {
    if (t.flavor === 'server') return makeJira(deps, t.url, { flavor: 'server', token }, t.projects);
    return user.jiraEmail ? makeJira(deps, t.url, { flavor: 'cloud', email: user.jiraEmail, token }, t.projects) : null;
  }
  const workspace = t.workspace ?? user.asanaWorkspace;
  return workspace ? asanaFrom(makeAsana(deps, token), wf, workspace) : null;
}

const PREVIEW_COUNT = 5;
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

export function scopeLabel(wf: Workflow): string {
  if (wf.tracker.type === 'jira') return wf.tracker.projects.length ? wf.tracker.projects.join(', ') : 'this Jira site';
  return 'your Asana workspace';
}

// Shows up to 5 tickets as RixFlow will map them. Returns how many were shown.
export async function previewTickets(
  io: InitIo, source: TicketSource, wf: Workflow, now: Date, opts: { mine: boolean },
): Promise<number> {
  const scope = wf.tracker.type === 'jira' ? wf.tracker.projects : [];
  const all = opts.mine
    ? await source.myTickets()
    : await (source as TicketSource & Discovery).sample(scope, PREVIEW_COUNT);
  const tickets = all.slice(0, PREVIEW_COUNT);
  if (tickets.length === 0) {
    io.log(`Your account can't see any open tickets in ${scopeLabel(wf)}. Check that you have access to those projects in ${source.label}, then run setup again.`);
    return 0;
  }
  io.log(`${opts.mine ? 'Your next tickets' : 'Some tickets'} as RixFlow sees them:`);
  for (const t of tickets) {
    let chain: Ticket[] = [t];
    if (needsParents(t, wf)) chain = await parentChain(source, t).catch(() => [t]);
    const m = mapTicket(chain, wf, now);
    const project = m.codes.length ? `project ${m.codes.join(', ')}` : 'no project';
    const bucket = m.bucket ? BUCKET_LABEL[m.bucket] : `status "${clean(t.status ?? 'none')}" not mapped`;
    io.log(`  ${t.id}  ${clean(t.title)}  -> ${project}, ${bucket}, sprint: ${m.sprint ? 'yes' : 'no'}, urgent: ${m.urgent ? 'yes' : 'no'}`);
  }
  return tickets.length;
}
