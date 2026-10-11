import type { AsanaReader, AsanaTask } from '../../src/core/asana';
import { sendMessage } from '../../src/core/messages';
import { writeCheckpoint } from '../../src/core/notes';
import { HubError, type Ctx } from '../../src/core/types';
import { fakeAsana, field, task } from './asana';

// Plate fixtures shared by the parity test: each one ran through the pre-TicketSource gatherPlate
// and its rendered text and Asana call log were pinned in tests/core/mapping.test.ts.
export interface ParityFixture {
  name: string;
  setup?: (ctx: Ctx) => void;
  reader: () => AsanaReader & { calls: string[] };
}

const sprint = (name: string) => ({ project: { gid: '9', name: 'Acme Sprints' }, section: { gid: '8', name } });
const CURRENT = 'Sprint 41 | 5.10 - 9.10';
const asPm = (ctx: Ctx): Ctx => ({ ...ctx, user: { ...ctx.user, name: 'pm' } });

function failingParents(tasks: AsanaTask[], mine: string[], code: string): AsanaReader & { calls: string[] } {
  const base = fakeAsana(tasks, {}, mine);
  return {
    ...base,
    async getTask(gid: string) {
      base.calls.push(`getTask:${gid}`);
      throw new HubError(code, `no ${gid}`);
    },
  };
}

export const PARITY_FIXTURES: ParityFixture[] = [
  {
    name: 'groups, orders and numbers items',
    setup: (ctx) => {
      sendMessage(asPm(ctx), { to: 'hristijan', type: 'request', body: 'Please check the pricing page\nmore' });
      const old = { ...ctx, now: () => new Date('2026-10-01T10:00:00Z') };
      sendMessage(old, { to: 'pm', type: 'question', body: 'Is the banner final?' });
      writeCheckpoint(ctx, { task: '15', done: '', pending: '', blockers: '', resume: '' });
    },
    reader: () => fakeAsana([
      task({ gid: '10', name: 'Backlog thing', custom_fields: [field('Website', 'AC')], memberships: [sprint('Sprint backlog')] }),
      task({ gid: '11', name: 'Sprint late', due_on: '2026-10-09', custom_fields: [field('Website', 'AC')], memberships: [sprint(CURRENT)] }),
      task({ gid: '12', name: 'Sprint early', due_on: '2026-10-06', custom_fields: [field('Website', 'AC')], memberships: [sprint(CURRENT)] }),
      task({ gid: '13', name: '[Hotfix] checkout broken', custom_fields: [field('Website', 'AC')], memberships: [sprint('Inbox')] }),
      task({ gid: '14', name: 'Doing', custom_fields: [field('Status - Web', 'In Progress'), field('Website', 'AC')], memberships: [sprint('Inbox')] }),
      task({ gid: '15', name: 'Paused one', custom_fields: [field('Website', 'AC')], memberships: [sprint('Inbox')] }),
    ]),
  },
  {
    name: 'walks parents for subtasks without a project or website',
    reader: () => fakeAsana([
      task({ gid: '1', name: 'Components development on dev', custom_fields: [field('Website - Web', 'GL')], memberships: [sprint(CURRENT)] }),
      task({ gid: '2', name: 'Testimonial card', parent: { gid: '1', name: 'Components development on dev' } }),
    ], {}, ['2']),
  },
  {
    name: 'shows tasks with a checkpoint as paused',
    setup: (ctx) => writeCheckpoint(ctx, { task: '5', done: '', pending: '', blockers: '', resume: '' }),
    reader: () => fakeAsana([task({ gid: '5', name: 'Half done' })]),
  },
  {
    name: 'degrades a task whose parent fetch fails',
    reader: () => failingParents([
      task({ gid: '2', name: 'Orphan subtask', parent: { gid: '1', name: 'gone' }, custom_fields: [field('Website - Web', 'AC')] }),
      task({ gid: '3', name: 'Fine task', memberships: [sprint(CURRENT)] }),
    ], ['2', '3'], 'ASANA_NETWORK'),
  },
  {
    name: 'never renders link-field values',
    reader: () => fakeAsana([task({
      gid: '7', name: 'Linked', permalink_url: 'https://u:hunter2@x.example.com/',
      custom_fields: [field('Staging link - Web', 'https://u:hunter2@x.example.com/'), field('Status - Web', 'In Progress')],
    })]),
  },
  {
    name: 'scrubs every displayed string',
    reader: () => fakeAsana([task({
      gid: '30', name: 'fix https://u:p@x.example.com/a', custom_fields: [field('Status - Web', 'Blocked https://u:p@x.example.com/s')],
      memberships: [sprint(`${CURRENT} https://u:p@x.example.com/z`)],
    })]),
  },
  {
    name: 'shares one failed parent fetch between siblings',
    reader: () => failingParents(
      ['2', '3', '4'].map((gid) => task({ gid, name: `Sub ${gid}`, parent: { gid: '1', name: 'gone' } })), ['2', '3', '4'], 'ASANA_NETWORK',
    ),
  },
  {
    name: 'many subtasks with their own parents',
    reader: () => {
      const subs = Array.from({ length: 12 }, (_, i) => task({ gid: String(100 + i), name: `S${i}`, parent: { gid: String(200 + i), name: 'p' } }));
      const parents = subs.map((_, i) => task({ gid: String(200 + i), name: `P ${200 + i}`, custom_fields: i % 2 ? [field('Website', 'GL')] : [] }));
      return fakeAsana([...subs, ...parents], {}, subs.map((t) => t.gid));
    },
  },
  {
    name: 'own non-sprint section wins over a parent sprint section',
    reader: () => fakeAsana([
      task({ gid: '50', name: 'Parent in sprint', custom_fields: [field('Website', 'GL')], memberships: [sprint(CURRENT)] }),
      task({ gid: '51', name: 'Child in backlog', parent: { gid: '50', name: 'Parent in sprint' }, memberships: [sprint('Backlog')] }),
    ], {}, ['51']),
  },
  {
    name: 'only the first section counts',
    reader: () => fakeAsana([
      task({ gid: '52', name: 'Two homes', custom_fields: [field('Website', 'AC')], memberships: [sprint('To do'), sprint(CURRENT)] }),
    ]),
  },
  {
    name: 'a remembered site is shown',
    setup: (ctx) => {
      ctx.user.taskSites['53'] = 'GL';
    },
    reader: () => fakeAsana([task({ gid: '53', name: 'Multi site', custom_fields: [field('Website', 'GL, AC')], memberships: [sprint('Inbox')] })]),
  },
  {
    name: 'an invalid website value with a section does not fetch parents',
    reader: () => fakeAsana([
      task({ gid: '60', name: 'Parent', custom_fields: [field('Website', 'AC')] }),
      task({ gid: '61', name: 'Bad value', parent: { gid: '60', name: 'Parent' }, custom_fields: [field('Website', 'n/a')], memberships: [sprint('Inbox')] }),
    ], {}, ['61']),
  },
  {
    name: 'an invalid website value without a section falls back to the parent',
    reader: () => fakeAsana([
      task({ gid: '60', name: 'Parent', custom_fields: [field('Website', 'AC')] }),
      task({ gid: '62', name: 'Bad value', parent: { gid: '60', name: 'Parent' }, custom_fields: [field('Website', 'constructor')] }),
    ], {}, ['62']),
  },
  {
    name: 'priority comes from the parent chain',
    reader: () => fakeAsana([
      task({ gid: '70', name: 'Urgent epic', custom_fields: [field('Priority', 'Urgent'), field('Website', 'AC')] }),
      task({ gid: '71', name: 'Plain child', parent: { gid: '70', name: 'Urgent epic' } }),
    ], {}, ['71']),
  },
  {
    name: 'priority and title variants',
    reader: () => fakeAsana([
      task({ gid: '80', name: 'Normal', custom_fields: [field('Priority - Web', 'HIGHEST'), field('Website', 'AC')], memberships: [sprint('Inbox')] }),
      task({ gid: '81', name: 'P0 regression', custom_fields: [field('Website', 'AC')], memberships: [sprint('Inbox')] }),
      task({ gid: '82', name: 'Urgently needed? no: p0x', custom_fields: [field('Priority', 'urgent-ish'), field('Website', 'AC')], memberships: [sprint('Inbox')] }),
      task({ gid: '83', name: 'Critical one', custom_fields: [field('Priority', 'critical'), field('Website', 'AC')], memberships: [sprint('Inbox')] }),
      task({ gid: '84', name: 'Medium', custom_fields: [field('Priority', 'Medium'), field('Website', 'AC')], memberships: [sprint('Inbox')] }),
    ]),
  },
  {
    name: 'status substring and done statuses',
    reader: () => fakeAsana([
      task({ gid: '90', name: 'Not started', custom_fields: [field('Status', 'Not in progress'), field('Website', 'AC')], memberships: [sprint('Inbox')] }),
      task({ gid: '91', name: 'Finished', custom_fields: [field('Status', 'Done'), field('Website', 'AC')], memberships: [sprint(CURRENT)] }),
      task({ gid: '92', name: 'Waiting', custom_fields: [field('Status', 'Waiting on client'), field('Website', 'AC')], memberships: [sprint('Inbox')] }),
      task({ gid: '93', name: 'Status on parent only', parent: { gid: '94', name: 'p' } }),
      task({ gid: '94', name: 'p', custom_fields: [field('Status', 'In progress'), field('Website', 'GL')] }),
    ], {}, ['90', '91', '92', '93']),
  },
  {
    name: 'nothing on the plate',
    reader: () => fakeAsana([]),
  },
];

// Message ids carry a random suffix; the parity text replaces them with a placeholder.
export const stableIds = (text: string) => text.replace(/\d{4}-\d{2}-\d{2}-[a-z0-9]{4}/g, '<id>');
