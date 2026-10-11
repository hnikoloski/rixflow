import { scrub } from './scrub';
import { valueFromChain } from './sites';
import { fieldValue, type Ticket, type TicketComment } from './tickets/types';

const FIELDS = ['Website', 'Status', 'Priority', 'Type', 'Epic', 'Page', 'Theme', 'Components', 'Labels'];
const LINKS = ['Design link', 'Draft link', 'Content link', 'Dev Link', 'Stage link', 'Live link', 'Amplitude dashboard'];

// Single-line text: headings and bullets must never start a new line that could look like a `## ` section.
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Multi-line free text is quoted so every line starts with `> `, which the section parser never matches.
const quote = (text: string) => text.replace(/\r\n?/g, '\n').trim().split('\n').map((l) => `> ${l}`).join('\n');

// `label` names the tracker ('Asana', 'Jira'). Status is the ticket's own; other fields come from the chain.
export function buildBrief(ticket: Ticket, chain: Ticket[], comments: TicketComment[], label: string): string {
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
  const links = LINKS.map((name) => [name, fieldValue(ticket, name)] as const).filter(([, v]) => v);
  if (links.length) {
    lines.push('', '### Links');
    for (const [name, v] of links) lines.push(`- ${name}:`, quote(v!));
  }
  // Scrub before truncating, so a credential URL is never cut mid-way and leaves a fragment.
  if (ticket.notes.trim()) lines.push('', '### Description', quote(scrub(ticket.notes).slice(0, 4000)));
  if (comments.length) {
    lines.push('', '### Recent comments');
    for (const c of comments) lines.push(`- ${oneLine(c.author)} (${oneLine(scrub(c.createdAt).slice(0, 10))}): ${oneLine(c.text)}`);
  }
  return scrub(lines.join('\n'));
}
