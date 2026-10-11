import { fieldValue, type AsanaComment, type AsanaTask } from './asana';
import { scrub } from './scrub';
import { valueFromChain } from './sites';

const FIELDS = ['Website', 'Status', 'Priority', 'Type', 'Epic', 'Page', 'Theme'];
const LINKS = ['Design link', 'Draft link', 'Content link', 'Dev Link', 'Stage link', 'Live link', 'Amplitude dashboard'];

// Single-line text: headings and bullets must never start a new line that could look like a `## ` section.
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

// Multi-line free text is quoted so every line starts with `> `, which the section parser never matches.
const quote = (text: string) => text.replace(/\r\n?/g, '\n').trim().split('\n').map((l) => `> ${l}`).join('\n');

export function buildBrief(task: AsanaTask, chain: AsanaTask[], comments: AsanaComment[]): string {
  const lines = [`# ${oneLine(task.name)}`, '', `- Asana: ${oneLine(task.permalink_url ?? task.gid)}`];
  for (const name of FIELDS) {
    const v = name === 'Status' ? fieldValue(task, name) : valueFromChain(chain, name);
    if (v) lines.push(`- ${name}: ${oneLine(v)}`);
  }
  if (task.due_on) lines.push(`- Due: ${oneLine(task.due_on)}`);
  if (chain.length > 1) lines.push(`- Parent: ${chain.slice(1).map((t) => oneLine(t.name)).join(' › ')}`);
  const links = LINKS.map((name) => [name, fieldValue(task, name)] as const).filter(([, v]) => v);
  if (links.length) {
    lines.push('', '### Links');
    for (const [name, v] of links) lines.push(`- ${name}:`, quote(v!));
  }
  // Scrub before truncating, so a credential URL is never cut mid-way and leaves a fragment.
  if (task.notes?.trim()) lines.push('', '### Description', quote(scrub(task.notes).slice(0, 4000)));
  if (comments.length) {
    lines.push('', '### Recent comments');
    for (const c of comments) lines.push(`- ${oneLine(c.author)} (${oneLine(scrub(c.created_at).slice(0, 10))}): ${oneLine(c.text)}`);
  }
  return scrub(lines.join('\n'));
}
