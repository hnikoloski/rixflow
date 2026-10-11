import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from '../../src/core/check';
import { summarizeSession } from '../../src/core/summarize';
import { SUMMARY_LOG, SUMMARY_LOG_MAX_LINES, logSummary } from '../../src/core/summarylog';
import { HubError } from '../../src/core/types';
import { fakeAsanaSource } from '../fixtures/asana';
import { makeCtx } from '../helpers';

const fixture = fileURLToPath(new URL('../fixtures/transcript.jsonl', import.meta.url));
const json = JSON.stringify({ phase: 'implement', goal: 'g', done: '- d', decisions: '- x', deadEnds: '- none', next: '- n' });
const ok = { status: 'ok' as const, detail: '', pending: 0, conflicts: [] };

function bigTranscript(ctx: ReturnType<typeof makeCtx>): string {
  const path = join(ctx.configDir, 't.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(600) }] } }) + '\n');
  return path;
}
const logLines = (ctx: ReturnType<typeof makeCtx>) => readFileSync(join(ctx.configDir, SUMMARY_LOG), 'utf8').trim().split('\n');
const input = (ctx: ReturnType<typeof makeCtx>, sessionId: string, transcriptPath = bigTranscript(ctx)) =>
  ({ sessionId, transcriptPath, trigger: 'precompact' as const, cwd: '/' });

describe('summary-errors.log (I5)', () => {
  it('logs a failed claude run with the session id, reason and a scrubbed one-line stderr head', async () => {
    const ctx = makeCtx();
    const stderr = 'claude: command not found\nsee https://u:pw@x.example.com/ ' + 'y'.repeat(400);
    const run = () => { throw new HubError('SUMMARY_FAILED', stderr); };
    expect(await summarizeSession(ctx, input(ctx, 's-1'), { run, persist: async () => ok })).toBeNull();
    const [line] = logLines(ctx);
    const [iso, session, outcome, reason, detail] = line.split('\t');
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
    expect([session, outcome, reason]).toEqual(['s-1', 'fail', 'claude run failed']);
    expect(detail).toContain('command not found');
    expect(detail).not.toContain('u:pw@');
    expect(detail.length).toBeLessThanOrEqual(200);
  });

  it('logs every skip and failure path, and the persist status of a written summary', async () => {
    const ctx = makeCtx();
    const persistRejected = async () => ({ status: 'rejected' as const, detail: 'remote: denied', pending: 1, conflicts: [] });
    await summarizeSession(ctx, input(ctx, 's-short', fixture), { run: () => json, persist: async () => ok });
    await summarizeSession(ctx, input(ctx, 's-missing', join(ctx.configDir, 'nope.jsonl')), { run: () => json, persist: async () => ok });
    await summarizeSession(ctx, input(ctx, 's-dir', ctx.configDir), { run: () => json, persist: async () => ok });
    await summarizeSession(ctx, input(ctx, 's-nojson'), { run: () => 'sorry, no json', persist: async () => ok });
    await summarizeSession(ctx, input(ctx, 's-good'), { run: () => json, persist: persistRejected });
    await summarizeSession(ctx, { ...input(ctx, 's-good'), trigger: 'session-end' }, { run: () => json, persist: async () => ok });
    const rows = logLines(ctx).map((l) => l.split('\t').slice(1, 4));
    expect(rows).toEqual([
      ['s-short', 'skip', 'transcript too short'],
      ['s-missing', 'skip', 'no transcript'],
      ['s-dir', 'fail', 'transcript unreadable'],
      ['s-nojson', 'fail', 'no usable JSON in the reply'],
      ['s-good', 'done', 'written, sync rejected'],
      ['s-good', 'skip', 'already summarized'],
    ]);
    expect(logLines(ctx)[4]).toContain('remote: denied');
  });

  it('keeps only the last lines', () => {
    const ctx = makeCtx();
    for (let i = 0; i < SUMMARY_LOG_MAX_LINES + 30; i++) logSummary(ctx.configDir, { sessionId: `s${i}`, outcome: 'fail', reason: 'r' });
    const lines = logLines(ctx);
    expect(lines).toHaveLength(SUMMARY_LOG_MAX_LINES);
    expect(lines.at(-1)).toContain(`s${SUMMARY_LOG_MAX_LINES + 29}\t`);
    expect(SUMMARY_LOG_MAX_LINES).toBe(200);
  });

  it('never throws, even when the config dir cannot be written', () => {
    const ctx = makeCtx();
    const file = join(ctx.configDir, 'a-file');
    writeFileSync(file, 'x');
    expect(() => logSummary(join(file, 'cfg'), { sessionId: 's', outcome: 'fail', reason: 'r' })).not.toThrow();
  });

  it('the next session brief shows the last failure once', async () => {
    const ctx = makeCtx();
    const deps = { source: fakeAsanaSource([]), sync: async () => null };
    logSummary(ctx.configDir, { sessionId: 's1', outcome: 'fail', reason: 'claude run failed', detail: 'x' });
    expect(await runCheck(ctx, deps, 'prompt')).toBe('');
    const later = (iso: string) => ({ ...ctx, now: () => new Date(iso) });
    expect(await runCheck(later('2026-10-08T11:00:00Z'), deps, 'session')).toBe('[rixflow] last summary failed: claude run failed');
    expect(await runCheck(later('2026-10-08T12:00:00Z'), deps, 'session')).toBe('');
    // A newer success hides an older failure; a later failure is shown again.
    logSummary(ctx.configDir, { sessionId: 's2', outcome: 'fail', reason: 'transcript unreadable' });
    logSummary(ctx.configDir, { sessionId: 's3', outcome: 'done', reason: 'written, sync ok' });
    expect(await runCheck(later('2026-10-08T13:00:00Z'), deps, 'session')).toBe('');
    logSummary(ctx.configDir, { sessionId: 's4', outcome: 'skip', reason: 'transcript too short' });
    logSummary(ctx.configDir, { sessionId: 's5', outcome: 'fail', reason: 'no usable JSON in the reply' });
    expect(await runCheck(later('2026-10-08T14:00:00Z'), deps, 'session')).toBe('[rixflow] last summary failed: no usable JSON in the reply');
  });
});
