import type { Git } from '../core/git';
import { checkChanges, parseNameStatus } from '../core/ownership';
import { findSecrets } from '../core/scrub';
import { HubError } from '../core/types';

// Throws on any git or parse error (HubError BAD_DIFF included): callers must fail closed.
export async function verifyStaged(git: Git, user: string): Promise<string[]> {
  const changes = parseNameStatus(await git.run(['diff', '--cached', '-z', '--name-status', '--no-renames']));
  const problems = checkChanges(user, changes);
  // Mode 120000 marks a symlink. Any staged symlink is refused (deleting one is fine: its new mode is 000000): a link could redirect a later write.
  const raw = (await git.run(['diff', '--cached', '--raw', '-z', '--no-renames'])).split('\0');
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const meta = raw[i];
    if (!meta.startsWith(':')) throw new HubError('BAD_DIFF', 'unexpected git raw output');
    const [, newMode] = meta.slice(1).split(' ');
    if (newMode === '120000') problems.push(`${raw[i + 1]}: symlinks are not allowed in the hub`);
  }
  for (const change of changes) {
    if (change.status === 'D') continue;
    const staged = await git.tryRun(['show', `:${change.path}`]);
    if (!staged.ok) {
      problems.push(`${change.path}: could not read staged content`);
      continue;
    }
    const found = findSecrets(staged.out);
    if (found.length) problems.push(`${change.path}: possible secret (${found.join(', ')})`);
  }
  return problems;
}
