import { describe, expect, it } from 'vitest';
import type { AsanaClient, AsanaReader } from '../../../src/core/asana';
import { asanaSource, toTicket } from '../../../src/core/tickets/asana';
import { fieldValue, parentChain } from '../../../src/core/tickets/types';
import { fakeAsana, fakeSource, field, task, ticket } from '../../fixtures/asana';

const opts = { workspace: '9' };

describe('toTicket', () => {
  it('maps an Asana task', () => {
    const t = toTicket(
      task({
        gid: '5',
        name: 'Fix header',
        notes: 'body',
        due_on: '2026-10-20',
        permalink_url: 'https://app.asana.com/0/1/5',
        parent: { gid: '4', name: 'Epic' },
        memberships: [
          { project: { gid: '1', name: 'Acme' }, section: { gid: '2', name: 'Doing' } },
          { project: { gid: '3', name: 'Globex' }, section: { gid: '4', name: 'Backlog' } },
        ],
        custom_fields: [field('Status', 'In progress'), field('Priority', 'High'), field('Website', 'AC'), field('Empty', null)],
      }),
      opts,
    );
    expect(t).toMatchObject({
      id: '5', title: 'Fix header', notes: 'body', due: '2026-10-20', url: 'https://app.asana.com/0/1/5',
      status: 'In progress', priority: 'High', containers: ['Acme', 'Globex'], sections: ['Doing', 'Backlog'],
      parent: { id: '4', title: 'Epic' }, restricted: false, components: [], labels: [], sprints: [],
    });
    expect(t.fields).toEqual([
      { name: 'Status', value: 'In progress' }, { name: 'Priority', value: 'High' }, { name: 'Website', value: 'AC' },
    ]);
  });

  it('reads a custom status field', () => {
    const t = toTicket(task({ gid: '5', custom_fields: [field('Status', 'x'), field('Stage', 'Review')] }), { ...opts, statusField: 'Stage' });
    expect(t.status).toBe('Review');
  });

  it('defaults optional values to null', () => {
    const t = toTicket(task({ gid: '5' }), opts);
    expect(t).toMatchObject({ due: null, url: null, parent: null, status: null, priority: null, notes: '' });
  });
});

describe('fieldValue', () => {
  it('matches a name prefix case-insensitively and skips empty values', () => {
    const t = ticket({ id: '1', fields: [{ name: 'Website URL', value: 'AC' }] });
    expect(fieldValue(t, 'website')).toBe('AC');
    expect(fieldValue(t, 'nope')).toBeNull();
  });
});

describe('parentChain', () => {
  it('walks parents', async () => {
    const src = fakeSource([
      ticket({ id: '3', parent: { id: '2', title: 'p' } }),
      ticket({ id: '2', parent: { id: '1', title: 'gp' } }),
      ticket({ id: '1' }),
    ]);
    const chain = await parentChain(src, await src.ticket('3'));
    expect(chain.map((t) => t.id)).toEqual(['3', '2', '1']);
  });

  it('stops at a cycle', async () => {
    const src = fakeSource([
      ticket({ id: '1', parent: { id: '2', title: 'b' } }),
      ticket({ id: '2', parent: { id: '1', title: 'a' } }),
    ]);
    const chain = await parentChain(src, await src.ticket('1'));
    expect(chain.map((t) => t.id)).toEqual(['1', '2']);
  });

  it('caps the parent walk at max parents', async () => {
    const tickets = Array.from({ length: 10 }, (_, i) =>
      ticket({ id: String(i + 1), parent: i < 9 ? { id: String(i + 2), title: 'p' } : null }),
    );
    const src = fakeSource(tickets);
    const chain = await parentChain(src, await src.ticket('1'), 3);
    expect(chain.map((t) => t.id)).toEqual(['1', '2', '3', '4']);
    expect(src.calls.filter((c) => c.startsWith('ticket:'))).toHaveLength(4);
  });
});

describe('asanaSource', () => {
  const reader = (...extra: Array<Partial<Pick<AsanaClient, 'getMe' | 'getFieldOptions'>>>) =>
    Object.assign(
      fakeAsana([
        task({ gid: '1', custom_fields: [field('Status', 'Open')] }),
        task({ gid: '2', custom_fields: [field('Status', 'Done'), field('Status', 'x')] }),
        task({ gid: '3', custom_fields: [field('Status', 'Open')] }),
      ], { '1': [{ created_at: 'c', author: 'Ann', text: 'hi' }] }),
      ...extra,
    ) as AsanaReader & Partial<Pick<AsanaClient, 'getMe' | 'getFieldOptions'>>;
  const me = { getMe: async () => ({ gid: '7', name: 'Ann', workspaces: [{ gid: '9', name: 'Acme' }] }) };

  it('identifies itself', () => {
    const s = asanaSource(reader(), opts);
    expect([s.kind, s.label]).toEqual(['asana', 'Asana']);
  });

  it('normalizes ids', () => {
    const s = asanaSource(reader(), opts);
    expect(s.normalizeId(' 123 ')).toBe('123');
    expect(() => s.normalizeId('WEB-1')).toThrowError(expect.objectContaining({ code: 'BAD_TICKET' }));
  });

  it('fetches tickets and comments', async () => {
    const s = asanaSource(reader(), opts);
    expect((await s.myTickets()).map((t) => t.id)).toEqual(['1', '2', '3']);
    expect((await s.ticket('2')).status).toBe('Done');
    expect(await s.comments('1')).toEqual([{ createdAt: 'c', author: 'Ann', text: 'hi' }]);
  });

  it('whoAmI uses getMe, or fails with ASANA_HTTP', async () => {
    expect(await asanaSource(reader(me), opts).whoAmI()).toEqual({ id: '7', name: 'Ann' });
    await expect(asanaSource(reader(), opts).whoAmI()).rejects.toMatchObject({ code: 'ASANA_HTTP' });
  });

  it('discovers scopes, statuses, priorities and boards', async () => {
    const s = asanaSource(reader(me), opts);
    expect(await s.scopes()).toEqual([{ id: '9', name: 'Acme' }]);
    expect((await s.sample([], 2)).map((t) => t.id)).toEqual(['1', '2']);
    expect(await s.statuses([])).toEqual(['Open', 'Done']);
    expect(await s.priorities()).toEqual([]);
    expect(await s.boards([])).toEqual([]);
  });

  it('learns every status and priority option from the workspace fields, not only from sampled tickets', async () => {
    const fields = {
      getFieldOptions: async (ws: string) => {
        expect(ws).toBe('9');
        return [
          { name: 'Status', options: ['Open', 'In QA', 'Done'] },
          { name: 'status', options: ['Blocked'] }, // a second field with the same name, other case
          { name: 'Priority', options: ['Low', 'High'] },
          { name: 'Website', options: ['AC'] },
        ];
      },
    };
    const s = asanaSource(reader(me, fields), opts);
    expect(await s.statuses([])).toEqual(['Open', 'In QA', 'Done', 'Blocked']);
    expect(await s.priorities()).toEqual(['Low', 'High']);
    const stage = asanaSource(reader(me, fields), { ...opts, statusField: 'Website' });
    expect(await stage.statuses([])).toEqual(['AC']);
  });

  it('falls back to sampled tickets when the field options cannot be read', async () => {
    const failing = { getFieldOptions: async () => { throw new Error('402 premium only'); } };
    const s = asanaSource(reader(me, failing), opts);
    expect(await s.statuses([])).toEqual(['Open', 'Done']);
    expect(await s.priorities()).toEqual([]);
  });
});
