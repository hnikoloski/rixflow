import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrub } from './scrub';

// <configDir>/summary-errors.log: one tab-separated line per summarizer outcome:
// ISO time, session id, outcome (fail | skip | done), reason, scrubbed detail (max 200 chars).
export const SUMMARY_LOG = 'summary-errors.log';
export const SUMMARY_LOG_MAX_LINES = 200;
const DETAIL_MAX = 200;

export type SummaryOutcome = 'fail' | 'skip' | 'done';

export interface SummaryLogEntry {
  sessionId: string;
  outcome: SummaryOutcome;
  reason: string;
  detail?: string;
  now?: Date;
}

const field = (text: string, max: number): string => {
  const one = scrub(String(text)).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};

// Never throws: a summarizer that cannot log must still exit quietly.
export function logSummary(configDir: string, entry: SummaryLogEntry): void {
  try {
    const path = join(configDir, SUMMARY_LOG);
    mkdirSync(configDir, { recursive: true });
    const line = [
      (entry.now ?? new Date()).toISOString(), field(entry.sessionId, 100) || '-', entry.outcome,
      field(entry.reason, 100), field(entry.detail ?? '', DETAIL_MAX),
    ].join('\t');
    appendFileSync(path, `${line}\n`);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (lines.length > SUMMARY_LOG_MAX_LINES) writeFileSync(path, `${lines.slice(-SUMMARY_LOG_MAX_LINES).join('\n')}\n`);
  } catch {
    // nowhere to log; stay quiet
  }
}

// The most recent fail-or-done line (skips are normal and ignored), when it is a failure.
export function lastSummaryFailure(configDir: string): { at: string; reason: string } | null {
  try {
    const path = join(configDir, SUMMARY_LOG);
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const [at, , outcome, reason] = lines[i].split('\t');
      if (outcome === 'done') return null;
      if (outcome === 'fail') return { at, reason: reason ?? '' };
    }
    return null;
  } catch {
    return null;
  }
}
