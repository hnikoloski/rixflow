import type { InitIo } from '../../../src/cli/init';

export type ScriptedIo = InitIo & { logs: string[]; asked: string[]; left(): number };

// Answers are consumed in order; once they run out the io behaves like EOF.
export function scriptedIo(answers: string[]): ScriptedIo {
  const queue = [...answers];
  const io: ScriptedIo = {
    closed: false,
    logs: [],
    asked: [],
    left: () => queue.length,
    ask: async (q) => {
      io.asked.push(q);
      if (queue.length === 0) { io.closed = true; return ''; }
      return queue.shift() as string;
    },
    askHidden: async (q) => io.ask(q),
    log: (t) => { io.logs.push(t); },
  };
  return io;
}
