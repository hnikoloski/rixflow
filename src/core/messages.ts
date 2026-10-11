import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { listMd, readDoc, writeDoc } from './hubfs';
import { newMessageId } from './ids';
import { loadTeam } from './team';
import { HubError, assertGid, assertMessageId, assertName, type Ctx } from './types';

export type MessageType = 'request' | 'question' | 'answer';
export type MessageStatus = 'new' | 'read' | 'done';

export interface Message {
  id: string;
  type: MessageType;
  from: string;
  to: string;
  task?: string;
  thread: string;
  status: MessageStatus;
  created: string;
  body: string;
  path: string;
}

const TYPES: readonly MessageType[] = ['request', 'question', 'answer'];
const STATUSES: readonly MessageStatus[] = ['new', 'read', 'done'];
const MAX_ID_ATTEMPTS = 20;

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

function passes(check: (v: unknown) => void, v: unknown): boolean {
  try {
    check(v);
    return true;
  } catch {
    return false;
  }
}

// Validates a message file; anything malformed throws HubError('BAD_MESSAGE').
function readMessage(path: string, owner: string): Message {
  const bad = (): never => {
    throw new HubError('BAD_MESSAGE', `malformed message: ${path}`);
  };
  let doc: { data: Record<string, unknown>; body: string };
  try {
    doc = readDoc(path);
  } catch {
    return bad();
  }
  const { data, body } = doc;
  const id = basename(path, '.md');
  const { type, from, to, created } = data;
  const status = data.status ?? 'new';
  const thread = data.thread ?? id;
  const task = data.task === undefined || data.task === null ? undefined : String(data.task);
  if (data.id !== id || !isOneOf(TYPES, type) || !isOneOf(STATUSES, status)) return bad();
  if (typeof from !== 'string' || !passes(assertName, from)) return bad();
  if (typeof to !== 'string' || to !== owner || !passes(assertName, to)) return bad();
  if (typeof created !== 'string' || Number.isNaN(Date.parse(created))) return bad();
  if (!passes(assertMessageId, id) || !passes(assertMessageId, String(thread))) return bad();
  if (task !== undefined && !passes(assertGid, task)) return bad();
  return { id, type, from, to, task, thread: String(thread), status, created, body, path };
}

// Reads every message in a folder, skipping files that fail validation.
function readAll(files: string[], owner: string): Message[] {
  const out: Message[] = [];
  for (const f of files) {
    try {
      out.push(readMessage(f, owner));
    } catch {
      // corrupt message: skip
    }
  }
  return out;
}

function inboxDir(ctx: Ctx, name: string): string {
  assertName(name);
  return join(ctx.hubDir, 'inbox', name);
}

function frontmatter(m: Omit<Message, 'body' | 'path'>): Record<string, unknown> {
  return {
    id: m.id, type: m.type, from: m.from, to: m.to, task: m.task,
    thread: m.thread, status: m.status, created: m.created,
  };
}

const byCreated = (a: Message, b: Message): number => a.created.localeCompare(b.created);

export function sendMessage(
  ctx: Ctx,
  input: { to: string; type: MessageType; body: string; task?: string; thread?: string },
): Message {
  assertName(ctx.user.name);
  assertName(input.to);
  if (!isOneOf(TYPES, input.type)) throw new HubError('BAD_TYPE', `invalid message type: ${String(input.type)}`);
  if (input.task !== undefined) assertGid(input.task);
  if (input.thread !== undefined) assertMessageId(input.thread);
  if (!loadTeam(ctx.hubDir).some((m) => m.name === input.to)) {
    throw new HubError('UNKNOWN_RECIPIENT', `${input.to} is not in config/team.yml`);
  }
  const dir = inboxDir(ctx, input.to);
  const created = ctx.now();
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = newMessageId(created);
    const path = join(dir, `${id}.md`);
    const meta = {
      id, type: input.type, from: ctx.user.name, to: input.to, task: input.task,
      thread: input.thread ?? id, status: 'new' as const, created: created.toISOString(),
    };
    try {
      // Exclusive create: a concurrent writer can never overwrite an existing message.
      writeDoc(path, frontmatter(meta), input.body, { exclusive: true });
      return readMessage(path, input.to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new HubError('ID_CONFLICT', 'could not allocate a unique message id');
}

export function listInbox(ctx: Ctx, statuses?: MessageStatus[]): Message[] {
  return readAll(listMd(inboxDir(ctx, ctx.user.name)), ctx.user.name)
    .filter((m) => !statuses || statuses.includes(m.status))
    .sort(byCreated);
}

export function setMessageStatus(ctx: Ctx, id: string, status: MessageStatus): Message {
  assertMessageId(id);
  if (!isOneOf(STATUSES, status)) throw new HubError('BAD_STATUS', `invalid status: ${String(status)}`);
  const path = join(inboxDir(ctx, ctx.user.name), `${id}.md`);
  if (!existsSync(path)) throw new HubError('NOT_FOUND', `no message ${id} in your inbox`);
  const current = readMessage(path, ctx.user.name);
  const updated = { ...current, status };
  writeDoc(path, frontmatter(updated), current.body);
  return { ...updated, path };
}

export function listWaiting(ctx: Ctx, olderThanDays: number): Message[] {
  assertName(ctx.user.name);
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new HubError('BAD_INPUT', 'olderThanDays must be a non-negative number');
  }
  const inboxRoot = join(ctx.hubDir, 'inbox');
  if (!existsSync(inboxRoot)) return [];
  const answered = new Set(listInbox(ctx).filter((m) => m.type === 'answer').map((m) => m.thread));
  const cutoff = ctx.now().getTime() - olderThanDays * 86_400_000;
  return readdirSync(inboxRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== ctx.user.name && passes(assertName, e.name))
    .flatMap((e) => readAll(listMd(join(inboxRoot, e.name)), e.name))
    .filter((m) => m.from === ctx.user.name && m.type !== 'answer')
    .filter((m) => !answered.has(m.thread) && Date.parse(m.created) < cutoff)
    .sort(byCreated);
}
