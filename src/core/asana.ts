import { hubCommand } from './command';
import { HubError, assertGid } from './types';

export interface AsanaTask {
  gid: string;
  name: string;
  notes?: string;
  modified_at: string;
  due_on?: string | null;
  completed?: boolean;
  parent?: { gid: string; name: string } | null;
  memberships: Array<{ project?: { gid: string; name: string }; section?: { gid: string; name: string } }>;
  custom_fields: Array<{ name: string; display_value: string | null }>;
  permalink_url?: string;
}

export interface AsanaComment {
  created_at: string;
  author: string;
  text: string;
}

export interface AsanaReader {
  getMyTasks(workspace: string): Promise<AsanaTask[]>;
  getTask(gid: string): Promise<AsanaTask>;
  getComments(gid: string, limit?: number): Promise<AsanaComment[]>;
}

const DEFAULT_BASE = 'https://app.asana.com/api/1.0';
const MAX_PAGES = 50;
// Each request (headers and body) is aborted after this, so a hanging Asana cannot hold a caller.
export const ASANA_TIMEOUT_MS = 5_000;

const TASK_FIELDS = [
  'name', 'notes', 'modified_at', 'due_on', 'completed', 'permalink_url', 'parent.name',
  'memberships.project.name', 'memberships.section.name', 'custom_fields.name', 'custom_fields.display_value',
].join(',');

interface Page<T> {
  data: T;
  next_page?: { offset: string } | null;
}

interface RawStory {
  created_at: string;
  created_by: { name: string } | null;
  text: string;
  resource_subtype: string;
}

// Read-only by construction: `#get` is the only code path that reaches fetch and it
// hardcodes the GET method. There is no public request method that takes a verb.
export class AsanaClient implements AsanaReader {
  readonly #token: string;
  readonly #fetchFn: typeof fetch;
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(token: string, fetchFn: typeof fetch = fetch, base: string = DEFAULT_BASE, timeoutMs: number = ASANA_TIMEOUT_MS) {
    this.#token = token;
    this.#fetchFn = fetchFn;
    this.#base = base;
    this.#timeoutMs = timeoutMs;
  }

  async #get<T>(path: string, params: Record<string, string> = {}): Promise<Page<T>> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      res = await this.#fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' },
        redirect: 'error',
        signal,
      });
    } catch {
      // The underlying error is dropped on purpose: it may carry request details.
      throw new HubError('ASANA_NETWORK', 'Could not reach Asana. Check the network connection and retry.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new HubError('ASANA_AUTH', `Asana rejected the token (run in a terminal: ${hubCommand('token set')})`);
    }
    if (!res.ok) throw new HubError('ASANA_HTTP', `Asana returned ${res.status} for ${path}`);
    try {
      return (await res.json()) as Page<T>;
    } catch {
      if (signal.aborted) throw new HubError('ASANA_NETWORK', 'Asana did not answer in time. Check the network connection and retry.');
      throw new HubError('ASANA_HTTP', `Asana returned an unreadable response for ${path}`);
    }
  }

  async #object<T>(path: string, params: Record<string, string>): Promise<T> {
    const data: unknown = (await this.#get<T>(path, params)).data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new HubError('ASANA_HTTP', `Asana returned no object for ${path}`);
    }
    return data as T;
  }

  async #all<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let offset: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.#get<T[]>(path, offset ? { ...params, offset } : params);
      if (!Array.isArray(res.data)) throw new HubError('ASANA_HTTP', `Asana returned no list for ${path}`);
      out.push(...res.data);
      const next = res.next_page?.offset;
      if (!next) return out;
      if (seen.has(next)) throw new HubError('ASANA_PAGINATION', `Asana repeated a page offset for ${path}`);
      seen.add(next);
      offset = next;
    }
    throw new HubError('ASANA_PAGINATION', `Asana pagination for ${path} did not finish in ${MAX_PAGES} pages`);
  }

  async getMe(): Promise<{ gid: string; name: string; workspaces: Array<{ gid: string; name: string }> }> {
    return this.#object<{ gid: string; name: string; workspaces: Array<{ gid: string; name: string }> }>(
      '/users/me', { opt_fields: 'name,workspaces.name' },
    );
  }

  async getMyTasks(workspace: string): Promise<AsanaTask[]> {
    assertGid(workspace);
    return this.#all<AsanaTask>('/tasks', {
      assignee: 'me', workspace, completed_since: 'now', limit: '100', opt_fields: TASK_FIELDS,
    });
  }

  async getTask(gid: string): Promise<AsanaTask> {
    assertGid(gid);
    return this.#object<AsanaTask>(`/tasks/${gid}`, { opt_fields: TASK_FIELDS });
  }

  async getComments(gid: string, limit = 10): Promise<AsanaComment[]> {
    assertGid(gid);
    if (limit <= 0) return [];
    const stories = await this.#all<RawStory>(`/tasks/${gid}/stories`, {
      opt_fields: 'created_at,created_by.name,text,resource_subtype',
    });
    return stories
      .filter((s) => s.resource_subtype === 'comment_added')
      .slice(-limit)
      .map((s) => ({ created_at: s.created_at, author: s.created_by?.name ?? 'unknown', text: s.text }));
  }
}

export function fieldValue(task: AsanaTask, prefix: string): string | null {
  const p = prefix.toLowerCase();
  const f = (task.custom_fields ?? []).find((c) => c.name.toLowerCase().startsWith(p) && c.display_value);
  return f?.display_value ?? null;
}

export async function parentChain(asana: AsanaReader, task: AsanaTask, max = 5): Promise<AsanaTask[]> {
  const chain = [task];
  const seen = new Set<string>([task.gid]);
  let current = task;
  while (current.parent && chain.length <= max) {
    const parentGid = current.parent.gid;
    if (seen.has(parentGid)) break; // parent cycle: stop rather than repeat a task
    seen.add(parentGid);
    current = await asana.getTask(parentGid);
    chain.push(current);
  }
  return chain;
}
