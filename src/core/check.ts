import type { AsanaReader } from './asana';
import { hubCommand } from './command';
import { loadState, saveState } from './config';
import { NO_REMOTE_DETAIL, type SyncResult } from './git';
import { listInbox, type Message } from './messages';
import { scrub } from './scrub';
import { lastSummaryFailure } from './summarylog';
import type { CheckState, Ctx } from './types';

export const PROMPT_INTERVAL_MS = 300_000;

// Bounds for everything written to the hook output. Sync and Asana calls run concurrently and
// are cut off so a slow network cannot hang the user's prompt. The prompt hook gets a shorter budget.
const NOTIFIED_CAP = 500;
const PROMPT_TIMEOUT_MS = 2_000;
const SESSION_TIMEOUT_MS = 5_000;
const ITEM_MAX = 80;
// C0/C1 controls, zero-width and bidi-override characters, and Unicode line/paragraph separators.
const CONTROL_CHARS = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2028\\u2029\\u2066-\\u2069]',
  'g',
);

export interface CheckDeps {
  // A factory is called only after the prompt rate limit passes, so a rate-limited prompt never
  // spawns a keychain lookup.
  asana: AsanaReader | null | (() => AsanaReader | null);
  sync: () => Promise<SyncResult | null>;
}

// Makes one untrusted string safe to inject: one line, no control or bidi characters,
// scrubbed before it is cut (a cut credential URL would no longer match the scrubber).
export function clean(text: string): string {
  const oneLine = scrub(String(text).replace(CONTROL_CHARS, ' ')).replace(/\s+/g, ' ').trim();
  return oneLine.length > ITEM_MAX ? `${oneLine.slice(0, ITEM_MAX - 3)}...` : oneLine;
}

function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
}

// Only sender and type are shown; message bodies are never injected into Claude's context.
function describeMessages(messages: Message[]): string[] {
  const groups = new Map<string, { type: string; from: string; count: number }>();
  for (const m of messages) {
    const type = clean(m.type);
    const from = clean(m.from);
    const key = JSON.stringify([type, from]);
    const group = groups.get(key) ?? { type, from, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].map(
    ({ type, from, count }) => `${count} new ${type}${count > 1 ? 's' : ''} from ${from}`,
  );
}

// Rejected and blocked are always reported (prompt checks reach here at most once per
// PROMPT_INTERVAL_MS). Offline with pending commits is always reported. Offline with nothing pending,
// and a hub with no remote at all, are reported only at session start, at most once per calendar day.
// 'locked' means another process is syncing right now and is never reported.
function describeHealth(r: SyncResult | null, trigger: 'session' | 'prompt', state: CheckState, today: string): string | null {
  switch (r?.status) {
    case 'offline':
      if (r.detail === NO_REMOTE_DETAIL) {
        if (trigger !== 'session' || state.noRemoteNoticeDay === today) return null;
        state.noRemoteNoticeDay = today;
        return 'hub has no remote; nothing is shared';
      }
      if (r.pending > 0) return `hub offline, ${r.pending} pending`;
      if (trigger !== 'session' || state.offlineNoticeDay === today) return null;
      state.offlineNoticeDay = today;
      return 'hub offline, 0 pending';
    case 'rejected':
      return `hub push rejected, ${r.pending} pending`;
    case 'blocked':
      return `hub sync failing: ${clean(r.detail || 'unknown error')}`;
    default:
      return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function check(ctx: Ctx, deps: CheckDeps, trigger: 'session' | 'prompt'): Promise<string> {
  const state = loadState(ctx.configDir);
  const now = ctx.now();
  const elapsed = state.lastPromptCheck ? now.getTime() - Date.parse(state.lastPromptCheck) : NaN;
  if (trigger === 'prompt' && elapsed >= 0 && elapsed < PROMPT_INTERVAL_MS) return '';
  state.lastPromptCheck = now.toISOString();
  const parts: string[] = [];
  const budget = trigger === 'prompt' ? PROMPT_TIMEOUT_MS : SESSION_TIMEOUT_MS;

  // Asana and sync start together so their latency overlaps instead of adding up.
  const asana = typeof deps.asana === 'function' ? deps.asana() : deps.asana;
  const workspace = ctx.user.asanaWorkspace;
  const asanaFetch = asana && workspace ? withTimeout(() => asana.getMyTasks(workspace), budget) : null;
  // Handled here so a rejection during the sync wait is not reported as unhandled; it is still
  // awaited (and its error handled) further down.
  asanaFetch?.catch(() => undefined);
  const synced = await withTimeout(() => deps.sync(), budget).catch(() => null);

  let fresh: Message[] = [];
  try {
    fresh = listInbox(ctx, ['new']);
  } catch {
    fresh = [];
  }
  const notified = new Set(Array.isArray(state.notified) ? state.notified : []);
  const toReport = trigger === 'session' ? fresh : fresh.filter((m) => !notified.has(m.id));
  parts.push(...describeMessages(toReport));
  // Re-seen ids move to the end so the cap drops the oldest entries, not the newest.
  const freshIds = fresh.map((m) => m.id);
  const freshSet = new Set(freshIds);
  const previous = Array.isArray(state.notified) ? state.notified : [];
  state.notified = [...previous.filter((id) => !freshSet.has(id)), ...freshIds].slice(-NOTIFIED_CAP);

  if (!asana) {
    if (trigger === 'session') parts.push(`Asana token missing (run: ${hubCommand('token set')})`);
  } else if (asanaFetch) {
    try {
      const tasks = await asanaFetch;
      const seen: Record<string, unknown> = isRecord(state.seenTaskModified) ? state.seenTaskModified : {};
      const firstRun = Object.keys(seen).length === 0;
      const changed = tasks.filter((t) => typeof seen[t.gid] === 'string' && seen[t.gid] !== t.modified_at);
      // Only the tasks seen in this run are kept, so the map stays bounded.
      state.seenTaskModified = Object.fromEntries(tasks.map((t) => [t.gid, t.modified_at]));
      if (!firstRun && changed.length) {
        // Quotes in a name become apostrophes so the name cannot close its own quoting.
        const names = changed.slice(0, 3).map((t) => `"${clean(t.name).replace(/"/g, "'")}"`).join(', ');
        parts.push(`Asana updated: ${names}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}`);
      }
    } catch {
      if (trigger === 'session') parts.push('Asana unreachable');
    }
  }

  const health = describeHealth(synced, trigger, state, now.toISOString().slice(0, 10));
  if (health) parts.push(health);
  if (synced?.conflicts?.length) parts.push(`${synced.conflicts.length} conflict copies kept`);

  // A failed background summary is shown once, at the next session start.
  if (trigger === 'session') {
    const failure = lastSummaryFailure(ctx.configDir);
    if (failure && failure.at !== state.summaryFailureReported) {
      parts.push(`last summary failed: ${clean(failure.reason)}`);
      state.summaryFailureReported = failure.at;
    }
  }

  try {
    saveState(ctx.configDir, state);
  } catch {
    // An unwritable state dir only means a prompt may be repeated later.
  }
  return parts.length ? `[rixflow] ${parts.join(' · ')}` : '';
}

export async function runCheck(ctx: Ctx, deps: CheckDeps, trigger: 'session' | 'prompt'): Promise<string> {
  try {
    return await check(ctx, deps, trigger);
  } catch {
    // Hooks must never fail the user's prompt.
    return '';
  }
}
