import type { AsanaComment, AsanaReader, AsanaTask } from '../../src/core/asana';
import type { Discovery, Ticket, TicketComment, TicketSource } from '../../src/core/tickets/types';

export function task(overrides: Partial<AsanaTask> & { gid: string }): AsanaTask {
  return {
    name: `Task ${overrides.gid}`,
    modified_at: '2026-10-07T00:00:00.000Z',
    memberships: [],
    custom_fields: [],
    parent: null,
    ...overrides,
  };
}

export const field = (name: string, display_value: string | null) => ({ name, display_value });

export function fakeAsana(
  tasks: AsanaTask[],
  comments: Record<string, AsanaComment[]> = {},
  myTasks: string[] = tasks.map((t) => t.gid),
): AsanaReader & { calls: string[] } {
  const byGid = new Map(tasks.map((t) => [t.gid, t]));
  const calls: string[] = [];
  return {
    calls,
    async getMyTasks() {
      calls.push('getMyTasks');
      return myTasks.map((g) => byGid.get(g)!);
    },
    async getTask(gid) {
      calls.push(`getTask:${gid}`);
      const t = byGid.get(gid);
      if (!t) throw new Error(`no task ${gid}`);
      return t;
    },
    async getComments(gid, limit = 10) {
      calls.push(`getComments:${gid}`);
      return (comments[gid] ?? []).slice(-limit);
    },
  };
}

export function ticket(overrides: Partial<Ticket> & { id: string }): Ticket {
  return {
    title: `Ticket ${overrides.id}`,
    notes: '',
    modifiedAt: '2026-10-07T00:00:00.000Z',
    due: null,
    url: null,
    parent: null,
    status: null,
    priority: null,
    fields: [],
    components: [],
    labels: [],
    containers: [],
    sections: [],
    sprints: [],
    restricted: false,
    ...overrides,
  };
}

export function fakeSource(
  tickets: Ticket[],
  comments: Record<string, TicketComment[]> = {},
  mine: string[] = tickets.map((t) => t.id),
): TicketSource & Discovery & { calls: string[] } {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const calls: string[] = [];
  return {
    calls,
    kind: 'asana',
    label: 'Asana',
    normalizeId: (raw) => raw.trim(),
    async whoAmI() {
      return { id: '1', name: 'Test User' };
    },
    async myTickets() {
      calls.push('myTickets');
      return mine.map((id) => byId.get(id)!);
    },
    async ticket(id) {
      calls.push(`ticket:${id}`);
      const t = byId.get(id);
      if (!t) throw new Error(`no ticket ${id}`);
      return t;
    },
    async comments(id, limit = 10) {
      calls.push(`comments:${id}`);
      return (comments[id] ?? []).slice(-limit);
    },
    async scopes() {
      return [];
    },
    async sample(_scope, limit) {
      return tickets.slice(0, limit);
    },
    async statuses() {
      return [...new Set(tickets.map((t) => t.status).filter((s): s is string => !!s))];
    },
    async priorities() {
      return [...new Set(tickets.map((t) => t.priority).filter((s): s is string => !!s))];
    },
    async boards() {
      return [];
    },
  };
}
