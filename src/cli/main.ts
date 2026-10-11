import { resolve } from 'node:path';
import { Command } from 'commander';
import { runCheck } from '../core/check';
import { configDir, loadCtx } from '../core/config';
import { Git, pendingCount, type SyncResult } from '../core/git';
import type { Trigger } from '../core/notes';
import { describeSync, makeSource, persist, syncHub } from '../core/runtime';
import { scrub } from '../core/scrub';
import { runClaude, summarizeSession } from '../core/summarize';
import { logSummary } from '../core/summarylog';
import { bootstrapHub } from '../core/template';
import { setToken } from '../core/token';
import { HubError, type Ctx, type Role } from '../core/types';
import { detachedSummarySpawner, detachedSync, runHook } from './hooks';
import { refreshHookCopy, runInit, terminalIo } from './init';
import { hubCliPath } from '../core/command';
import { buildStatus, emptyStatus, type HubStatus } from '../core/status';
import { verifyStaged } from './verify';

const cliPath = resolve(process.argv[1] ?? 'hub.cjs');

const STDIN_TIMEOUT_MS = 3_000;

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolveStdin) => {
    let data = '';
    const done = () => {
      clearTimeout(timer);
      resolveStdin(data);
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

// Prints, then exits 0 explicitly so abandoned git/Asana work cannot keep the process alive.
function printAndExit0(text: string): void {
  process.stdout.on('error', () => process.exit(0));
  if (!text) process.exit(0);
  process.stdout.write(text, () => process.exit(0));
}

// Hooks and status sync through a detached child: when they give up waiting, it still finishes.
const syncChild = detachedSync(cliPath);

const check = (ctx: Ctx, trigger: 'session' | 'prompt') =>
  runCheck(ctx, { source: () => makeSource(ctx), sync: syncChild }, trigger);

// Once per start, best effort: keep the pre-commit copy of the CLI in step with this bundle.
refreshHookCopy(configDir(), hubCliPath());

const program = new Command('hub').description('RixFlow CLI');

program.command('init').description('set up this machine').action(async () => {
  await runInit(terminalIo(), cliPath);
});

program.command('sync').description('commit and sync the hub')
  .option('--json', 'print the result as JSON (null: hub not set up); skips when the hub is locked')
  .action(async (opts) => {
    if (!opts.json) {
      console.log(describeSync(await persist(loadCtx(), 'sync')));
      return;
    }
    // The caller may stop reading early; the sync still runs to the end before anything is printed.
    let r: SyncResult | null = null;
    try {
      r = await syncHub(loadCtx());
    } catch {
      r = null;
    }
    printAndExit0(`${JSON.stringify(r)}\n`);
  });

program.command('check').option('--trigger <trigger>', 'session|prompt', 'session').action(async (opts) => {
  let out = '';
  try {
    out = await check(loadCtx(), opts.trigger === 'prompt' ? 'prompt' : 'session');
  } catch {
    // never fail
  }
  printAndExit0(out || 'nothing new');
});

program
  .command('status')
  .description('status of the hub as JSON, for the RixFlow UI')
  .option('--json', 'print JSON (the only format)')
  .option('--cwd <dir>', 'folder for the current-task fallback')
  .option('--task <gid>', 'current task of the calling session')
  .option('--asana', 'refresh Asana data older than 10 minutes (without it, the cached sprint is shown)')
  .option('--refresh', 'with --asana, bypass the cache')
  .option('--no-sync', 'read local files only')
  .action(async (opts) => {
    let out: HubStatus;
    try {
      out = await buildStatus(
        { cwd: opts.cwd ?? process.cwd(), task: opts.task, asana: !!opts.asana, refresh: !!opts.refresh, sync: opts.sync !== false },
        { loadCtx: () => loadCtx(), sync: syncChild, source: (ctx) => makeSource(ctx), pending: (ctx) => pendingCount(new Git(ctx.hubDir)),
          startedAt: performance.timeOrigin },
      );
    } catch {
      out = emptyStatus(new Date(), ['status failed']);
    }
    printAndExit0(`${JSON.stringify(out)}\n`);
  });

program.command('hook <event>').description('used by Claude Code hooks').action(async (event: string) => {
  if (process.env.RIXFLOW_CHILD === '1') process.exit(0);
  let out = '';
  try {
    out = await runHook(event, await readStdin(), {
      env: process.env,
      loadCtx: () => loadCtx(),
      check,
      spawnSummary: detachedSummarySpawner(cliPath),
      timeoutMs: event === 'prompt' ? 8_000 : 15_000,
    });
  } catch {
    out = '';
  }
  printAndExit0(out);
});

const SUMMARY_TRIGGERS = ['precompact', 'session-end', 'checkpoint', 'wrapup'];

// Runs detached: catches everything, logs only to a file, always exits 0.
program.command('summary')
  .requiredOption('--session <id>').requiredOption('--transcript <path>').requiredOption('--trigger <trigger>')
  .option('--cwd <dir>', 'session working directory', process.cwd())
  .action(async (opts) => {
    try {
      if (!SUMMARY_TRIGGERS.includes(opts.trigger)) throw new HubError('BAD_TRIGGER', `unknown trigger: ${opts.trigger}`);
      const ctx = loadCtx();
      await summarizeSession(ctx, {
        sessionId: opts.session, transcriptPath: opts.transcript, trigger: opts.trigger as Trigger, cwd: opts.cwd,
      }, { run: runClaude, persist: (m) => persist(ctx, m) });
    } catch (e) {
      logSummary(configDir(), { sessionId: String(opts.session), outcome: 'fail', reason: 'summary worker error', detail: String(e) });
    }
    process.exit(0);
  });

program.command('verify-commit').description('pre-commit check for the hub repo').action(async () => {
  try {
    const problems = await verifyStaged(new Git(process.cwd()), loadCtx().user.name);
    if (problems.length) {
      console.error(`RixFlow: commit blocked\n${problems.map((p) => `  - ${p}`).join('\n')}`);
      process.exit(1);
    }
  } catch (e) {
    // Fail closed: a git or parse error must never let a commit through.
    console.error(`RixFlow: commit blocked (could not verify staged changes: ${e instanceof Error ? e.message : String(e)})`);
    process.exit(1);
  }
  process.exit(0);
});

program.command('scrub').description('redact secrets from stdin').action(async () => {
  process.stdout.write(scrub(await readStdin()));
});

program.command('token').command('set').description('store the Asana token').action(async () => {
  const token = await terminalIo().askHidden('Asana personal access token (input hidden): ');
  let user: string | undefined;
  try {
    user = loadCtx().user.name;
  } catch {
    user = undefined; // before init: the legacy keychain account
  }
  console.log(`stored in ${setToken(configDir(), token, undefined, user)}`);
});

function parseMembers(list: string): { name: string; role: Role }[] {
  return list.split(',').map((pair) => {
    const [name, role, ...rest] = pair.split(':');
    if (!name || (role !== 'dev' && role !== 'pm') || rest.length) {
      throw new HubError('BAD_ARGS', `invalid member "${pair}", expected name:dev or name:pm`);
    }
    return { name, role };
  });
}

function parseSites(list: string): Record<string, { folder: string }> {
  const out: Record<string, { folder: string }> = {};
  for (const pair of list.split(',')) {
    const [code, folder, ...rest] = pair.split(':');
    if (!code || !folder || rest.length) throw new HubError('BAD_ARGS', `invalid site "${pair}", expected CODE:folder`);
    out[code] = { folder };
  }
  return out;
}

program.command('bootstrap <dir>')
  .requiredOption('--members <list>', 'name:role,name:role')
  .option('--sites <list>', 'CODE:folder,CODE:folder', 'AC:acme,GL:globex-web')
  .action(async (dir: string, opts) => {
    await bootstrapHub(dir, parseMembers(String(opts.members)), parseSites(String(opts.sites)));
    console.log(`Hub created in ${dir}. Add a remote and push: git -C ${dir} remote add origin <url> && git -C ${dir} push -u origin main`);
  });

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
