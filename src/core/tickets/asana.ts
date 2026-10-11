import type { AsanaClient, AsanaReader, AsanaTask } from '../asana';
import { HubError, assertGid } from '../types';
import { fieldValue } from './types';
import type { Discovery, Ticket, TicketSource } from './types';

export interface AsanaSourceOpts {
  workspace: string;
  statusField?: string;
  priorityField?: string;
}

export function toTicket(t: AsanaTask, opts: AsanaSourceOpts): Ticket {
  const fields = (t.custom_fields ?? [])
    .filter((c) => c.display_value)
    .map((c) => ({ name: c.name, value: c.display_value as string }));
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

type Reader = AsanaReader & Partial<Pick<AsanaClient, 'getMe'>>;

export function asanaSource(reader: Reader, opts: AsanaSourceOpts): TicketSource & Discovery {
  const conv = (t: AsanaTask) => toTicket(t, opts);
  const me = () => {
    if (!reader.getMe) throw new HubError('ASANA_HTTP', 'This Asana reader cannot look up the current user');
    return reader.getMe();
  };
  const sample = async () => (await reader.getMyTasks(opts.workspace)).map(conv);
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
    async scopes() {
      return (await me()).workspaces.map((w) => ({ id: w.gid, name: w.name }));
    },
    // Asana has no cheap "recent in scope" endpoint; the creator's own tasks stand in. Scope is ignored.
    async sample(_scope, limit) {
      return (await sample()).slice(0, limit);
    },
    async statuses() {
      return [...new Set((await sample()).map((t) => t.status).filter((s): s is string => !!s))];
    },
    async priorities() {
      return [...new Set((await sample()).map((t) => t.priority).filter((s): s is string => !!s))];
    },
    async boards() {
      return [];
    },
  };
}
