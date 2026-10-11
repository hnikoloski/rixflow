import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HubError } from '../../../src/core/types';
import { JiraClient } from '../../../src/core/tickets/jira';
import { CLOUD, FIELDS, SERVER, issue, jiraFetch } from '../../fixtures/jira';

const CLOUD_URL = 'https://acme.atlassian.net';
const SERVER_URL = 'https://jira.example.com/jira';

describe('JiraClient requests', () => {
  it('cloud: GET, no redirects, Basic auth, api v3', async () => {
    const { fn, calls } = jiraFetch({ '/rest/api/3/myself': { accountId: 'a1', displayName: 'Dana' } });
    const me = await new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn }).whoAmI();
    expect(me).toEqual({ id: 'a1', name: 'Dana' });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].redirect).toBe('error');
    expect(calls[0].headers.Authorization).toBe('Basic ' + Buffer.from('dev@example.com:cloudtok-123').toString('base64'));
  });

  it('server: Bearer auth and api v2', async () => {
    const { fn, calls } = jiraFetch({ '/jira/rest/api/2/myself': { name: 'dana', displayName: 'Dana' } });
    await new JiraClient(SERVER_URL, SERVER, { fetchFn: fn }).whoAmI();
    expect(calls[0].headers.Authorization).toBe('Bearer pat-456');
  });

  it('keeps a context path', async () => {
    const { fn, calls } = jiraFetch({ '/jira/rest/api/2/myself': { name: 'dana', displayName: 'Dana' } });
    await new JiraClient('https://jira.example.com/jira/', SERVER, { fetchFn: fn }).whoAmI();
    expect(calls[0].url.pathname).toBe('/jira/rest/api/2/myself');
  });

  it('explains an unreachable server', async () => {
    const fn = (async () => { throw new Error('ECONNREFUSED Authorization: Bearer pat-456'); }) as unknown as typeof fetch;
    const err = await new JiraClient(SERVER_URL, SERVER, { fetchFn: fn }).whoAmI().catch((e) => e);
    expect(err.code).toBe('JIRA_NETWORK');
    expect(err.message).toBe(`Could not reach Jira at ${SERVER_URL}. Check the URL and your network.`);
    expect(err.message).not.toContain('pat-456');
  });

  it('maps 401 to JIRA_AUTH and other failures to JIRA_HTTP', async () => {
    const f401 = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(new JiraClient(CLOUD_URL, CLOUD, { fetchFn: f401 }).whoAmI()).rejects.toMatchObject({ code: 'JIRA_AUTH' });
    const f500 = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(new JiraClient(CLOUD_URL, CLOUD, { fetchFn: f500 }).whoAmI()).rejects.toMatchObject({ code: 'JIRA_HTTP' });
  });

  it('rejects digit-only ids and normalizes lower-case keys', () => {
    const c = new JiraClient(CLOUD_URL, CLOUD, { fetchFn: jiraFetch({}).fn });
    expect(c.normalizeId('web-123')).toBe('WEB-123');
    expect(() => c.normalizeId('12345')).toThrowError(expect.objectContaining({ code: 'BAD_TICKET' }));
  });
});

describe('JiraClient tickets', () => {
  it('cloud search scopes JQL, pages by token, and maps fields', async () => {
    let n = 0;
    const { fn, calls } = jiraFetch({
      '/rest/api/3/field': FIELDS,
      '/rest/api/3/search/jql': () => (n++ === 0
        ? { issues: [issue('WEB-1', { security: { name: 'Internal' } })], nextPageToken: 't2' }
        : { issues: [issue('OPS-2')] }),
    });
    const tickets = await new JiraClient(CLOUD_URL, CLOUD, { projects: ['WEB', 'OPS'], fetchFn: fn }).myTickets();
    const searches = calls.filter((c) => c.url.pathname.endsWith('/search/jql'));
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(searches[0].url.searchParams.get('jql')).toBe('assignee = currentUser() AND statusCategory != Done AND project in (WEB, OPS)');
    expect(searches[1].url.searchParams.get('nextPageToken')).toBe('t2');
    expect(searches[1].url.searchParams.get('fields')).toBe(searches[0].url.searchParams.get('fields'));
        expect(searches[0].url.searchParams.get('fields')).toBe('*all,-comment,-worklog,-attachment,-issuelinks,-subtasks');
    expect(tickets.map((t) => t.id)).toEqual(['WEB-1', 'OPS-2']);
    const t = tickets[0];
    expect(t.restricted).toBe(true);
    expect(tickets[1].restricted).toBe(false);
    expect(t.sprints).toEqual([{ name: 'Sprint 4', active: true, boardId: 12 }]);
    expect(t.containers).toEqual(['WEB']);
    expect(t.status).toBe('In Progress');
    expect(t.priority).toBe('High');
    expect(t.url).toBe('https://acme.atlassian.net/browse/WEB-1');
    expect(t.fields).toEqual([
      { name: 'Components', value: 'Payments, Web' },
      { name: 'Labels', value: 'urgent, q4' },
      { name: 'Team', value: 'Acme core' },
    ]);
  });

  it('pagination stops on a repeated token', async () => {
    const { fn } = jiraFetch({ '/rest/api/3/field': FIELDS, '/rest/api/3/search/jql': { issues: [issue('WEB-1')], nextPageToken: 'same' } });
    await expect(new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn }).myTickets()).rejects.toMatchObject({ code: 'JIRA_PAGINATION' });
  });

  it('server search pages by startAt and reads plain-text bodies', async () => {
    const { fn, calls } = jiraFetch({
      '/jira/rest/api/2/field': FIELDS,
      '/jira/rest/api/2/search': (u: URL) => (u.searchParams.get('startAt') === '0'
        ? { issues: [issue('WEB-1', { description: 'plain text' })], total: 2 }
        : { issues: [issue('WEB-2')], total: 2 }),
    });
    const tickets = await new JiraClient(SERVER_URL, SERVER, { fetchFn: fn }).myTickets();
    expect(tickets.map((t) => t.id)).toEqual(['WEB-1', 'WEB-2']);
    expect(tickets[0].notes).toBe('plain text');
    expect(calls.filter((c) => c.url.pathname.endsWith('/search'))[1].url.searchParams.get('startAt')).toBe('1');
  });

  it('ticket() converts ADF; comments() are oldest first', async () => {
    const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] };
    const { fn, calls } = jiraFetch({
      '/rest/api/3/field': FIELDS,
      '/rest/api/3/issue/WEB-9': { ...issue('WEB-9', { description: adf, parent: { key: 'WEB-1', fields: { summary: 'Epic' } } }) },
      '/rest/api/3/issue/WEB-9/comment': { comments: [
        { created: '2026-10-02', author: { displayName: 'B' }, body: adf },
        { created: '2026-10-01', author: { displayName: 'A' }, body: adf },
      ] },
    });
    const c = new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn });
    const t = await c.ticket('web-9');
    expect(t.notes).toBe('body');
    expect(t.parent).toEqual({ id: 'WEB-1', title: 'Epic' });
    const cs = await c.comments('WEB-9', 5);
    expect(cs.map((x) => x.author)).toEqual(['A', 'B']);
    const cc = calls.find((c) => c.url.pathname.endsWith('/comment'))!;
    expect(cc.url.searchParams.get('orderBy')).toBe('-created');
    expect(cc.url.searchParams.get('maxResults')).toBe('5');
  });
});

describe('JiraClient discovery', () => {
  it('lists projects, statuses, priorities and boards (all GET)', async () => {
    const { fn, calls } = jiraFetch({
      '/rest/api/3/project/search': { values: [{ key: 'WEB', name: 'Website' }], isLast: true },
      '/rest/api/3/project/WEB/statuses': [{ statuses: [{ name: 'To Do' }, { name: 'Done' }] }, { statuses: [{ name: 'Done' }] }],
      '/rest/api/3/priority': [{ name: 'High' }, { name: 'Low' }],
      '/rest/agile/1.0/board': { values: [{ id: 12, name: 'Web board' }] },
    });
    const c = new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn });
    expect(await c.scopes()).toEqual([{ id: 'WEB', name: 'Website' }]);
    expect(await c.statuses(['WEB'])).toEqual(['To Do', 'Done']);
    expect(await c.priorities()).toEqual(['High', 'Low']);
    expect(await c.boards(['WEB'])).toEqual([{ id: 12, name: 'Web board' }]);
    expect(calls.every((x) => x.method === 'GET')).toBe(true);
  });

  it('server lists projects from /project', async () => {
    const { fn } = jiraFetch({ '/jira/rest/api/2/project': [{ key: 'OPS', name: 'Operations' }] });
    expect(await new JiraClient(SERVER_URL, SERVER, { fetchFn: fn }).scopes()).toEqual([{ id: 'OPS', name: 'Operations' }]);
  });
});

describe('JiraClient hardening', () => {
  it('maps custom fields on page 2 and on a second call', async () => {
    const pages = [
      { issues: [issue('WEB-1')], nextPageToken: 'p2' },
      { issues: [issue('WEB-2')] },
    ];
    let n = 0;
    const { fn, calls } = jiraFetch({ '/rest/api/3/field': FIELDS, '/rest/api/3/search/jql': () => pages[n++ % 2] });
    const c = new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn });
    const first = await c.myTickets();
    const second = await c.myTickets();
    for (const t of [...first, ...second]) expect(t.fields.some((f) => f.name === 'Team' && f.value === 'Acme core')).toBe(true);
    expect(calls.filter((x) => x.url.pathname.endsWith('/field')).length).toBe(1);
  });

  it('finds the sprint field by name when there is no schema', async () => {
    const { fn } = jiraFetch({
      '/rest/api/3/field': [{ id: 'customfield_10020', name: 'Sprint' }],
      '/rest/api/3/search/jql': { issues: [issue('WEB-1')] },
    });
    expect((await new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn }).myTickets())[0].sprints[0].name).toBe('Sprint 4');
  });

  it('parses the legacy server sprint string', async () => {
    const legacy = 'com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=3,rapidViewId=12,state=ACTIVE,name=Sprint 4,goal=]';
    const { fn } = jiraFetch({
      '/jira/rest/api/2/field': FIELDS,
      '/jira/rest/api/2/search': { issues: [issue('WEB-1', { customfield_10020: [legacy] })], total: 1 },
    });
    const t = (await new JiraClient(SERVER_URL, SERVER, { fetchFn: fn }).myTickets())[0];
    expect(t.sprints).toEqual([{ name: 'Sprint 4', active: true, boardId: 12 }]);
  });

  it('403 is JIRA_AUTH', async () => {
    const f = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    await expect(new JiraClient(CLOUD_URL, CLOUD, { fetchFn: f }).whoAmI()).rejects.toMatchObject({ code: 'JIRA_AUTH' });
  });

  it('stops a runaway of distinct page tokens', async () => {
    let n = 0;
    const { fn } = jiraFetch({ '/rest/api/3/field': FIELDS, '/rest/api/3/search/jql': () => ({ issues: [issue('WEB-1')], nextPageToken: `t${n++}` }) });
    await expect(new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn }).myTickets()).rejects.toMatchObject({ code: 'JIRA_PAGINATION' });
    expect(n).toBe(50);
  });

  it('drops search results whose key is not a Jira key', async () => {
    const { fn } = jiraFetch({ '/rest/api/3/field': FIELDS, '/rest/api/3/search/jql': { issues: [issue('../evil'), issue('WEB-1')] } });
    expect((await new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn }).myTickets()).map((t) => t.id)).toEqual(['WEB-1']);
  });

  it('sample() with no scope makes no request and clamps the limit', async () => {
    const { fn, calls } = jiraFetch({ '/rest/api/3/field': FIELDS, '/rest/api/3/search/jql': { issues: [] } });
    const c = new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn });
    expect(await c.sample([], 10)).toEqual([]);
    expect(calls.length).toBe(0);
    await c.sample(['WEB'], 5000);
    expect(calls.find((x) => x.url.pathname.endsWith('/search/jql'))!.url.searchParams.get('maxResults')).toBe('100');
  });

  it('whoAmI without an id fails', async () => {
    const { fn } = jiraFetch({ '/rest/api/3/myself': { displayName: 'Dana' } });
    await expect(new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn }).whoAmI()).rejects.toMatchObject({ code: 'JIRA_HTTP', message: 'Jira returned no user id for /myself' });
  });

  it.each([
    'http://jira.example.com', 'https://user:pw@jira.example.com', 'https://jira.example.com/?a=1', 'https://jira.example.com/#x', 'not a url', 'ftp://jira.example.com',
  ])('rejects base URL %s', (u) => {
    expect(() => new JiraClient(u, SERVER)).toThrowError(expect.objectContaining({ code: 'JIRA_BAD_URL' }));
    expect(() => new JiraClient(u, SERVER)).toThrow(HubError);
  });

  it('uses the normalized base in request and ticket urls', async () => {
    const { fn, calls } = jiraFetch({ '/jira/rest/api/2/myself': { name: 'd' } });
    await new JiraClient('https://jira.example.com/jira//', SERVER, { fetchFn: fn }).whoAmI();
    expect(calls[0].url.pathname).toBe('/jira/rest/api/2/myself');
  });
});

describe('JiraClient search field list', () => {
  it('keeps the URL short with 1000 custom fields and sends the same fields on every page', async () => {
    const many = [...FIELDS, ...Array.from({ length: 1000 }, (_, i) => ({ id: `customfield_2${String(i).padStart(4, '0')}`, name: `F${i}` }))];
    const pages = [{ issues: [issue('WEB-1')], nextPageToken: 'p2' }, { issues: [issue('WEB-2')] }];
    let n = 0;
    const { fn, calls } = jiraFetch({ '/rest/api/3/field': many, '/rest/api/3/search/jql': () => pages[n++] });
    const t = await new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn }).myTickets();
    const searches = calls.filter((c) => c.url.pathname.endsWith('/search/jql'));
    expect(searches.length).toBe(2);
    for (const c of searches) expect(c.url.toString().length).toBeLessThan(8000);
    expect(searches[0].url.searchParams.get('fields')).toBe(searches[1].url.searchParams.get('fields'));
    expect(t.every((x) => x.fields.some((f) => f.name === 'Team'))).toBe(true);
  });
});

describe('read-only by construction', () => {
  it('jira.ts has one fetch call and one hardcoded GET', () => {
    const src = readFileSync('src/core/tickets/jira.ts', 'utf8');
    expect(src.split('fetchFn(').length - 1).toBe(1);
    expect(src.split("method: 'GET'").length - 1).toBe(1);
    expect(src).not.toMatch(/method:\s*['"`](?!GET)/);
  });
});
