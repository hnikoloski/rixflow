import { scrub } from './scrub';
import { valueFromChain } from './sites';
import { fieldValue, type Ticket, type TicketChild, type TicketComment } from './tickets/types';
import type { Step } from './workflow';

const FIELDS = ['Website', 'Status', 'Priority', 'Type', 'Epic', 'Page', 'Theme', 'Components', 'Labels'];
const LINKS = ['Design link', 'Draft link', 'Content link', 'Dev Link', 'Stage link', 'Live link', 'Amplitude dashboard'];

// Single-line text: headings and bullets must never start a new line that could look like a `## ` section.
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Multi-line free text is quoted so every line starts with `> `, which the section parser never matches.
const quote = (text: string) => text.replace(/\r\n?/g, '\n').trim().split('\n').map((l) => `> ${l}`).join('\n');

// What a brief adds around the ticket itself: its epic (the top of the parent chain, when the
// ticket is a subtask), the epic's subtasks, and the team step the ticket is.
export interface BriefContext {
  epic?: { ticket: Ticket; comments: TicketComment[] } | null;
  subtasks?: TicketChild[];
  step?: Step | null;
}

const STEP_NAMES: Record<Step, string> = { dev: 'Dev', stage: 'Stage', live: 'Live' };
const MAX_SUBTASKS = 30;

const commentLines = (comments: TicketComment[]) =>
  comments.map((c) => `- ${oneLine(c.author)} (${oneLine(scrub(c.createdAt).slice(0, 10))}): ${oneLine(c.text)}`);

// `label` names the tracker ('Asana', 'Jira'). Status is the ticket's own; other fields come from the chain.
export function buildBrief(ticket: Ticket, chain: Ticket[], comments: TicketComment[], label: string, ctx: BriefContext = {}): string {
  const lines = [`# ${oneLine(ticket.title)}`, '', `- ${oneLine(label)}: ${oneLine(ticket.url ?? ticket.id)}`];
  for (const name of FIELDS) {
    const v =
      name === 'Status' ? ticket.status ?? fieldValue(ticket, name)
      : name === 'Priority' ? chain.find((t) => t.priority)?.priority ?? valueFromChain(chain, name)
      : valueFromChain(chain, name);
    if (v) lines.push(`- ${name}: ${oneLine(v)}`);
  }
  if (ticket.due) lines.push(`- Due: ${oneLine(ticket.due)}`);
  if (chain.length > 1) lines.push(`- Parent: ${chain.slice(1).map((t) => oneLine(t.title)).join(' › ')}`);
  if (ctx.step) lines.push(`- Step: ${STEP_NAMES[ctx.step]}`);
  const links = LINKS.map((name) => [name, fieldValue(ticket, name)] as const).filter(([, v]) => v);
  if (links.length) {
    lines.push('', '### Links');
    for (const [name, v] of links) lines.push(`- ${name}:`, quote(v!));
  }
  // Scrub before truncating, so a credential URL is never cut mid-way and leaves a fragment.
  if (ticket.notes.trim()) lines.push('', '### Description', quote(scrub(ticket.notes).slice(0, 4000)));
  if (comments.length) lines.push('', '### Recent comments', ...commentLines(comments));
  const epic = ctx.epic?.ticket;
  if (epic) {
    lines.push('', `### Epic: ${oneLine(epic.title)}`, `- ${oneLine(label)}: ${oneLine(epic.url ?? epic.id)}`);
    if (epic.restricted) lines.push('- The epic is restricted: open it in the tracker for its description and comments.');
    else {
      if (epic.notes.trim()) lines.push(quote(scrub(epic.notes).slice(0, 4000)));
      if (ctx.epic!.comments.length) lines.push('', '### Epic comments', ...commentLines(ctx.epic!.comments));
    }
  }
  const subtasks = ctx.subtasks ?? [];
  if (subtasks.length) {
    lines.push('', epic ? '### Subtasks of the epic' : '### Subtasks');
    for (const c of subtasks.slice(0, MAX_SUBTASKS)) {
      const who = c.assignee ? oneLine(c.assignee) : 'unassigned';
      const marks = [c.mine ? 'you' : '', c.id === ticket.id ? 'this ticket' : ''].filter(Boolean).join(', ');
      lines.push(`- [${c.done ? 'done' : 'open'}] ${oneLine(c.title)} · ${who}${marks ? ` (${marks})` : ''} · ${oneLine(c.id)}`);
      // Your own other subtasks carry their description; everyone else's stay one line.
      if (c.mine && c.id !== ticket.id && c.notes.trim()) lines.push(quote(scrub(c.notes).slice(0, 1500)));
    }
    if (subtasks.length > MAX_SUBTASKS) lines.push(`- …and ${subtasks.length - MAX_SUBTASKS} more`);
  }
  return scrub(lines.join('\n'));
}
