import { describe, expect, it } from 'vitest';
import { mapTicket } from '../../src/core/mapping';
import { gatherPlate, renderPlate } from '../../src/core/plate';
import { asanaSource } from '../../src/core/tickets/asana';
import { LEGACY_WORKFLOW, type Workflow } from '../../src/core/workflow';
import { fakeSource, ticket } from '../fixtures/asana';
import { PARITY_FIXTURES, stableIds } from '../fixtures/parity';
import { makeCtx } from '../helpers';

const now = new Date('2026-10-08T10:00:00Z');
const CURRENT = 'Sprint 41 | 5.10 - 9.10';

// A non-legacy workflow: exact status matching, no title heuristics.
function wf(o: Partial<Workflow> = {}): Workflow {
  return {
    requires: '0.3.0',
    legacy: false,
    tracker: { type: 'asana', workspace: null },
    project: { from: 'custom-field', field: 'Website', values: 'codes' },
    status: { field: 'Status', todo: ['To do'], in_progress: ['In Progress'], waiting: ['Waiting'], done: ['Done'] },
    sprints: { mode: 'asana-sections' },
    urgent: { field: 'Priority', values: ['Urgent', 'Highest'] },
    ...o,
  };
}
const legacy = structuredClone(LEGACY_WORKFLOW) as Workflow;

describe('mapTicket codes', () => {
  it("splits a 'codes' value on commas and keeps only valid site codes", () => {
    const t = ticket({ id: '1', fields: [{ name: 'Website - Web', value: 'GL, constructor, ac,  AC ' }] });
    expect(mapTicket([t], wf(), now).codes).toEqual(['GL', 'AC']);
  });
  it('walks the chain: the first ticket with a value wins', () => {
    const child = ticket({ id: '2', parent: { id: '1', title: 'p' } });
    const parent = ticket({ id: '1', fields: [{ name: 'Website', value: 'AC' }] });
    const grand = ticket({ id: '0', fields: [{ name: 'Website', value: 'GL' }] });
    expect(mapTicket([child, parent, grand], wf(), now).codes).toEqual(['AC']);
    const own = ticket({ id: '3', fields: [{ name: 'Website', value: 'GL' }] });
    expect(mapTicket([own, parent], wf(), now).codes).toEqual(['GL']);
  });
  it('looks values up in a map, case-insensitive and trimmed', () => {
    const w = wf({ project: { from: 'custom-field', field: 'Client', values: { 'Acme Corp': 'AC', Globex: 'GL' } } });
    expect(mapTicket([ticket({ id: '1', fields: [{ name: 'Client', value: '  acme corp ' }] })], w, now).codes).toEqual(['AC']);
    expect(mapTicket([ticket({ id: '1', fields: [{ name: 'Client', value: 'Initech' }] })], w, now).codes).toEqual([]);
  });
  it('maps two components to two codes', () => {
    const w = wf({ project: { from: 'component', field: null, values: { web: 'AC', 'globex app': 'GL', misc: 'AC' } } });
    const t = ticket({ id: 'WEB-1', components: ['Web', 'Globex App', 'Misc'] });
    expect(mapTicket([t], w, now).codes).toEqual(['AC', 'GL']);
  });
  it('reads labels', () => {
    const w = wf({ project: { from: 'label', field: null, values: { 'site-ac': 'AC' } } });
    expect(mapTicket([ticket({ id: 'WEB-1', labels: ['other', 'site-ac'] })], w, now).codes).toEqual(['AC']);
  });
  it('reads containers for asana-project and jira-project', () => {
    const t = ticket({ id: 'WEB-1', containers: ['WEB'] });
    expect(mapTicket([t], wf({ project: { from: 'jira-project', field: null, values: { web: 'AC' } } }), now).codes).toEqual(['AC']);
    const a = ticket({ id: '1', containers: ['Acme Website', 'Sprints'] });
    expect(mapTicket([a], wf({ project: { from: 'asana-project', field: null, values: { 'acme website': 'AC' } } }), now).codes).toEqual(['AC']);
  });
  it('skips a ticket whose value yields no code and keeps walking', () => {
    const child = ticket({ id: '2', fields: [{ name: 'Website', value: 'n/a' }] });
    const parent = ticket({ id: '1', fields: [{ name: 'Website', value: 'GL' }] });
    expect(mapTicket([child, parent], wf(), now).codes).toEqual(['GL']);
  });
});

describe('mapTicket bucket', () => {
  it("uses the ticket's own status, matched exactly and case-insensitively", () => {
    const parent = ticket({ id: '1', status: 'In Progress' });
    expect(mapTicket([ticket({ id: '2' }), parent], wf(), now).bucket).toBeNull();
    expect(mapTicket([ticket({ id: '2', status: 'in progress' })], wf(), now).bucket).toBe('in_progress');
    expect(mapTicket([ticket({ id: '2', status: 'DONE' })], wf(), now).bucket).toBe('done');
    expect(mapTicket([ticket({ id: '2', status: 'waiting' })], wf(), now).bucket).toBe('waiting');
    expect(mapTicket([ticket({ id: '2', status: 'To Do' })], wf(), now).bucket).toBe('todo');
    expect(mapTicket([ticket({ id: '2', status: 'Not in progress' })], wf(), now).bucket).toBeNull();
    expect(mapTicket([ticket({ id: '2', status: 'Review' })], wf(), now).bucket).toBeNull();
  });
  it('uses substring matching in the legacy workflow', () => {
    expect(mapTicket([ticket({ id: '2', status: 'Not in progress' })], legacy, now).bucket).toBe('in_progress');
    expect(mapTicket([ticket({ id: '2', status: 'Done' })], legacy, now).bucket).toBeNull();
  });
});

describe('mapTicket urgent', () => {
  it('reads priority from the first ticket in the chain that has one', () => {
    const child = ticket({ id: '2' });
    const parent = ticket({ id: '1', priority: 'urgent' });
    const grand = ticket({ id: '0', priority: 'Low' });
    expect(mapTicket([child, parent, grand], wf(), now).urgent).toBe(true);
    expect(mapTicket([ticket({ id: '2', priority: 'Low' }), parent], wf(), now).urgent).toBe(false);
  });
  it('matches the title only in the legacy workflow', () => {
    const t = ticket({ id: '2', title: '[Hotfix] checkout broken' });
    expect(mapTicket([t], wf(), now).urgent).toBe(false);
    expect(mapTicket([t], legacy, now).urgent).toBe(true);
    expect(mapTicket([ticket({ id: '3', title: 'P0 regression' })], legacy, now).urgent).toBe(true);
    expect(mapTicket([ticket({ id: '3', priority: 'P0' })], legacy, now).urgent).toBe(true);
    expect(mapTicket([ticket({ id: '3', title: 'Plain' })], legacy, now).urgent).toBe(false);
  });
});

describe('mapTicket sprint', () => {
  it('is null for mode none', () => {
    expect(mapTicket([ticket({ id: '1', sections: [CURRENT] })], wf({ sprints: { mode: 'none' } }), now).sprint).toBeNull();
  });
  it('asana-sections: the first section in the chain that is the current sprint', () => {
    const child = ticket({ id: '2', sections: ['Backlog', 'Sprint 40 | 28.9 - 2.10'] });
    const parent = ticket({ id: '1', sections: ['Inbox', CURRENT] });
    expect(mapTicket([child, parent], wf(), now).sprint).toBe(CURRENT);
    expect(mapTicket([child], wf(), now).sprint).toBeNull();
  });
  it('asana-sections in the legacy workflow: only the first section in the chain counts (parity)', () => {
    const child = ticket({ id: '2', sections: ['Backlog'] });
    const parent = ticket({ id: '1', sections: [CURRENT] });
    expect(mapTicket([child, parent], legacy, now).sprint).toBeNull();
    expect(mapTicket([ticket({ id: '2' }), parent], legacy, now).sprint).toBe(CURRENT);
    expect(mapTicket([ticket({ id: '3', sections: ['To do', CURRENT] })], legacy, now).sprint).toBeNull();
  });
  it('jira-sprints: the first active sprint, on the configured board when one is set', () => {
    const t = ticket({
      id: 'WEB-1',
      sprints: [{ name: 'Old', active: false, boardId: 7 }, { name: 'Other board', active: true, boardId: 3 }, { name: 'Ours', active: true, boardId: 7 }],
    });
    expect(mapTicket([t], wf({ sprints: { mode: 'jira-sprints', board: 7 } }), now).sprint).toBe('Ours');
    expect(mapTicket([t], wf({ sprints: { mode: 'jira-sprints', board: null } }), now).sprint).toBe('Other board');
    expect(mapTicket([t], wf({ sprints: { mode: 'jira-sprints', board: 9 } }), now).sprint).toBeNull();
  });
});

describe('plate placement', () => {
  it('drops done tickets and sorts the rest into urgent, in progress, sprint and backlog', async () => {
    const ctx = makeCtx();
    const src = fakeSource([
      ticket({ id: '1', title: 'Shipped', status: 'Done', sections: [CURRENT] }),
      ticket({ id: '2', title: 'Hot', priority: 'Urgent', status: 'Done' }),
      ticket({ id: '3', title: 'Doing', status: 'In Progress' }),
      ticket({ id: '4', title: 'Planned', status: 'To do', sections: [CURRENT] }),
      ticket({ id: '5', title: 'Blocked', status: 'Waiting', sections: ['Inbox'] }),
      ticket({ id: '6', title: 'Fire', priority: 'highest', status: 'Waiting', sections: [CURRENT] }),
    ]);
    const plate = await gatherPlate(ctx, src, wf());
    expect(plate.sprintName).toBe(CURRENT);
    expect(plate.urgent.map((i) => i.ref)).toEqual(['6']);
    expect(plate.inProgress.map((i) => i.ref)).toEqual(['3']);
    expect(plate.sprint.map((i) => i.ref)).toEqual(['4']);
    expect(plate.backlog.map((i) => i.ref)).toEqual(['5']);
    expect(renderPlate(plate)).toContain('Blocked — Waiting (5)');
    expect(renderPlate(plate)).not.toContain('Shipped');
  });
});

// Captured from the pre-TicketSource gatherPlate (Asana reader + hard-coded rules) on the same fixtures.
const EXPECTED: Record<string, { text: string; calls: string[] }> = {
  'groups, orders and numbers items': {
    text: '**Sprint 41 | 5.10 - 9.10**\n\n### Urgent\n1. [AC] [Hotfix] checkout broken (13)\n\n### In progress / paused\n2. [AC] Doing — In Progress (14)\n3. [AC] Paused one — (paused) (15)\n\n### This sprint\n4. [AC] Sprint early — due 2026-10-06 (12)\n5. [AC] Sprint late — due 2026-10-09 (11)\n\n### Inbox\n6. request from pm: Please check the pricing page (<id>)\n\n### Backlog\n7. [AC] Backlog thing (10)\n\n### Waiting on others\n- pm: Is the banner final? (7 days, <id>)\n',
    calls: ['getMyTasks'],
  },
  'walks parents for subtasks without a project or website': {
    text: '**Sprint 41 | 5.10 - 9.10**\n\n### This sprint\n1. [GL] Testimonial card (2)\n',
    calls: ['getMyTasks', 'getTask:1'],
  },
  'shows tasks with a checkpoint as paused': {
    text: '### In progress / paused\n1. Half done — (paused) (5)\n',
    calls: ['getMyTasks'],
  },
  'degrades a task whose parent fetch fails': {
    text: '**Sprint 41 | 5.10 - 9.10**\n\n### This sprint\n1. Fine task (3)\n\n### Backlog\n2. [AC] Orphan subtask (2)\n',
    calls: ['getMyTasks', 'getTask:1'],
  },
  'never renders link-field values': {
    text: '### In progress / paused\n1. Linked — In Progress (7)\n',
    calls: ['getMyTasks'],
  },
  'scrubs every displayed string': {
    text: '**Sprint 41 | 5.10 - 9.10 https://[redacted]@x.example.com/z**\n\n### This sprint\n1. fix https://[redacted]@x.example.com/a — Blocked https://[redacted]@x.example.com/s (30)\n',
    calls: ['getMyTasks'],
  },
  'shares one failed parent fetch between siblings': {
    text: '### Backlog\n1. Sub 2 (2)\n2. Sub 3 (3)\n3. Sub 4 (4)\n',
    calls: ['getMyTasks', 'getTask:1'],
  },
  'many subtasks with their own parents': {
    text: '### Backlog\n1. S0 (100)\n2. [GL] S1 (101)\n3. S2 (102)\n4. [GL] S3 (103)\n5. S4 (104)\n6. [GL] S5 (105)\n7. S6 (106)\n8. [GL] S7 (107)\n9. S8 (108)\n10. [GL] S9 (109)\n11. S10 (110)\n12. [GL] S11 (111)\n',
    calls: ['getMyTasks', 'getTask:200', 'getTask:201', 'getTask:202', 'getTask:203', 'getTask:204', 'getTask:205', 'getTask:206', 'getTask:207', 'getTask:208', 'getTask:209', 'getTask:210', 'getTask:211'],
  },
  'own non-sprint section wins over a parent sprint section': {
    text: '### Backlog\n1. [GL] Child in backlog (51)\n',
    calls: ['getMyTasks', 'getTask:50'],
  },
  'only the first section counts': {
    text: '### Backlog\n1. [AC] Two homes (52)\n',
    calls: ['getMyTasks'],
  },
  'a remembered site is shown': {
    text: '### Backlog\n1. [GL] Multi site (53)\n',
    calls: ['getMyTasks'],
  },
  'an invalid website value with a section does not fetch parents': {
    text: '### Backlog\n1. Bad value (61)\n',
    calls: ['getMyTasks'],
  },
  'an invalid website value without a section falls back to the parent': {
    text: '### Backlog\n1. [AC] Bad value (62)\n',
    calls: ['getMyTasks', 'getTask:60'],
  },
  'priority comes from the parent chain': {
    text: '### Urgent\n1. [AC] Plain child (71)\n',
    calls: ['getMyTasks', 'getTask:70'],
  },
  'priority and title variants': {
    text: '### Urgent\n1. [AC] Normal (80)\n2. [AC] P0 regression (81)\n3. [AC] Urgently needed? no: p0x (82)\n4. [AC] Critical one (83)\n\n### Backlog\n5. [AC] Medium (84)\n',
    calls: ['getMyTasks'],
  },
  'status substring and done statuses': {
    text: '**Sprint 41 | 5.10 - 9.10**\n\n### In progress / paused\n1. [AC] Not started — Not in progress (90)\n\n### This sprint\n2. [AC] Finished — Done (91)\n\n### Backlog\n3. [AC] Waiting — Waiting on client (92)\n4. [GL] Status on parent only (93)\n',
    calls: ['getMyTasks', 'getTask:94'],
  },
  'nothing on the plate': {
    text: 'Nothing on your plate.',
    calls: ['getMyTasks'],
  },
};

describe('parity with the pre-TicketSource plate', () => {
  it('covers every captured fixture', () => {
    expect(PARITY_FIXTURES.map((f) => f.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
  for (const f of PARITY_FIXTURES) {
    it(`renders the same plate and makes the same Asana calls: ${f.name}`, async () => {
      const ctx = makeCtx();
      f.setup?.(ctx);
      const reader = f.reader();
      const plate = await gatherPlate(ctx, asanaSource(reader, { workspace: '111' }), structuredClone(LEGACY_WORKFLOW) as Workflow);
      expect(stableIds(renderPlate(plate))).toBe(EXPECTED[f.name].text);
      expect(reader.calls).toEqual(EXPECTED[f.name].calls);
    });
  }
});
