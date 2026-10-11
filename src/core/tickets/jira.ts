import { HubError, normalizeTicketId } from '../types';
import { adfToText } from './adf';
import type { Discovery, Ticket, TicketComment, TicketSource } from './types';

export const JIRA_TIMEOUT_MS = 5_000;
const MAX_PAGES = 50;
const PAGE_SIZE = 100;
const BASE_FIELDS = 'summary,description,updated,duedate,parent,status,priority,components,labels,project,security';
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,19}$/;

export type JiraAuth = { flavor: 'cloud'; email: string; token: string } | { flavor: 'server'; token: string };

interface JiraIssue {
  key: string;
  fields: Record<string, unknown>;
  names?: Record<string, string>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const named = (v: unknown): string | null => str(obj(v).name);

// Read-only by construction: `#get` is the only code path that reaches fetch and it
// hardcodes the GET method. There is no public request method that takes a verb.
export class JiraClient implements TicketSource, Discovery {
  readonly kind = 'jira' as const;
  readonly label = 'Jira';
  readonly #base: string;
  readonly #auth: JiraAuth;
  readonly #projects: string[];
  readonly #fetchFn: typeof fetch;
  readonly #timeoutMs: number;
  #sprintField: string | null | undefined;

  constructor(baseUrl: string, auth: JiraAuth, opts: { projects?: string[]; fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.#base = baseUrl.trim().replace(/\/+$/, '');
    this.#auth = auth;
    this.#projects = (opts.projects ?? []).map((p) => this.#projectKey(p));
    this.#fetchFn = opts.fetchFn ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? JIRA_TIMEOUT_MS;
  }

  get #api(): string {
    return this.#auth.flavor === 'cloud' ? '/rest/api/3' : '/rest/api/2';
  }

  #projectKey(k: string): string {
    if (!PROJECT_KEY.test(k)) throw new HubError('BAD_PROJECT', `invalid Jira project key: ${String(k)}`);
    return k;
  }

  #authHeader(): string {
    const a = this.#auth;
    return a.flavor === 'cloud'
      ? 'Basic ' + Buffer.from(`${a.email}:${a.token}`).toString('base64')
      : `Bearer ${a.token}`;
  }

  async #get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const signal = AbortSignal.timeout(this.#timeoutMs);
    const unreachable = () => new HubError('JIRA_NETWORK', `Could not reach Jira at ${this.#base}. Check the URL and your network.`);
    let res: Response;
    try {
      res = await this.#fetchFn(url, {
        method: 'GET',
        headers: { Authorization: this.#authHeader(), Accept: 'application/json' },
        redirect: 'error',
        signal,
      });
    } catch {
      // The underlying error is dropped on purpose: it may carry request details.
      throw unreachable();
    }
    if (res.status === 401 || res.status === 403) {
      throw new HubError('JIRA_AUTH', 'Jira rejected your login. Check the email and API token (Cloud) or personal access token (self-hosted).');
    }
    if (!res.ok) throw new HubError('JIRA_HTTP', `Jira returned ${res.status} for ${path}`);
    try {
      return (await res.json()) as T;
    } catch {
      if (signal.aborted) throw unreachable();
      throw new HubError('JIRA_HTTP', `Jira returned an unreadable response for ${path}`);
    }
  }

  #scopeJql(scope: string[]): string {
    return scope.length ? `project in (${scope.map((k) => this.#projectKey(k)).join(', ')})` : '';
  }

  normalizeId(raw: string): string {
    let id: string;
    try {
      id = normalizeTicketId(raw);
    } catch {
      throw new HubError('BAD_TICKET', `invalid ticket id: ${String(raw)}`);
    }
    if (/^\d+$/.test(id)) throw new HubError('BAD_TICKET', `invalid Jira ticket id: ${id} (expected a key like WEB-123)`);
    return id;
  }

  async whoAmI(): Promise<{ id: string; name: string }> {
    const me = obj(await this.#get(`${this.#api}/myself`));
    const id = str(me.accountId) ?? str(me.name) ?? str(me.key) ?? '';
    return { id, name: str(me.displayName) ?? id };
  }

  #resolveSprint(names: Record<string, string> | undefined): void {
    if (this.#sprintField !== undefined || !names) return;
    this.#sprintField = Object.entries(names).find(([, n]) => n === 'Sprint')?.[0] ?? null;
  }

  async #search(jql: string, max: number): Promise<JiraIssue[]> {
    const cloud = this.#auth.flavor === 'cloud';
    const path = `${this.#api}${cloud ? '/search/jql' : '/search'}`;
    const out: JiraIssue[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    let startAt = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const fields = this.#sprintField === undefined ? '*all' : [BASE_FIELDS, this.#sprintField].filter(Boolean).join(',');
      const params: Record<string, string> = { jql, fields, expand: 'names', maxResults: String(Math.min(PAGE_SIZE, max - out.length)) };
      if (cloud && token) params.nextPageToken = token;
      if (!cloud) params.startAt = String(startAt);
      const res = obj(await this.#get(path, params));
      if (!Array.isArray(res.issues)) throw new HubError('JIRA_HTTP', `Jira returned no issue list for ${path}`);
      this.#resolveSprint(res.names as Record<string, string> | undefined);
      const issues = res.issues as JiraIssue[];
      out.push(...issues.map((i) => ({ ...i, names: res.names as Record<string, string> | undefined })));
      if (out.length >= max) return out.slice(0, max);
      if (cloud) {
        const next = str(res.nextPageToken);
        if (!next || res.isLast === true) return out;
        if (seen.has(next)) throw new HubError('JIRA_PAGINATION', `Jira repeated a page token for ${path}`);
        seen.add(next);
        token = next;
      } else {
        startAt += issues.length;
        const total = typeof res.total === 'number' ? res.total : 0;
        if (issues.length === 0 || startAt >= total) return out;
      }
    }
    throw new HubError('JIRA_PAGINATION', `Jira pagination for ${path} did not finish in ${MAX_PAGES} pages`);
  }

  #text(v: unknown): string {
    return this.#auth.flavor === 'cloud' ? adfToText(v) : (str(v) ?? '');
  }

  #toTicket(issue: JiraIssue): Ticket {
    const f = issue.fields ?? {};
    const names = issue.names ?? {};
    const sprintId = this.#sprintField ?? Object.entries(names).find(([, n]) => n === 'Sprint')?.[0] ?? null;
    const listNames = (v: unknown) => (Array.isArray(v) ? v.map(named).filter((n): n is string => !!n) : []);
    const components = listNames(f.components);
    const labels = Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === 'string') : [];
    const fields: Ticket['fields'] = [];
    if (components.length) fields.push({ name: 'Components', value: components.join(', ') });
    if (labels.length) fields.push({ name: 'Labels', value: labels.join(', ') });
    for (const [key, value] of Object.entries(f)) {
      if (!key.startsWith('customfield_') || key === sprintId || !names[key]) continue;
      const v = str(value) ?? str(obj(value).value);
      if (v) fields.push({ name: names[key], value: v });
    }
    const parent = obj(f.parent);
    const projectKey = str(obj(f.project).key);
    return {
      id: issue.key,
      title: str(f.summary) ?? '',
      notes: this.#text(f.description),
      modifiedAt: str(f.updated) ?? '',
      due: str(f.duedate),
      url: `${this.#base}/browse/${issue.key}`,
      parent: str(parent.key) ? { id: parent.key as string, title: str(obj(parent.fields).summary) ?? '' } : null,
      status: named(f.status),
      priority: named(f.priority),
      fields,
      components,
      labels,
      containers: projectKey ? [projectKey] : [],
      sections: [],
      sprints: sprintId ? this.#sprints(f[sprintId]) : [],
      restricted: f.security != null,
    };
  }

  #sprints(v: unknown): Ticket['sprints'] {
    if (!Array.isArray(v)) return [];
    return v.flatMap((s): Ticket['sprints'] => {
      if (typeof s === 'string') {
        // Older self-hosted Jira serializes sprints as "...Sprint@1[id=3,rapidViewId=12,state=ACTIVE,name=Sprint 4,...]".
        const name = /name=([^,\]]*)/.exec(s)?.[1];
        if (!name) return [];
        const board = /rapidViewId=(\d+)/.exec(s)?.[1];
        return [{ name, active: /state=ACTIVE/i.test(s), boardId: board ? Number(board) : null }];
      }
      const o = obj(s);
      const name = str(o.name);
      if (!name) return [];
      return [{ name, active: String(o.state).toLowerCase() === 'active', boardId: typeof o.boardId === 'number' ? o.boardId : null }];
    });
  }

  async myTickets(): Promise<Ticket[]> {
    const scope = this.#scopeJql(this.#projects);
    const jql = 'assignee = currentUser() AND statusCategory != Done' + (scope ? ` AND ${scope}` : '');
    return (await this.#search(jql, 1000)).map((i) => this.#toTicket(i));
  }

  async ticket(id: string): Promise<Ticket> {
    const key = this.normalizeId(id);
    const issue = obj(await this.#get(`${this.#api}/issue/${key}`, { expand: 'names' }));
    this.#resolveSprint(issue.names as Record<string, string> | undefined);
    if (typeof issue.key !== 'string') throw new HubError('JIRA_HTTP', `Jira returned no issue for /issue/${key}`);
    return this.#toTicket(issue as unknown as JiraIssue);
  }

  async comments(id: string, limit = 10): Promise<TicketComment[]> {
    const key = this.normalizeId(id);
    if (limit <= 0) return [];
    const res = obj(await this.#get(`${this.#api}/issue/${key}/comment`, { orderBy: '-created', maxResults: String(limit) }));
    if (!Array.isArray(res.comments)) throw new HubError('JIRA_HTTP', `Jira returned no comment list for /issue/${key}/comment`);
    return (res.comments as Obj[])
      .map((c) => ({ createdAt: str(c.created) ?? '', author: str(obj(c.author).displayName) ?? 'unknown', text: this.#text(c.body) }))
      .reverse();
  }

  async scopes(): Promise<Array<{ id: string; name: string }>> {
    let projects: unknown[];
    if (this.#auth.flavor === 'cloud') {
      projects = [];
      for (let startAt = 0, page = 0; page < MAX_PAGES; page++) {
        const res = obj(await this.#get(`${this.#api}/project/search`, { startAt: String(startAt), maxResults: String(PAGE_SIZE) }));
        const values = Array.isArray(res.values) ? res.values : [];
        projects.push(...values);
        startAt += values.length;
        if (res.isLast !== false || values.length === 0) break;
      }
    } else {
      const res = await this.#get<unknown>(`${this.#api}/project`);
      projects = Array.isArray(res) ? res : [];
    }
    return projects.flatMap((p) => {
      const o = obj(p);
      const key = str(o.key);
      return key ? [{ id: key, name: str(o.name) ?? key }] : [];
    });
  }

  async sample(scope: string[], limit: number): Promise<Ticket[]> {
    const where = this.#scopeJql(scope);
    return (await this.#search(`${where ? where + ' ' : ''}ORDER BY updated DESC`, limit)).map((i) => this.#toTicket(i));
  }

  async statuses(scope: string[]): Promise<string[]> {
    const out = new Set<string>();
    for (const key of scope) {
      const res = await this.#get<unknown>(`${this.#api}/project/${this.#projectKey(key)}/statuses`);
      for (const type of Array.isArray(res) ? res : []) {
        const list = obj(type).statuses;
        for (const s of Array.isArray(list) ? list : []) {
          const n = named(s);
          if (n) out.add(n);
        }
      }
    }
    return [...out];
  }

  async priorities(): Promise<string[]> {
    const res = await this.#get<unknown>(`${this.#api}/priority`);
    return (Array.isArray(res) ? res : []).map(named).filter((n): n is string => !!n);
  }

  async boards(scope: string[]): Promise<Array<{ id: number; name: string }>> {
    const out: Array<{ id: number; name: string }> = [];
    for (const key of scope) {
      const res = obj(await this.#get('/rest/agile/1.0/board', { projectKeyOrId: this.#projectKey(key) }));
      for (const b of Array.isArray(res.values) ? (res.values as Obj[]) : []) {
        if (typeof b.id === 'number' && str(b.name) && !out.some((o) => o.id === b.id)) out.push({ id: b.id, name: b.name as string });
      }
    }
    return out;
  }
}
