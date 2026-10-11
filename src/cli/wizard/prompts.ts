import type { InitIo } from '../init';
import { HubError } from '../../core/types';

export const ABORTED_MESSAGE = 'Setup stopped. Run it again to continue where you left off.';
const MAX_TRIES = 3;

const aborted = () => new HubError('ABORTED', ABORTED_MESSAGE);

// Asks once. A closed stdin (or an empty answer after EOF) aborts instead of looping.
async function ask(io: InitIo, question: string): Promise<string> {
  if (io.closed) throw aborted();
  const a = (await io.ask(question)).trim();
  if (io.closed && a === '') throw aborted();
  return a;
}

export async function choose<T extends string>(
  io: InitIo, question: string, options: Array<{ value: T; label: string }>, fallback?: T,
): Promise<T> {
  const fb = fallback === undefined ? -1 : options.findIndex((o) => o.value === fallback);
  const lines = options.map((o, i) => `  ${i + 1}) ${o.label}${i === fb ? ' (default)' : ''}`);
  for (let i = 0; i < MAX_TRIES; i++) {
    io.log(`${question}\n${lines.join('\n')}`);
    const a = await ask(io, `Choose 1-${options.length}${fb >= 0 ? ` [${fb + 1}]` : ''}: `);
    if (a === '' && fb >= 0) return options[fb].value;
    if (/^\d+$/.test(a)) {
      const n = Number(a);
      if (n >= 1 && n <= options.length) return options[n - 1].value;
    }
    io.log(`Please enter a number from 1 to ${options.length}.`);
  }
  throw aborted();
}

export async function confirm(io: InitIo, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  for (let i = 0; i < MAX_TRIES; i++) {
    const a = (await ask(io, `${question} (${hint}) `)).toLowerCase();
    if (a === '') return defaultYes;
    if (a === 'y' || a === 'yes') return true;
    if (a === 'n' || a === 'no') return false;
    io.log('Please answer y or n.');
  }
  throw aborted();
}

export async function askValid(
  io: InitIo, question: string, validate: (s: string) => string | null, fallback?: string,
): Promise<string> {
  for (let i = 0; i < MAX_TRIES; i++) {
    let a = await ask(io, fallback !== undefined ? `${question} [${fallback}] ` : `${question} `);
    if (a === '' && fallback !== undefined) a = fallback;
    const err = validate(a);
    if (err === null) return a;
    io.log(err);
  }
  throw aborted();
}
