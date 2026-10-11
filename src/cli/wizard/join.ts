import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configDir as getConfigDir, homeDir, hubDir as getHubDir, loadUserConfig, normalizeDir, saveUserConfig } from '../../core/config';
import { Git } from '../../core/git';
import { isPublicRepo } from '../../core/repo';
import { describeSync, persistHub } from '../../core/runtime';
import { loadTeam } from '../../core/team';
import { mergeHubGitignore } from '../../core/template';
import { HubError, type UserConfig } from '../../core/types';
import { loadWorkflow } from '../../core/workflow';
import { applyClaudeSettings, installPreCommit, withAccessHint, type InitIo } from '../init';
import { connect, previewTickets, storedSource, type Connection, type WizardDeps } from './connect';
import { runSteps } from './progress';
import { askValid, choose, confirm } from './prompts';

export type { WizardDeps } from './connect';

export const NOT_ON_TEAM =
  `You're not on this team's list yet. Ask anyone on the team to add you (they run setup and choose "change team setup"), then run setup again.`;
export const PUBLIC_HUB =
  'This hub repository is public: anyone on the internet can read it. Make the repository private, or use a private one, then run setup again.';
const PUBLIC_OVERRIDE = 'WARNING: this hub repository is public, so anyone can read what your team saves. Continuing only because RIXFLOW_ALLOW_PUBLIC_HUB=1 is set.';
const MAPPING_HINT =
  'If projects or statuses look wrong, the team mapping needs fixing, not your setup. Anyone on the team can redo it: run setup and choose "change team setup".';
const NOT_LISTED = '-';

// A URL safe to print: any user name / password in a URL-style address is dropped.
export function withoutLogin(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}

// Refuses a hub anyone can read (anti-goal 1). RIXFLOW_ALLOW_PUBLIC_HUB=1 overrides, with a warning.
export async function refusePublicHub(io: InitIo, url: string, deps: WizardDeps, env: NodeJS.ProcessEnv): Promise<void> {
  if (!(await isPublicRepo(url, deps.runGit))) return;
  if (env.RIXFLOW_ALLOW_PUBLIC_HUB !== '1') throw new HubError('PUBLIC_HUB', PUBLIC_HUB);
  io.log(PUBLIC_OVERRIDE);
}

// Join an existing team: clone the hub, pick your name, connect your own ticket account and
// preview your plate. Team answers (workflow, mapping, projects) are read from the hub only;
// config.yml gets machine facts: name, role, projects folder, jiraEmail, workspace if legacy.
export async function runJoin(io: InitIo, deps: WizardDeps, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configDir = getConfigDir(env);
  const hubDir = getHubDir(env);
  let connection: Connection | undefined;

  const member = (name: unknown) => {
    const m = loadTeam(hubDir).find((x) => x.name === name);
    if (!m) throw new HubError('UNKNOWN_MEMBER', NOT_ON_TEAM);
    return m;
  };

  await runSteps(io, configDir, 'join', [
    {
      id: 'hub-url',
      async run() {
        if (existsSync(join(hubDir, '.git'))) {
          const origin = (await new Git(hubDir, env).tryRun(['remote', 'get-url', 'origin'])).out.trim();
          io.log(`Using the team hub already on this machine (${origin ? withoutLogin(origin) : hubDir}).`);
          if (origin) {
            await refusePublicHub(io, origin, deps, env);
            await withAccessHint(io, () => new Git(hubDir, env).run(['pull', '-q', '--rebase']));
          }
        } else {
          const url = await askValid(io, 'Hub git URL (e.g. git@github.com:org/rixflow-hub.git):',
            (s) => (s && !s.startsWith('-') ? null : 'Please paste the git URL of the team hub (ask a teammate for it).'));
          await refusePublicHub(io, url, deps, env);
          // The only git call allowed to prompt: setup runs in a terminal the user is watching.
          await withAccessHint(io, () => new Git(homeDir(env), env, { interactive: true }).run(['clone', '-q', '--', url, hubDir]));
        }
        loadWorkflow(hubDir); // fails early on a hub this version cannot read
        return {};
      },
    },
    {
      id: 'name',
      async run() {
        const team = loadTeam(hubDir);
        const options = [
          ...team.map((m) => ({ value: m.name, label: `${m.name} (${m.role})` })),
          { value: NOT_LISTED, label: "I'm not on this list" },
        ];
        const name = await choose(io, 'Which one are you?', options);
        if (name === NOT_LISTED) throw new HubError('UNKNOWN_MEMBER', NOT_ON_TEAM);
        return { name };
      },
    },
    {
      id: 'projects-root',
      async run() {
        const fallback = join(homeDir(env), 'projects');
        const dir = await askValid(io, 'Projects folder (where your project folders live):', (s) => (s ? null : 'Please enter a folder.'), fallback);
        return { projectsRoot: normalizeDir(dir, env) };
      },
    },
    {
      id: 'connect',
      async run(a) {
        const name = String(a.name);
        const m = member(name);
        const wf = loadWorkflow(hubDir);
        connection = await connect(io, deps, wf, { name, configDir });
        const cfg: UserConfig = {
          name, role: m.role, projectsRoot: String(a.projectsRoot),
          ...(connection.asanaWorkspace ? { asanaWorkspace: connection.asanaWorkspace } : {}),
          ...(connection.jiraEmail ? { jiraEmail: connection.jiraEmail } : {}),
          siteFolders: {}, taskSites: {},
        };
        saveUserConfig(configDir, cfg);
        return {};
      },
    },
    {
      id: 'preview',
      async run() {
        const wf = loadWorkflow(hubDir);
        const source = connection?.source ?? storedSource(deps, wf, { ...loadUserConfig(configDir, env), configDir }, env);
        if (!source) {
          io.log('Skipping the ticket preview: no stored login was found. Your plate will show your tickets once you are connected.');
          return {};
        }
        let shown = 0;
        try {
          shown = await previewTickets(io, source, wf, (deps.now ?? (() => new Date()))(), { mine: true });
        } catch (e) {
          io.log(`Could not load your tickets for a preview (${e instanceof Error ? e.message : String(e)}). Your setup is saved; the plate will try again.`);
          return {};
        }
        if (shown > 0 && !(await confirm(io, 'Do these look right?', true))) io.log(MAPPING_HINT);
        return {};
      },
    },
    {
      id: 'hub-hooks',
      async run(a) {
        const name = String(a.name);
        for (const msg of installPreCommit(hubDir, configDir, deps.cliPath)) io.log(msg);
        // Hubs bootstrapped before the .gitignore existed get it now, committed as this user.
        if (mergeHubGitignore(hubDir)) {
          const res = await persistHub(hubDir, name, `chore: ignore editor files in the hub (${name})`, {}, env);
          io.log(`Added editor files (.obsidian/, .DS_Store, ...) to the hub .gitignore: ${describeSync(res)}.`);
        }
        return {};
      },
    },
    {
      id: 'claude-settings',
      async run() {
        await applyClaudeSettings(io, join(homeDir(env), '.claude', 'settings.json'), hubDir);
        return {};
      },
    },
  ]);
  io.log(`Done. Hub: ${hubDir}. Config: ${configDir}.`);
}
