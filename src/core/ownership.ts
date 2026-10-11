import { HubError, assertName } from './types';

export interface Change {
  status: 'A' | 'M' | 'D';
  path: string;
}

// Parses `git diff --cached -z --name-status --no-renames`-style output
// (STATUS\0path\0 records). Renames and copies (R/C with two paths) are
// split into a delete of the old path and an add of the new path, so the
// old location is still checked.
export function parseNameStatus(out: string): Change[] {
  if (out === '') return [];
  const tokens = out.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();
  const changes: Change[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!/^[AMDTRC]\d*$/.test(code)) throw new HubError('BAD_DIFF', `unknown status in git output: ${JSON.stringify(code)}`);
    const kind = code[0];
    const count = kind === 'R' || kind === 'C' ? 2 : 1;
    const paths = tokens.slice(i, i + count);
    i += count;
    if (paths.length !== count || paths.some((p) => p === undefined || p === '')) {
      throw new HubError('BAD_DIFF', `malformed git output record for status ${code}`);
    }
    if (kind === 'R' || kind === 'C') {
      changes.push({ status: 'D', path: paths[0] }, { status: 'A', path: paths[1] });
    } else {
      const status: Change['status'] = kind === 'A' ? 'A' : kind === 'D' ? 'D' : 'M';
      changes.push({ status, path: paths[0] });
    }
  }
  return changes;
}

function isUnsafePath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\')) return true;
  return path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

export function checkChanges(user: string, changes: Change[]): string[] {
  assertName(user);
  const violations: string[] = [];
  for (const change of changes) {
    if (isUnsafePath(change.path)) {
      violations.push(`${change.path}: unsafe path (empty, dot, traversal, backslash or absolute)`);
      continue;
    }
    const parts = change.path.split('/');
    const top = parts[0];
    if (parts.length === 1) continue;
    if (top === 'people') {
      if (parts[1] !== user) violations.push(`${change.path}: only ${parts[1]} may change people/${parts[1]}/`);
    } else if (top === 'inbox') {
      if (parts[1] !== user && change.status !== 'A') {
        violations.push(`${change.path}: you may only add new messages to inbox/${parts[1]}/`);
      }
    } else if (top === 'shared' || top === 'config') {
      if (change.status === 'D') violations.push(`${change.path}: deleting from ${top}/ is not allowed`);
    } else {
      violations.push(`${change.path}: unknown top-level folder ${top}/`);
    }
  }
  return violations;
}
