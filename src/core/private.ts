import { chmodSync, lstatSync, readdirSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { oneLine } from './brief';
import { scrub } from './scrub';
import type { Ticket } from './tickets/types';
import { assertTicketId, HubError } from './types';

// Restricted tickets keep their description and comments out of the hub. The full brief lives in
// `<configDir>/private/<task>.md`: never committed, owner-only.
function privateFile(configDir: string, task: string): string {
  assertTicketId(task); // the id becomes a file name: never build a path from an unchecked one
  return join(configDir, 'private', `${task}.md`);
}

const isLink = (path: string): boolean => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};

export function writePrivateBrief(configDir: string, task: string, brief: string): string {
  const file = privateFile(configDir, task);
  const dir = join(configDir, 'private');
  try {
    if (isLink(dir)) throw new Error('private dir is a symlink');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700);
    // Remove first: writeFileSync keeps the mode of an existing file, 'wx' + 0600 sets it from creation.
    rmSync(file, { force: true });
    writeFileSync(file, scrub(brief), { mode: 0o600, flag: 'wx' });
  } catch {
    throw new HubError('PRIVATE_WRITE', `Could not save the restricted ticket brief on this machine (${dir}).`);
  }
  return file;
}

// Local markers record that a ticket was seen as restricted, so a session that only looked at it
// (no handover, no private brief) is still never summarized. They are kept after finish or drop.
const markerFile = (configDir: string, task: string): string => {
  assertTicketId(task);
  return join(configDir, 'private', `${task}.restricted`);
};

export function markRestricted(configDir: string, task: string, now: Date): void {
  try {
    const file = markerFile(configDir, task);
    const dir = join(configDir, 'private');
    if (isLink(dir)) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700);
    rmSync(file, { force: true });
    writeFileSync(file, now.toISOString(), { mode: 0o600, flag: 'wx' });
  } catch {
    // best effort: a marker failure never fails the tool
  }
}

export function hasPrivateBrief(configDir: string, task: string): boolean {
  if (isLink(join(configDir, 'private'))) return false;
  for (const file of [privateFile(configDir, task), markerFile(configDir, task)]) {
    try { if (lstatSync(file).isFile()) return true; } catch { /* absent */ }
  }
  return false;
}

export function readPrivateBrief(configDir: string, task: string): string | null {
  const file = privateFile(configDir, task);
  try {
    if (isLink(join(configDir, 'private')) || !lstatSync(file).isFile()) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Best effort, never throws: a finished or dropped task no longer needs its private brief.
export function deletePrivateBrief(configDir: string, task: string): void {
  try {
    const file = privateFile(configDir, task);
    if (!isLink(join(configDir, 'private'))) rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

// What the hub gets instead of the full brief for a restricted ticket.
export function restrictedBrief(ticket: Ticket, label: string, user: string): string {
  return scrub([
    `# ${oneLine(ticket.title)}`, '',
    `- ${oneLine(label)}: ${oneLine(ticket.url ?? ticket.id)}`,
    `- Restricted ticket: its description and comments are kept on ${oneLine(user)}'s machine only.`,
  ].join('\n'));
}

export const privateDirIsLink = (configDir: string): boolean => isLink(join(configDir, 'private'));

// Ids with a private brief or a restricted marker on this machine.
export function privateIds(configDir: string): string[] {
  try {
    if (privateDirIsLink(configDir)) return [];
    return readdirSync(join(configDir, 'private')).filter((f) => /\.(md|restricted)$/.test(f)).map((f) => f.replace(/\.(md|restricted)$/, ''));
  } catch {
    return [];
  }
}
