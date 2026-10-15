import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listInbox, listWaiting, sendMessage, setMessageStatus } from '../../src/core/messages';
import { makeCtx } from '../helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('messages', () => {
  it('sends into the recipient inbox with thread = id', () => {
    const pm = makeCtx({ name: 'pm', role: 'pm' });
    const m = sendMessage(pm, { to: 'hristijan', type: 'request', body: 'Please look at 42', task: '42' });
    expect(m.path).toContain('/inbox/hristijan/');
    expect(m).toMatchObject({ from: 'pm', to: 'hristijan', status: 'new', thread: m.id, task: '42' });
    const me = { ...pm, user: { ...pm.user, name: 'hristijan', role: 'dev' as const } };
    expect(listInbox(me).map((x) => x.id)).toEqual([m.id]);
    expect(listInbox(me, ['done'])).toEqual([]);
  });

  it('sends a handover message', () => {
    const ctx = makeCtx();
    const m = sendMessage(ctx, { to: 'ana', type: 'handover', body: 'Over to you', task: '42' });
    const ana = { ...ctx, user: { ...ctx.user, name: 'ana' } };
    expect(listInbox(ana)).toEqual([expect.objectContaining({ id: m.id, type: 'handover', from: 'hristijan', task: '42' })]);
  });

  it('rejects unknown recipients and traversal', () => {
    const ctx = makeCtx();
    expect(() => sendMessage(ctx, { to: 'nobody', type: 'question', body: 'x' })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_RECIPIENT' }));
    expect(() => sendMessage(ctx, { to: '../pm', type: 'question', body: 'x' })).toThrowError(expect.objectContaining({ code: 'BAD_NAME' }));
    expect(() => sendMessage(ctx, { to: 'pm', type: 'question', body: 'x', thread: '../../a' })).toThrowError(expect.objectContaining({ code: 'BAD_ID' }));
  });

  it('only changes status in my own inbox', () => {
    const ctx = makeCtx();
    const sent = sendMessage(ctx, { to: 'pm', type: 'question', body: 'q' });
    expect(() => setMessageStatus(ctx, sent.id, 'done')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    const pm = { ...ctx, user: { ...ctx.user, name: 'pm' } };
    expect(setMessageStatus(pm, sent.id, 'read').status).toBe('read');
    expect(listInbox(pm, ['read']).map((m) => m.id)).toEqual([sent.id]);
  });

  it('scrubs secrets from message bodies', () => {
    const ctx = makeCtx();
    const m = sendMessage(ctx, { to: 'pm', type: 'question', body: 'stage is https://u:secretpw@x.example.com/' });
    expect(m.body).not.toContain('secretpw');
  });

  it('lists questions still waiting for an answer', () => {
    const me = makeCtx({ now: '2026-10-01T10:00:00Z' });
    const q = sendMessage(me, { to: 'pm', type: 'question', body: 'old q' });
    const later = { ...me, now: () => new Date('2026-10-08T10:00:00Z') };
    expect(listWaiting(later, 3).map((m) => m.id)).toEqual([q.id]);
    const pm = { ...later, user: { ...later.user, name: 'pm' } };
    sendMessage(pm, { to: 'hristijan', type: 'answer', body: 'a', thread: q.id });
    expect(listWaiting(later, 3)).toEqual([]);
  });
});

describe('messages hardening', () => {
  it('rejects a bad task gid and bad sender or status values with a HubError', () => {
    const ctx = makeCtx();
    expect(() => sendMessage(ctx, { to: 'pm', type: 'question', body: 'x', task: '../x' })).toThrowError(expect.objectContaining({ code: 'BAD_TICKET' }));
    const bad = { ...ctx, user: { ...ctx.user, name: '../evil' } };
    expect(() => sendMessage(bad, { to: 'pm', type: 'question', body: 'x' })).toThrowError(expect.objectContaining({ code: 'BAD_NAME' }));
    expect(() => listInbox(bad)).toThrowError(expect.objectContaining({ code: 'BAD_NAME' }));
    expect(() => listWaiting(bad, 1)).toThrowError(expect.objectContaining({ code: 'BAD_NAME' }));
    const sent = sendMessage(ctx, { to: 'pm', type: 'question', body: 'x' });
    const pm = { ...ctx, user: { ...ctx.user, name: 'pm' } };
    expect(() => setMessageStatus(pm, '../../escape', 'done')).toThrowError(expect.objectContaining({ code: 'BAD_ID' }));
    expect(() => setMessageStatus(pm, sent.id, 'archived' as never)).toThrowError(expect.objectContaining({ code: 'BAD_STATUS' }));
    expect(() => sendMessage(ctx, { to: 'pm', type: 'gossip' as never, body: 'x' })).toThrowError(expect.objectContaining({ code: 'BAD_TYPE' }));
  });

  it('skips corrupt message files instead of throwing', () => {
    const ctx = makeCtx();
    const pm = { ...ctx, user: { ...ctx.user, name: 'pm' } };
    const good = sendMessage(ctx, { to: 'pm', type: 'question', body: 'fine' });
    const inbox = join(ctx.hubDir, 'inbox', 'pm');
    writeFileSync(join(inbox, 'corrupt.md'), '---\n: [unclosed\n---\nbroken');
    writeFileSync(join(inbox, '2026-10-08-zzzz.md'), '---\nid: 2026-10-08-zzzz\ntype: gossip\n---\nbad type');
    expect(listInbox(pm).map((m) => m.id)).toEqual([good.id]);
    expect(setMessageStatus(pm, good.id, 'read').status).toBe('read');
  });

  it('skips corrupt files while listing waiting questions', () => {
    const me = makeCtx({ now: '2026-10-01T10:00:00Z' });
    const q = sendMessage(me, { to: 'pm', type: 'question', body: 'old q' });
    mkdirSync(join(me.hubDir, 'inbox', 'ana'), { recursive: true });
    writeFileSync(join(me.hubDir, 'inbox', 'ana', 'broken.md'), '---\n: [unclosed\n---\n');
    const later = { ...me, now: () => new Date('2026-10-08T10:00:00Z') };
    expect(listWaiting(later, 3).map((m) => m.id)).toEqual([q.id]);
  });

  it('keeps body content that contains ## headings intact', () => {
    const ctx = makeCtx();
    const body = 'Summary\n\n## Decisions\nUse exclusive writes\n\n## Open / next\nnothing';
    const sent = sendMessage(ctx, { to: 'pm', type: 'request', body });
    const pm = { ...ctx, user: { ...ctx.user, name: 'pm' } };
    const after = setMessageStatus(pm, sent.id, 'read');
    expect(after.body.trimEnd()).toBe(body);
  });

  it('never overwrites an existing message file when the generated id collides', () => {
    const ctx = makeCtx();
    const inbox = join(ctx.hubDir, 'inbox', 'pm');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, '2026-10-08-aaaa.md'),
      '---\nid: 2026-10-08-aaaa\ntype: question\nfrom: hristijan\nto: pm\nthread: 2026-10-08-aaaa\nstatus: new\ncreated: 2026-10-08T09:00:00.000Z\n---\nORIGINAL\n',
    );
    // newMessageId draws 4 random values per attempt: first attempt yields 'aaaa' (collides), second yields 'ssss'.
    const rand = vi.spyOn(Math, 'random');
    for (let i = 0; i < 4; i++) rand.mockReturnValueOnce(0);
    rand.mockReturnValue(0.5);
    const sent = sendMessage(ctx, { to: 'pm', type: 'question', body: 'new' });
    expect(sent.id).toBe('2026-10-08-ssss');
    const pm = { ...ctx, user: { ...ctx.user, name: 'pm' } };
    expect(listInbox(pm).find((m) => m.id === '2026-10-08-aaaa')?.body.trim()).toBe('ORIGINAL');
  });
});
