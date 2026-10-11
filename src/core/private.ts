import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { oneLine } from './brief';
import { scrub } from './scrub';
import type { Ticket } from './tickets/types';
import { assertTicketId } from './types';

// Restricted tickets keep their description and comments out of the hub. The full brief lives in
// `<configDir>/private/<task>.md`: never committed, owner-only.
function privateFile(configDir: string, task: string): string {
  assertTicketId(task); // the id becomes a file name: never build a path from an unchecked one
  return join(configDir, 'private', `${task}.md`);
}

export function writePrivateBrief(configDir: string, task: string, brief: string): string {
  const file = privateFile(configDir, task);
  const dir = join(configDir, 'private');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700);
  // Remove first: writeFileSync keeps the mode of an existing file, 'wx' + 0600 sets it from creation.
  rmSync(file, { force: true });
  writeFileSync(file, scrub(brief), { mode: 0o600, flag: 'wx' });
  return file;
}

export function readPrivateBrief(configDir: string, task: string): string | null {
  const file = privateFile(configDir, task);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

// What the hub gets instead of the full brief for a restricted ticket.
export function restrictedBrief(ticket: Ticket, label: string, user: string): string {
  return scrub([
    `# ${oneLine(ticket.title)}`, '',
    `- ${oneLine(label)}: ${oneLine(ticket.url ?? ticket.id)}`,
    `- Restricted ticket: its description and comments are kept on ${oneLine(user)}'s machine only.`,
  ].join('\n'));
}
