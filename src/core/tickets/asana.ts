import type { AsanaClient, AsanaReader, AsanaTask } from '../asana';
import { HubError, assertGid } from '../types';
import { fieldValue } from './types';
import type { Discovery, Ticket, TicketChild, TicketSource } from './types';

export interface AsanaSourceOpts {
  workspace: string;
  statusField?: string;
  priorityField?: string;
}

export function toTicket(t: AsanaTask, opts: AsanaSourceOpts): Ticket {
  const fields = (t.custom_fields ?? [])
    .filter((c) => c.display_value)
    .map((c) => {
      const values = (c.multi_enum_values ?? []).map((o) => o.name).filter(Boolean);
      return { name: c.name, value: c.display_value as string, ...(values.length > 1 ? { values } : {}) };
    });
  const base: Ticket = {
    id: t.gid,
    title: t.name,
    notes: t.notes ?? '',
    modifiedAt: t.modified_at,
    due: t.due_on ?? null,
    url: t.permalink_url ?? null,
    parent: t.parent ? { id: t.parent.gid, title: t.parent.name } : null,
    status: null,
    priority: null,
    fields,
    components: [],
    labels: [],
    containers: (t.memberships ?? []).flatMap((m) => (m.project ? [m.project.name] : [])),
    sections: (t.memberships ?? []).flatMap((m) => (m.section ? [m.section.name] : [])),
    sprints: [],
    restricted: false,
  };
  base.status = fieldValue(base, opts.statusField ?? 'Status');
  base.priority = fieldValue(base, opts.priorityField ?? 'Priority');
  return base;
}

// Setup reads the fields of at most this many projects, so a person in hundreds of projects stays fast.
const MAX_PROJECT_LOOKUPS = 20;

type Reader = AsanaReader & Partial<Pick<AsanaClient, 'getMe' | 'getFieldOptions' | 'getProjectFieldOptions'>>;

export function asanaSource(reader: Reader, opts: AsanaSourceOpts): TicketSource & Discovery {
  const conv = (t: AsanaTask) => toTicket(t, opts);
  const me = () => {
    if (!reader.getMe) throw new HubError('ASANA_HTTP', 'This Asana reader cannot look up the current user');
    return reader.getMe();
  };
  // The current user's gid, looked up once; null when the lookup is not possible.
  let myGid: Promise<string | null> | undefined;
  const myId = () => (myGid ??= reader.getMe ? reader.getMe().then((u) => u.gid, () => null) : Promise.resolve(null));
  const sample = async () => (await reader.getMyTasks(opts.workspace)).map(conv);
  // The dropdown options of every field with this name (workspace fields, and the project-only
  // fields of the projects the sampled tasks are in), then the values seen on sampled tickets.
  // Options cover statuses nobody has a ticket in yet. A lookup that fails (no permission, a plan
  // without custom fields) is skipped; the sampled values alone still work.
  const values = async (field: string, seen: (t: Ticket) => string | null): Promise<string[]> => {
    const tasks = await reader.getMyTasks(opts.workspace);
    const projects = [...new Set(tasks.flatMap((t) => (t.memberships ?? []).flatMap((m) => (m.project?.gid ? [m.project.gid] : []))))];
    const lookups: Array<Promise<Array<{ name: string; options: string[] }>>> = [
      ...(reader.getFieldOptions ? [reader.getFieldOptions(opts.workspace)] : []),
      ...(reader.getProjectFieldOptions ? projects.slice(0, MAX_PROJECT_LOOKUPS).map((p) => reader.getProjectFieldOptions!(p)) : []),
    ];
    const options = (await Promise.all(lookups.map((l) => l.catch(() => []))))
      .flat()
      .filter((f) => f.name.toLowerCase() === field.toLowerCase())
      .flatMap((f) => f.options);
    const out: string[] = [];
    const known = new Set<string>();
    for (const v of [...options, ...tasks.map(conv).map(seen)]) {
      if (v && !known.has(v.toLowerCase())) { known.add(v.toLowerCase()); out.push(v); }
    }
    return out;
  };
  return {
    kind: 'asana',
    label: 'Asana',
    normalizeId(raw) {
      const id = typeof raw === 'string' ? raw.trim() : raw;
      try {
        assertGid(id);
      } catch {
        throw new HubError('BAD_TICKET', `invalid ticket id: ${String(raw)}`);
      }
      return id;
    },
    async whoAmI() {
      const u = await me();
      return { id: u.gid, name: u.name };
    },
    myTickets: sample,
    async ticket(id) {
      return conv(await reader.getTask(id));
    },
    async comments(id, limit) {
      return (await reader.getComments(id, limit)).map((c) => ({ createdAt: c.created_at, author: c.author, text: c.text }));
    },
    async children(id): Promise<TicketChild[]> {
      if (!reader.getSubtasks) return [];
      const [subtasks, mine] = await Promise.all([reader.getSubtasks(id), myId()]);
      return subtasks.map((t) => ({
        id: t.gid,
        title: t.name,
        assignee: t.assignee?.name ?? null,
        mine: !!mine && t.assignee?.gid === mine,
        done: t.completed === true,
        notes: t.notes ?? '',
      }));
    },
    async scopes() {
      return (await me()).workspaces.map((w) => ({ id: w.gid, name: w.name }));
    },
    // Asana has no cheap "recent in scope" endpoint; the creator's own tasks stand in. Scope is ignored.
    async sample(_scope, limit) {
      return (await sample()).slice(0, limit);
    },
    async statuses() {
      return values(opts.statusField ?? 'Status', (t) => t.status);
    },
    async priorities() {
      return values(opts.priorityField ?? 'Priority', (t) => t.priority);
    },
    async boards() {
      return [];
    },
  };
}
