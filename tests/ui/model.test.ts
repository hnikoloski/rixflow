import { describe, expect, it } from 'vitest';
import {
  bandParts, canFill, cell, contextBadge, rule, staleAge, syncBadge, titleHasSite, cliPath, fillFor, fit, nextCurrentTask, parseStatus, relTime, remember, shouldFetchAsana,
  refreshGate, statusArgv, statusLine, STATUS_VERSION, syncPart, TOOL, unseen,
} from '../../ui/hooks/model';
import type { Status } from '../../ui/types/status';

const base = (o: Partial<Status> = {}): Status => ({
  v: 2, at: '2026-10-10T18:00:00.000Z', user: 'hristijan', initialized: true,
  sync: { status: 'ok', pending: 0, detail: '' }, current: null, inbox: [], paused: [], sprint: null, problems: [], ...o,
});
const msg = (id: string, from = 'pm', status: 'new' | 'read' = 'new') =>
  ({ id, from, type: 'request' as const, task: null, preview: `msg ${id}`, status, created: '2026-10-10T17:58:00.000Z' });
const current = { task: '1', title: 'Fix banner overlap', sites: ['AC'], status: 'TODO', due: '2026-10-14', startedAt: null, source: 'session' as const };

describe('parseStatus', () => {
  it('accepts a v1 status', () => {
    expect(parseStatus(JSON.stringify(base()))).toEqual({ ok: true, status: base() });
  });
  it('rejects invalid JSON and other versions', () => {
    expect(parseStatus('{"v":1,')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseStatus('null')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseStatus(JSON.stringify({ ...base(), sync: null }))).toEqual({ ok: false, reason: 'invalid' });
    expect(parseStatus(JSON.stringify({ ...base(), v: 1 }))).toEqual({ ok: false, reason: 'version' });
    expect(STATUS_VERSION).toBe(2);
  });
});

describe('statusLine', () => {
  it('shows task, new count and sync', () => {
    expect(statusLine(base({ current, inbox: [msg('a'), msg('b'), msg('c', 'pm', 'read')] }), false))
      .toBe('▶ AC Fix banner overlap │ ✉ 2 new │ ✓ synced');
  });
  it('does not repeat a site the title already starts with', () => {
    expect(statusLine(base({ current: { ...current, title: 'AC: Fix banner' } }), false)).toBe('▶ AC: Fix banner │ ✓ synced');
    expect(statusLine(base({ current: { ...current, title: 'ACME import' } }), false)).toBe('▶ AC ACME import │ ✓ synced');
  });
  it('drops empty parts and reports problems', () => {
    expect(statusLine(base(), false)).toBe('✓ synced');
    expect(statusLine(base({ sync: { status: 'offline', pending: 3, detail: '' } }), false)).toBe('⚠ offline (3 unsynced)');
    expect(statusLine(base({ sync: { status: 'blocked', pending: 0, detail: 'x' } }), false)).toBe('⚠ sync blocked');
    expect(statusLine(base({ sync: { status: 'skipped', pending: 0, detail: '' } }), false)).toBe('idle');
    expect(statusLine(base({ sync: { status: 'locked', pending: 0, detail: '' } }), false)).toBe('idle');
    expect(statusLine(null, true)).toBe('setup needed');
    expect(statusLine(base({ initialized: false }), false)).toBe('setup needed');
    expect(statusLine(null, false)).toBe('…');
  });
});

describe('syncPart', () => {
  it('words the sync state, nothing for skipped or locked', () => {
    expect(syncPart(base())).toBe('✓ synced');
    expect(syncPart(base({ sync: { status: 'offline', pending: 2, detail: '' } }))).toBe('⚠ offline (2 unsynced)');
    expect(syncPart(base({ sync: { status: 'rejected', pending: 1, detail: '' } }))).toBe('⚠ sync blocked');
    expect(syncPart(base({ sync: { status: 'locked', pending: 0, detail: '' } }))).toBeNull();
    expect(syncPart(base({ sync: { status: 'skipped', pending: 0, detail: '' } }))).toBeNull();
  });
});

describe('pane styling', () => {
  it('badges the sync state, none for skipped or locked', () => {
    expect(syncBadge(base())).toEqual({ label: '● SYNCED', color: 'success' });
    expect(syncBadge(base({ sync: { status: 'offline', pending: 2, detail: '' } }))).toEqual({ label: '● OFFLINE 2', color: 'warning' });
    expect(syncBadge(base({ sync: { status: 'blocked', pending: 0, detail: '' } }))).toEqual({ label: '● BLOCKED', color: 'error' });
    expect(syncBadge(base({ sync: { status: 'locked', pending: 0, detail: '' } }))).toBeNull();
    expect(syncBadge(base({ sync: { status: 'skipped', pending: 0, detail: '' } }))).toBeNull();
  });
  it('fills rules and fixed-width cells', () => {
    expect(rule(10, 4)).toBe('──────');
    expect(rule(3, 9)).toBe('');
    expect(cell('pm', 5)).toBe('pm   ');
    expect(cell('request', 5)).toBe('req… ');
    expect(cell('✉✉', 3)).toBe('✉✉ ');
    // Exactly as long as the column, or cut: still one space before the next column.
    expect(cell('hristijan', 9)).toBe('hristij… ');
    expect(cell('hristijan', 10)).toBe('hristijan ');
  });
  it('drops a site only when the title starts with it as a prefix', () => {
    expect(titleHasSite('AC: Fix banner', ['AC'])).toBe(true);
    expect(titleHasSite('AC - Fix banner', ['AC'])).toBe(true);
    expect(titleHasSite('AC', ['AC'])).toBe(true);
    expect(titleHasSite('ACME import fails', ['AC'])).toBe(false);
    expect(titleHasSite('Fix AC banner', ['AC'])).toBe(false);
  });
  it('flags a cached sprint older than 20 minutes', () => {
    const now = Date.parse('2026-10-10T12:00:00.000Z');
    expect(staleAge('2026-10-10T11:50:00.000Z', now)).toBeNull();
    expect(staleAge('2026-10-10T09:00:00.000Z', now)).toBe('3h');
    expect(staleAge('garbage', now)).toBeNull();
  });
});

describe('band', () => {
  it('lists only new, unseen messages', () => {
    const s = base({ inbox: [msg('a'), msg('b', 'pm', 'read'), msg('c', 'ana')] });
    expect(unseen(s, ['c']).map((m) => m.id)).toEqual(['a']);
    expect(unseen(null, [])).toEqual([]);
  });
  it('words one or several messages', () => {
    expect(bandParts([msg('a')])).toEqual({ chip: '✉ NEW', who: 'pm', what: 'request · msg a' });
    expect(bandParts([msg('a'), msg('b', 'ana'), msg('c')])).toEqual({ chip: '✉ 3 NEW', who: 'pm, ana', what: 'waiting in your inbox' });
  });
  it('remembers ids, newest last, capped', () => {
    expect(remember(['a', 'b'], ['b', 'c'], 3)).toEqual(['a', 'b', 'c']);
    expect(remember(['a', 'b', 'c'], ['d'], 3)).toEqual(['b', 'c', 'd']);
  });
});

describe('fills', () => {
  it('maps actions to slash commands', () => {
    expect(fillFor({ kind: 'checkpoint' })).toBe('/rixflow:checkpoint');
    expect(fillFor({ kind: 'wrapup' })).toBe('/rixflow:wrapup');
    expect(fillFor({ kind: 'inbox' })).toBe('/rixflow:inbox');
    expect(fillFor({ kind: 'inbox', id: '2026-10-10-8qsc' })).toBe('/rixflow:inbox 2026-10-10-8qsc');
    expect(fillFor({ kind: 'resume', task: '111' })).toBe('/rixflow:resume 111');
    expect(fillFor({ kind: 'start', task: '111' })).toBe('/rixflow:start 111');
    expect(fillFor({ kind: 'setup' })).toBe('/rixflow:setup');
  });
  it('never fills over a draft', () => {
    expect(canFill('')).toBe(true);
    expect(canFill('  \n')).toBe(true);
    expect(canFill('half a thought')).toBe(false);
  });
});

describe('helpers', () => {
  const now = Date.parse('2026-10-10T18:00:00.000Z');
  it('relTime', () => {
    expect(relTime('2026-10-10T17:59:40.000Z', now)).toBe('now');
    expect(relTime('2026-10-10T17:58:00.000Z', now)).toBe('2m');
    expect(relTime('2026-10-10T16:00:00.000Z', now)).toBe('2h');
    expect(relTime('2026-10-09T12:00:00.000Z', now)).toBe('1d');
    expect(relTime('2026-10-06T12:00:00.000Z', now)).toBe('4d');
    expect(relTime(null, now)).toBe('');
    expect(relTime('garbage', now)).toBe('');
  });
  it('fit cuts to the room and counts the rest', () => {
    expect(fit([1, 2, 3, 4], 2)).toEqual({ shown: [1, 2], more: 2 });
    expect(fit([1], 5)).toEqual({ shown: [1], more: 0 });
    expect(fit([1, 2], 0)).toEqual({ shown: [], more: 2 });
  });
  it('tracks the current task from tool results', () => {
    expect(nextCurrentTask(null, TOOL.start, { task: '111' }, true)).toBe('111');
    expect(nextCurrentTask(null, TOOL.start, { task: 'WEB-7' }, true)).toBe('WEB-7');
    expect(nextCurrentTask(null, TOOL.start, { task: 'web-7' }, true)).toBeNull();
    expect(nextCurrentTask('111', TOOL.resume, { task: '222' }, true)).toBe('222');
    expect(nextCurrentTask('111', TOOL.start, { task: '222' }, false)).toBe('111');
    expect(nextCurrentTask('111', TOOL.checkpoint, {}, true)).toBeNull();
    expect(nextCurrentTask('111', TOOL.checkpoint, { task: '111' }, true)).toBeNull();
    expect(nextCurrentTask('111', TOOL.checkpoint, { task: '222' }, true)).toBe('111');
    expect(nextCurrentTask('111', TOOL.finish, { task: '111' }, true)).toBeNull();
    expect(nextCurrentTask('111', TOOL.finish, { task: '222' }, true)).toBe('111');
    expect(nextCurrentTask('WEB-7', TOOL.drop, { task: 'WEB-7' }, true)).toBeNull();
    expect(nextCurrentTask('WEB-7', TOOL.drop, { task: 'WEB-8' }, true)).toBe('WEB-7');
    expect(nextCurrentTask('111', 'mcp__plugin_rixflow_hub__inbox', {}, true)).toBe('111');
    expect(nextCurrentTask(null, TOOL.start, { task: 42 }, true)).toBeNull();
  });
  it('fetches Asana every 15 min only while active', () => {
    const m = 60_000;
    expect(shouldFetchAsana(now, now - 16 * m, now - 2 * m)).toBe(true);
    expect(shouldFetchAsana(now, now - 10 * m, now - 2 * m)).toBe(false);
    expect(shouldFetchAsana(now, now - 16 * m, now - 20 * m)).toBe(false);
  });
});

describe('poller helpers', () => {
  it('refreshGate skips a busy tick but runs one merged queued refresh after', async () => {
    const gate = refreshGate();
    const seen: Array<{ asana: boolean; refresh: boolean }> = [];
    let release!: () => void;
    const work = async (r: { asana: boolean; refresh: boolean }) => {
      seen.push(r);
      await new Promise<void>((ok) => (release = ok));
      return true;
    };
    const first = gate({ asana: false, refresh: false }, work, false);
    expect(await gate({ asana: false, refresh: false }, work, false)).toBe(false);
    const a = gate({ asana: true, refresh: false }, work, true);
    const b = gate({ asana: false, refresh: true }, work, true);
    release();
    expect(await first).toBe(true);
    await Promise.resolve();
    expect(seen).toEqual([{ asana: false, refresh: false }, { asana: true, refresh: true }]);
    release();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(seen).toHaveLength(2);
  });
  it('refreshGate stays usable when work throws', async () => {
    const gate = refreshGate();
    let runs = 0;
    const work = async (): Promise<boolean> => { runs++; throw new Error('x'); };
    expect(await gate({ asana: false, refresh: false }, work, false)).toBe(false);
    expect(await gate({ asana: false, refresh: false }, work, true)).toBe(false);
    expect(runs).toBe(2);
  });
  it('refreshGate gives each caller the result of its own run, not of a queued one after it', async () => {
    const gate = refreshGate();
    const releases: Array<() => void> = [];
    let n = 0;
    const work = async () => {
      const mine = n++;
      await new Promise<void>((ok) => releases.push(ok));
      return mine === 0; // the first run is good, the queued one fails
    };
    const first = gate({ asana: false, refresh: false }, work, false);
    const queued = gate({ asana: true, refresh: false }, work, true);
    releases[0]!();
    expect(await first).toBe(true);
    await Promise.resolve();
    releases[1]!();
    expect(await queued).toBe(false);
  });
  it('builds the status argv', () => {
    expect(statusArgv('/c/hub.cjs', '/w', null, { asana: false, refresh: false }))
      .toEqual(['node', '/c/hub.cjs', 'status', '--json', '--cwd', '/w']);
    expect(statusArgv('/c/hub.cjs', '/w', '111', { asana: true, refresh: true }))
      .toEqual(['node', '/c/hub.cjs', 'status', '--json', '--cwd', '/w', '--task', '111', '--asana', '--refresh']);
  });
  it('locates the CLI copy in the config dir', () => {
    expect(cliPath(undefined, '/home/u')).toBe('/home/u/.config/rixflow/hub.cjs');
    expect(cliPath('/cfg', '/home/u')).toBe('/cfg/hub.cjs');
    expect(cliPath('', '/home/u')).toBe('/home/u/.config/rixflow/hub.cjs');
  });
});

describe('contextBadge', () => {
  it('draws the bar, percent and used/window', () => {
    expect(contextBadge({ tokens: 84_000, window: 200_000, percent: 42 })).toEqual({ text: '████░░░░░░ 42% · 84k/200k', color: 'success' });
    expect(contextBadge({ tokens: 100_000, window: 1_000_000, percent: 10 })?.text).toBe('█░░░░░░░░░ 10% · 100k/1m');
  });
  it('derives used from percent, formats millions and omits a missing window', () => {
    expect(contextBadge({ window: 1_200_000, percent: 50 })?.text).toBe('█████░░░░░ 50% · 600k/1.2m');
    expect(contextBadge({ window: 0, percent: 30 })?.text).toBe('███░░░░░░░ 30%');
    expect(contextBadge({ tokens: 900, window: 2000, percent: 45.9 })?.text).toBe('████░░░░░░ 45% · 900/2k');
  });
  it('clamps the percent', () => {
    expect(contextBadge({ window: 100, percent: 130 })?.text).toBe('██████████ 100% · 100/100');
    expect(contextBadge({ window: 100, percent: -5 })?.text).toBe('░░░░░░░░░░ 0% · 0/100');
  });
  it('colors by fill and is null without a percent', () => {
    expect(contextBadge({ window: 200_000, percent: 59 })?.color).toBe('success');
    expect(contextBadge({ window: 200_000, percent: 60 })?.color).toBe('warning');
    expect(contextBadge({ window: 200_000, percent: 84 })?.color).toBe('warning');
    expect(contextBadge({ window: 200_000, percent: 85 })?.color).toBe('error');
    expect(contextBadge({ window: 200_000 })).toBeNull();
    expect(contextBadge(null)).toBeNull();
  });
  it('never renders negative used tokens', () => {
    expect(contextBadge({ tokens: -500, window: 200_000, percent: 10 })?.text).toBe('█░░░░░░░░░ 10% · 0/200k');
  });
  it('floors fractional percents before coloring', () => {
    expect(contextBadge({ window: 200_000, percent: 59.9 })?.color).toBe('success');
    expect(contextBadge({ window: 200_000, percent: 84.9 })?.color).toBe('warning');
  });
  it('joins the status line when given', () => {
    expect(statusLine(base(), false, 'X')).toMatch(/ │ X$/);
  });
});
