import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AsanaClient } from './asana';
import { Git, NO_REMOTE_DETAIL, commitAll, commitConfig, detailLine, ownedPaths, pendingCount, sync, type SyncResult } from './git';
import { acquireLock } from './lock';
import { mergeHubGitignore } from './template';
import { asanaSource } from './tickets/asana';
import { JiraClient } from './tickets/jira';
import type { TicketSource } from './tickets/types';
import { getToken } from './token';
import type { Ctx } from './types';
import { loadWorkflow, type Workflow } from './workflow';

// The ticket source for the hub's workflow, or null when it cannot be built (no workspace, no
// token, or no Jira Cloud email). Throws BAD_CONFIG for an invalid workflow.yml.
export function makeSource(
  ctx: Ctx,
  env: Record<string, string | undefined> = process.env,
  wf: Workflow = loadWorkflow(ctx.hubDir),
): TicketSource | null {
  if (wf.tracker.type === 'jira') {
    const { url, flavor, projects } = wf.tracker;
    const token = getToken(ctx.configDir, env, undefined, ctx.user.name, 'jira');
    if (!token) return null;
    if (flavor === 'server') return new JiraClient(url, { flavor, token }, { projects });
    const email = ctx.user.jiraEmail;
    return email ? new JiraClient(url, { flavor, email, token }, { projects }) : null;
  }
  const workspace = wf.tracker.workspace ?? ctx.user.asanaWorkspace;
  if (!workspace) return null;
  const token = getToken(ctx.configDir, env, undefined, ctx.user.name);
  if (!token) return null;
  return asanaSource(new AsanaClient(token), {
    workspace,
    statusField: wf.status.field ?? undefined,
    priorityField: wf.urgent.field ?? undefined,
  });
}

export const TOOL_LOCK_WAIT_MS = 3_000;

export interface PersistOptions {
  // How long to wait for another RixFlow process to release the hub lock (0: try once).
  waitMs?: number;
  // Backoff sleep between push retries (tests pass a no-op).
  sleep?: (ms: number) => Promise<void>;
}

const LOCKED: SyncResult = { status: 'locked', detail: 'another RixFlow process is syncing the hub', pending: 0, conflicts: [] };

function errorDetail(e: unknown): string {
  const stderr = (e as { stderr?: unknown })?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) return detailLine(stderr);
  return detailLine(e instanceof Error ? e.message : String(e));
}

// Commits the user's own paths and syncs, holding the hub lock throughout. Never throws: a failed
// commit, unmerged files or a failed rebase come back as status 'blocked'. The caller's file write
// has already happened, so a 'locked' result must not be retried by writing again.
export async function persistHub(
  hubDir: string,
  user: string,
  message: string,
  opts: PersistOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SyncResult> {
  return commitAndSync(hubDir, user, opts, env, async (git) => {
    // Old clones get the editor-file ignores without re-running init.
    mergeHubGitignore(hubDir);
    await commitAll(git, message, ownedPaths(user));
  });
}

// A team setup change from the wizard menu: one commit of config/ only, then the same sync and
// guarantees as persistHub (lock held throughout, never throws).
export async function persistConfig(
  ctx: Ctx, message: string, opts: PersistOptions = {}, env: NodeJS.ProcessEnv = process.env,
): Promise<SyncResult> {
  return commitAndSync(ctx.hubDir, ctx.user.name, opts, env, (git) => commitConfig(git, message));
}

async function commitAndSync(
  hubDir: string, user: string, opts: PersistOptions, env: NodeJS.ProcessEnv, commit: (git: Git) => Promise<unknown>,
): Promise<SyncResult> {
  if (!existsSync(join(hubDir, '.git'))) return { status: 'blocked', detail: 'hub is not a git repo', pending: 0, conflicts: [] };
  let release: (() => void) | null;
  try {
    release = await acquireLock(hubDir, opts.waitMs ?? TOOL_LOCK_WAIT_MS);
  } catch (e) {
    return { status: 'blocked', detail: errorDetail(e), pending: 0, conflicts: [] };
  }
  if (!release) return { ...LOCKED };
  const git = new Git(hubDir, env);
  try {
    await commit(git);
    return await sync(git, user, { sleep: opts.sleep, holdsLock: true });
  } catch (e) {
    const pending = await pendingCount(git).catch(() => 0);
    return { status: 'blocked', detail: errorDetail(e), pending, conflicts: [] };
  } finally {
    release();
  }
}

// For hooks: null when the hub is not set up; never waits for the lock (a held lock means
// another process is syncing right now, so this one skips and reports nothing).
export async function syncHub(ctx: Ctx): Promise<SyncResult | null> {
  if (!existsSync(join(ctx.hubDir, '.git'))) return null;
  return persistHub(ctx.hubDir, ctx.user.name, `sync: ${ctx.user.name}`, { waitMs: 0 });
}

// For MCP tools, the CLI and the summarizer: waits up to TOOL_LOCK_WAIT_MS for the lock.
export async function persist(ctx: Ctx, message: string, opts: PersistOptions = {}): Promise<SyncResult> {
  return persistHub(ctx.hubDir, ctx.user.name, message, opts);
}

// The text shown in tool results. Never says "synced" unless the push went through or
// nothing was pending.
export function describeSync(r: SyncResult): string {
  switch (r.status) {
    case 'ok':
      return r.conflicts.length ? `synced (${r.conflicts.length} conflict copies kept)` : 'synced';
    case 'offline':
      if (r.detail === NO_REMOTE_DETAIL) return 'saved locally (hub has no remote; nothing is shared)';
      return `saved locally (hub offline, ${r.pending} pending)`;
    case 'rejected':
      return `saved locally (push rejected, ${r.pending} pending${r.detail ? `: ${r.detail}` : ''})`;
    case 'locked':
      return 'saved locally, will sync on next action';
    default:
      return `saved locally (sync failing: ${r.detail || 'unknown error'})`;
  }
}
