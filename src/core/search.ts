import { realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { listMd, readDoc } from './hubfs';
import { HubError, assertName } from './types';

export interface SearchQuery {
  text?: string;
  person?: string;
  site?: string;
  type?: string;
  since?: string;
  limit?: number;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
  data: Record<string, unknown>;
  links: string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SKIPPED_DIRS = new Set(['inbox', '.git']);

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function dateOf(data: Record<string, unknown>): string {
  const value = data.date ?? data.created;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value === undefined || value === null ? '' : String(value);
}

function assertQuery(q: SearchQuery): void {
  if (q.person !== undefined) assertName(q.person);
  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1)) {
    throw new HubError('BAD_INPUT', `limit must be a positive integer: ${String(q.limit)}`);
  }
  if (q.since !== undefined && (!DATE.test(q.since) || Number.isNaN(Date.parse(q.since)))) {
    throw new HubError('BAD_INPUT', `since must be a YYYY-MM-DD date: ${q.since}`);
  }
}

// A file is in scope only if it is a real file inside the hub (symlinks may not point out)
// and no directory on its path below the hub is inbox/ or .git/.
function inScope(hubDir: string, hubReal: string, file: string): boolean {
  const rel = relative(hubDir, file).split(sep);
  if (rel.some((segment) => SKIPPED_DIRS.has(segment))) return false;
  try {
    const real = realpathSync(file);
    return real.startsWith(hubReal + sep);
  } catch {
    return false;
  }
}

export function search(hubDir: string, q: SearchQuery): SearchHit[] {
  assertQuery(q);
  const root = resolve(hubDir);
  const hubReal = realpathSync(root);
  const roots = q.person ? [join(root, 'people', q.person)] : [join(root, 'shared'), join(root, 'people')];
  const terms = (q.text ?? '').toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const hits: SearchHit[] = [];
  for (const file of roots.flatMap(listMd)) {
    if (basename(file) === '_index.md') continue;
    if (!inScope(root, hubReal, file)) continue;
    let doc: ReturnType<typeof readDoc>;
    try {
      doc = readDoc(file);
    } catch {
      continue; // a corrupt or unreadable file is skipped, not fatal
    }
    const { data, body } = doc;
    if (q.type && data.type !== q.type) continue;
    if (q.site) {
      const codes = String(data.site ?? '').toLowerCase().split(',').map((s) => s.trim());
      if (!codes.includes(q.site.toLowerCase())) continue;
    }
    const date = dateOf(data);
    if (q.since && date < q.since) continue;
    const title = /^# (.+)$/m.exec(body)?.[1]?.trim() ?? basename(file, '.md');
    const lowerBody = body.toLowerCase();
    const lowerTitle = title.toLowerCase();
    const score = terms.reduce((sum, t) => sum + count(lowerBody, t) + 3 * count(lowerTitle, t), 0);
    if (terms.length && score === 0) continue;
    const first = terms.map((t) => lowerBody.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const snippet = body.slice(Math.max(0, first - 60), first + 100).replace(/\s+/g, ' ').trim();
    const links = [...body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim());
    hits.push({ path: relative(root, file).split(sep).join('/'), title, snippet, score, data, links });
  }
  hits.sort((a, b) => b.score - a.score || dateOf(b.data).localeCompare(dateOf(a.data)));
  return hits.slice(0, q.limit ?? 10);
}
