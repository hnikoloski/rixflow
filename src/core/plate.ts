import { mapTicket, needsParents, type Mapped } from './mapping';
import { listInbox, listWaiting, type Message, type MessageType } from './messages';
import { handoverPickedUp, listCheckpoints, type Checkpoint } from './notes';
import { resolveSite } from './sites';
import { scrub } from './scrub';
import { loadSites } from './team';
import { parentChain, type Ticket, type TicketSource } from './tickets/types';
import { HubError, type Ctx } from './types';
import type { Workflow } from './workflow';

export interface PlateItem {
  n: number;
  kind: 'task' | 'message';
  ref: string;
  title: string;
  sites: string[];
  status: string | null;
  priority: string | null;
  due: string | null;
  paused: boolean;
  handedTo?: string; // paused work handed over to this teammate
  from?: string;
  messageType?: MessageType;
}

export interface Plate {
  sprintName: string | null;
  urgent: PlateItem[];
  inProgress: PlateItem[];
  sprint: PlateItem[];
  inbox: PlateItem[];
  backlog: PlateItem[];
  waiting: Array<{ id: string; to: string; title: string; ageDays: number }>;
}

const INBOX_STATUSES = new Set(['new', 'read']);

// Terminal-bound text: keep the first line and replace C0/C1 control characters and bidi
// marks/overrides so titles cannot move the cursor, inject escape sequences or reorder text.
const clean = (text: string) =>
  text.trim().split('\n')[0].slice(0, 80).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
// Every ticket- or message-derived string passes through scrub before it reaches the model or terminal.
export const display = (text: string) => clean(scrub(text));
const byDue = (a: PlateItem, b: PlateItem) => (a.due ?? '9999').localeCompare(b.due ?? '9999');

// Placement: done tickets are dropped; urgent → Urgent; in progress or paused → In progress;
// in the current sprint → This sprint; everything else (waiting included) → Backlog.
export function buildPlate(input: {
  tasks: Array<{ ticket: Ticket; mapped: Mapped }>;
  inbox: Message[];
  checkpoints: Checkpoint[];
  waiting: Message[];
  now: Date;
}): Plate {
  const paused = new Map(input.checkpoints.map((c) => [c.task, c]));
  const plate: Plate = { sprintName: null, urgent: [], inProgress: [], sprint: [], inbox: [], backlog: [], waiting: [] };
  for (const { ticket, mapped } of input.tasks) {
    if (mapped.bucket === 'done') continue;
    const item: PlateItem = {
      n: 0, kind: 'task', ref: ticket.id, title: display(ticket.title), sites: mapped.codes,
      status: ticket.status === null ? null : display(ticket.status), priority: ticket.priority,
      due: ticket.due, paused: paused.has(ticket.id),
      ...(paused.get(ticket.id)?.handedTo ? { handedTo: paused.get(ticket.id)?.handedTo } : {}),
    };
    if (mapped.sprint) plate.sprintName = display(mapped.sprint);
    if (mapped.urgent) plate.urgent.push(item);
    else if (item.paused || mapped.bucket === 'in_progress') plate.inProgress.push(item);
    else if (mapped.sprint) plate.sprint.push(item);
    else plate.backlog.push(item);
  }
  for (const m of input.inbox.filter((x) => INBOX_STATUSES.has(x.status))) {
    plate.inbox.push({
      n: 0, kind: 'message', ref: m.id, title: display(m.body), sites: [], status: display(m.status), priority: null,
      due: null, paused: false, from: m.from, messageType: m.type,
    });
  }
  for (const group of [plate.urgent, plate.inProgress, plate.sprint, plate.backlog]) group.sort(byDue);
  let n = 1;
  for (const group of [plate.urgent, plate.inProgress, plate.sprint, plate.inbox, plate.backlog]) {
    for (const item of group) item.n = n++;
  }
  plate.waiting = input.waiting.map((m) => ({
    id: m.id, to: m.to, title: display(m.body),
    ageDays: Math.floor((input.now.getTime() - Date.parse(m.created)) / 86_400_000),
  }));
  return plate;
}

function line(item: PlateItem): string {
  if (item.kind === 'message') return `${item.n}. ${item.messageType} from ${item.from}: ${item.title} (${item.ref})`;
  const tag = item.sites.length ? `[${item.sites.join(', ')}] ` : '';
  const extra = [item.status, item.due ? `due ${item.due}` : null, item.handedTo ? `(handed to ${item.handedTo})` : item.paused ? '(paused)' : null].filter(Boolean).join(' · ');
  return `${item.n}. ${tag}${item.title}${extra ? ` — ${extra}` : ''} (${item.ref})`;
}

// Only the fields the plate shows are rendered. Link fields and permalinks are never read here.
export function renderPlate(plate: Plate): string {
  const out: string[] = [];
  if (plate.sprintName) out.push(`**${plate.sprintName}**`, '');
  const groups: Array<[string, PlateItem[]]> = [
    ['Urgent', plate.urgent], ['In progress / paused', plate.inProgress], ['This sprint', plate.sprint],
    ['Inbox', plate.inbox], ['Backlog', plate.backlog],
  ];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    out.push(`### ${title}`, ...items.map(line), '');
  }
  if (plate.waiting.length) {
    out.push('### Waiting on others', ...plate.waiting.map((w) => `- ${w.to}: ${w.title} (${w.ageDays} days, ${w.id})`), '');
  }
  return out.length ? out.join('\n') : 'Nothing on your plate.';
}

const PARENT_FETCH_LIMIT = 5;

// Runs fn over items with at most `limit` calls in flight; results keep input order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const isAuthError = (err: unknown) => err instanceof HubError && err.code.endsWith('_AUTH');

// Reads only. A failed parent fetch degrades that ticket to its own fields; auth errors still surface.
// Each parent id is fetched once per run: siblings share the same promise, failures included.
export async function gatherPlate(ctx: Ctx, source: TicketSource, wf: Workflow): Promise<Plate> {
  const sites = loadSites(ctx.hubDir);
  const now = ctx.now();
  const mine = await source.myTickets();
  const fetches = new Map<string, Promise<Ticket>>(mine.map((t) => [t.id, Promise.resolve(t)]));
  const cached: Pick<TicketSource, 'ticket'> = {
    ticket: (id) => {
      let p = fetches.get(id);
      if (!p) {
        p = source.ticket(id);
        fetches.set(id, p);
      }
      return p;
    },
  };
  const tasks = await mapLimit(mine, PARENT_FETCH_LIMIT, async (ticket) => {
    let chain: Ticket[] = [ticket];
    if (needsParents(ticket, wf)) {
      try {
        chain = await parentChain(cached, ticket);
      } catch (err) {
        if (isAuthError(err)) throw err;
        chain = [ticket];
      }
    }
    const mapped = mapTicket(chain, wf, now);
    // The plate shows the resolved site, so a remembered choice wins over the mapped codes.
    return { ticket, mapped: { ...mapped, codes: resolveSite(chain, mapped, sites, ctx.user).codes } };
  });
  return buildPlate({
    tasks,
    inbox: listInbox(ctx, ['new', 'read']),
    checkpoints: listCheckpoints(ctx).filter((c) => !handoverPickedUp(ctx, c)),
    waiting: listWaiting(ctx, 2),
    now,
  });
}
