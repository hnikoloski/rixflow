import { fieldValue, parentChain, type AsanaReader, type AsanaTask } from './asana';
import { listInbox, listWaiting, type Message, type MessageType } from './messages';
import { listCheckpoints, type Checkpoint } from './notes';
import { resolveSite, valueFromChain } from './sites';
import { scrub } from './scrub';
import { isCurrentSprint } from './sprint';
import { loadSites } from './team';
import { hubCommand } from './command';
import { HubError, type Ctx } from './types';

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

const URGENT_PRIORITY = /^(urgent|critical|p0|highest)$/i;
const URGENT_NAME = /hotfix|urgent|\bp0\b/i;
const INBOX_STATUSES = new Set(['new', 'read']);

function sectionOf(chain: AsanaTask[]): string | null {
  for (const t of chain) for (const m of t.memberships ?? []) if (m.section) return m.section.name;
  return null;
}

// Terminal-bound text: keep the first line and replace C0/C1 control characters and bidi
// marks/overrides so titles cannot move the cursor, inject escape sequences or reorder text.
const clean = (text: string) =>
  text.trim().split('\n')[0].slice(0, 80).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
// Every Asana- or message-derived string passes through scrub before it reaches the model or terminal.
export const display = (text: string) => clean(scrub(text));
const byDue = (a: PlateItem, b: PlateItem) => (a.due ?? '9999').localeCompare(b.due ?? '9999');

export function buildPlate(input: {
  tasks: Array<{ task: AsanaTask; chain: AsanaTask[]; sites: string[] }>;
  inbox: Message[];
  checkpoints: Checkpoint[];
  waiting: Message[];
  now: Date;
}): Plate {
  const paused = new Set(input.checkpoints.map((c) => c.task));
  const plate: Plate = { sprintName: null, urgent: [], inProgress: [], sprint: [], inbox: [], backlog: [], waiting: [] };
  for (const { task, chain, sites } of input.tasks) {
    const status = valueFromChain([task], 'Status');
    const priority = valueFromChain(chain, 'Priority');
    const section = sectionOf(chain);
    const item: PlateItem = {
      n: 0, kind: 'task', ref: task.gid, title: display(task.name), sites, status: status === null ? null : display(status), priority,
      due: task.due_on ?? null, paused: paused.has(task.gid),
    };
    const inSprint = !!section && isCurrentSprint(section, input.now);
    if (inSprint) plate.sprintName = display(section);
    if ((priority && URGENT_PRIORITY.test(priority)) || URGENT_NAME.test(task.name)) plate.urgent.push(item);
    else if (item.paused || /in progress/i.test(status ?? '')) plate.inProgress.push(item);
    else if (inSprint) plate.sprint.push(item);
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
  const extra = [item.status, item.due ? `due ${item.due}` : null, item.paused ? '(paused)' : null].filter(Boolean).join(' · ');
  return `${item.n}. ${tag}${item.title}${extra ? ` — ${extra}` : ''} (${item.ref})`;
}

// Only the fields the plate shows are rendered. Asana link fields and permalinks are never read here.
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

// Reads only. A failed parent fetch degrades that task to its own fields; auth errors still surface.
// Each parent gid is fetched once per run: siblings share the same promise, failures included.
export async function gatherPlate(ctx: Ctx, asana: AsanaReader): Promise<Plate> {
  const workspace = ctx.user.asanaWorkspace;
  if (!workspace) throw new HubError('NO_WORKSPACE', `No Asana workspace configured (run in a terminal: ${hubCommand('init')})`);
  const sites = loadSites(ctx.hubDir);
  const mine = await asana.getMyTasks(workspace);
  const fetches = new Map<string, Promise<AsanaTask>>(mine.map((t) => [t.gid, Promise.resolve(t)]));
  const cached: AsanaReader = {
    getMyTasks: (w) => asana.getMyTasks(w),
    getComments: (g, l) => asana.getComments(g, l),
    getTask: (gid) => {
      let p = fetches.get(gid);
      if (!p) {
        p = asana.getTask(gid);
        fetches.set(gid, p);
      }
      return p;
    },
  };
  const tasks = await mapLimit(mine, PARENT_FETCH_LIMIT, async (task) => {
    const needsParents = !task.memberships?.some((m) => m.section) || !fieldValue(task, 'Website');
    let chain: AsanaTask[] = [task];
    if (needsParents) {
      try {
        chain = await parentChain(cached, task);
      } catch (err) {
        if (err instanceof HubError && err.code === 'ASANA_AUTH') throw err;
        chain = [task];
      }
    }
    return { task, chain, sites: resolveSite(chain, sites, ctx.user).codes };
  });
  return buildPlate({
    tasks,
    inbox: listInbox(ctx, ['new', 'read']),
    checkpoints: listCheckpoints(ctx),
    waiting: listWaiting(ctx, 2),
    now: ctx.now(),
  });
}
