export interface JiraCall {
  url: URL;
  method: string;
  redirect?: string;
  headers: Record<string, string>;
}

// A fetchFn serving canned JSON by URL pathname. A route may be a function of the URL (for paging).
export function jiraFetch(routes: Record<string, unknown | ((url: URL) => unknown)>) {
  const calls: JiraCall[] = [];
  const fn = (async (url: URL, init: RequestInit) => {
    calls.push({ url, method: String(init.method), redirect: init.redirect, headers: init.headers as Record<string, string> });
    const r = routes[url.pathname];
    if (r === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(typeof r === 'function' ? (r as (u: URL) => unknown)(url) : r), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

export const CLOUD = { flavor: 'cloud', email: 'dev@example.com', token: 'cloudtok-123' } as const;
export const SERVER = { flavor: 'server', token: 'pat-456' } as const;

export const FIELDS = [
  { id: 'summary', name: 'Summary' },
  { id: 'customfield_10020', name: 'Sprint (agile)', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
  { id: 'customfield_10030', name: 'Team', schema: { custom: 'x:select' } },
];

export function issue(key: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    fields: {
      summary: 'Fix checkout',
      description: null,
      updated: '2026-10-01T10:00:00.000+0000',
      duedate: '2026-10-20',
      status: { name: 'In Progress' },
      priority: { name: 'High' },
      components: [{ name: 'Payments' }, { name: 'Web' }],
      labels: ['urgent', 'q4'],
      project: { key: 'WEB' },
      security: null,
      customfield_10020: [{ name: 'Sprint 4', state: 'active', boardId: 12 }],
      customfield_10030: { value: 'Acme core' },
      ...extra,
    },
  };
}
