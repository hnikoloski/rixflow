import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JiraClient } from '../../../src/core/tickets/jira';
import { CLOUD, NAMES, SERVER, issue, jiraFetch } from '../../fixtures/jira';

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
      '/rest/api/3/search/jql': () => (n++ === 0
        ? { issues: [issue('WEB-1', { security: { name: 'Internal' } })], names: NAMES, nextPageToken: 't2' }
        : { issues: [issue('OPS-2')], names: NAMES }),
    });
    const tickets = await new JiraClient(CLOUD_URL, CLOUD, { projects: ['WEB', 'OPS'], fetchFn: fn }).myTickets();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(calls[0].url.searchParams.get('jql')).toBe('assignee = currentUser() AND statusCategory != Done AND project in (WEB, OPS)');
    expect(calls[1].url.searchParams.get('nextPageToken')).toBe('t2');
    expect(calls[1].url.searchParams.get('fields')).toContain('customfield_10020');
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
    const { fn } = jiraFetch({ '/rest/api/3/search/jql': { issues: [issue('WEB-1')], names: NAMES, nextPageToken: 'same' } });
    await expect(new JiraClient(CLOUD_URL, CLOUD, { fetchFn: fn }).myTickets()).rejects.toMatchObject({ code: 'JIRA_PAGINATION' });
  });

  it('server search pages by startAt and reads plain-text bodies', async () => {
    const { fn, calls } = jiraFetch({
      '/jira/rest/api/2/search': (u: URL) => (u.searchParams.get('startAt') === '0'
        ? { issues: [issue('WEB-1', { description: 'plain text' })], names: NAMES, total: 2 }
        : { issues: [issue('WEB-2')], names: NAMES, total: 2 }),
    });
    const tickets = await new JiraClient(SERVER_URL, SERVER, { fetchFn: fn }).myTickets();
    expect(tickets.map((t) => t.id)).toEqual(['WEB-1', 'WEB-2']);
    expect(tickets[0].notes).toBe('plain text');
    expect(calls[1].url.searchParams.get('startAt')).toBe('1');
  });

  it('ticket() converts ADF; comments() are oldest first', async () => {
    const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] };
    const { fn, calls } = jiraFetch({
      '/rest/api/3/issue/WEB-9': { ...issue('WEB-9', { description: adf, parent: { key: 'WEB-1', fields: { summary: 'Epic' } } }), names: NAMES },
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
    expect(calls[1].url.searchParams.get('orderBy')).toBe('-created');
    expect(calls[1].url.searchParams.get('maxResults')).toBe('5');
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

describe('read-only by construction', () => {
  it('jira.ts has one fetch call and one hardcoded GET', () => {
    const src = readFileSync('src/core/tickets/jira.ts', 'utf8');
    expect(src.split('fetchFn(').length - 1).toBe(1);
    expect(src.split("method: 'GET'").length - 1).toBe(1);
    expect(src).not.toMatch(/method:\s*['"`](?!GET)/);
  });
});
