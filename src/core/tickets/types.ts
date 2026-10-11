export type TrackerKind = 'asana' | 'jira';

export interface Ticket {
  id: string;
  title: string;
  notes: string;
  modifiedAt: string;
  due: string | null;
  url: string | null;
  parent: { id: string; title: string } | null;
  status: string | null;
  priority: string | null;
  fields: Array<{ name: string; value: string }>; // custom fields with a display value
  components: string[];
  labels: string[];
  containers: string[]; // Asana project names / Jira project key
  sections: string[]; // Asana section names
  sprints: Array<{ name: string; active: boolean; boardId: number | null }>;
  restricted: boolean;
}

export interface TicketComment {
  createdAt: string;
  author: string;
  text: string;
}

export interface TicketSource {
  readonly kind: TrackerKind;
  readonly label: string; // 'Asana' | 'Jira'
  normalizeId(raw: string): string; // throws BAD_TICKET for this system's shape
  whoAmI(): Promise<{ id: string; name: string }>;
  myTickets(): Promise<Ticket[]>; // open tickets assigned to me, in scope
  ticket(id: string): Promise<Ticket>;
  comments(id: string, limit?: number): Promise<TicketComment[]>;
}

export interface Discovery {
  scopes(): Promise<Array<{ id: string; name: string }>>; // Asana workspaces / Jira projects
  sample(scope: string[], limit: number): Promise<Ticket[]>; // recent tickets in scope, any assignee
  statuses(scope: string[]): Promise<string[]>;
  priorities(): Promise<string[]>;
  boards(scope: string[]): Promise<Array<{ id: number; name: string }>>; // [] for Asana
}

export function fieldValue(t: Ticket, prefix: string): string | null {
  const p = prefix.toLowerCase();
  return t.fields.find((f) => f.name.toLowerCase().startsWith(p) && f.value)?.value ?? null;
}

export async function parentChain(src: Pick<TicketSource, 'ticket'>, t: Ticket, max = 5): Promise<Ticket[]> {
  const chain = [t];
  const seen = new Set<string>([t.id]);
  let current = t;
  while (current.parent && chain.length <= max) {
    const parentId = current.parent.id;
    if (seen.has(parentId)) break; // parent cycle: stop rather than repeat a ticket
    seen.add(parentId);
    current = await src.ticket(parentId);
    chain.push(current);
  }
  return chain;
}
