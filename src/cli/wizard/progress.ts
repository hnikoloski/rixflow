import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSecrets } from '../../core/scrub';
import { HubError } from '../../core/types';
import type { InitIo } from '../init';
import { confirm } from './prompts';

export interface Progress { flow: 'create' | 'join'; done: string[]; answers: Record<string, unknown>; updatedAt: string }
type Answers = Record<string, unknown>;
type StepResult = Answers | { goto: string };
export interface Step { id: string; run: (a: Answers) => Promise<StepResult> }

const file = (configDir: string) => join(configDir, 'setup-progress.json');
// Keys are checked by name (a key called jiraToken is refused whatever it holds); values only by
// findSecrets, so an ordinary folder like ~/secret-projects is not mistaken for a secret.
const SUSPECT_KEY = /token|password|secret/i;

function assertClean(v: unknown, depth = 0, key = 'value'): void {
  if (depth > 50) throw new HubError('BAD_PROGRESS', 'Progress is nested too deeply.');
  if (typeof v === 'string') {
    if (findSecrets(v).length > 0) throw new HubError('BAD_PROGRESS', `Refusing to save a secret in the setup progress file (${key}).`);
  } else if (Array.isArray(v)) {
    for (const x of v) assertClean(x, depth + 1, key);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const shown = k.replace(/[^\w.-]/g, '?').slice(0, 40);
      if (SUSPECT_KEY.test(k) || findSecrets(k).length > 0) {
        throw new HubError('BAD_PROGRESS', `Refusing to save a secret in the setup progress file (${shown}).`);
      }
      assertClean(x, depth + 1, shown);
    }
  }
}

export function loadProgress(configDir: string): Progress | null {
  try {
    const p = JSON.parse(readFileSync(file(configDir), 'utf8')) as Progress;
    if (!p || (p.flow !== 'create' && p.flow !== 'join')) return null;
    if (!Array.isArray(p.done) || !p.done.every((d) => typeof d === 'string')) return null;
    if (p.answers === null || typeof p.answers !== 'object' || Array.isArray(p.answers)) return null;
    return { flow: p.flow, done: p.done, answers: p.answers, updatedAt: String(p.updatedAt ?? '') };
  } catch {
    return null;
  }
}

export function saveProgress(configDir: string, p: Progress): void {
  assertClean(p.answers);
  assertClean(p.done);
  const target = file(configDir);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  for (const f of [target, `${target}.tmp`]) {
    if (lstatOrNull(f)?.isSymbolicLink()) throw new HubError('BAD_PROGRESS', `${f} is a symlink; refusing to write it.`);
  }
  const tmp = `${target}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(tmp, target);
}

function lstatOrNull(f: string) {
  try { return lstatSync(f); } catch { return null; }
}

export function clearProgress(configDir: string): void {
  rmSync(file(configDir), { force: true });
}

export async function runSteps(io: InitIo, configDir: string, flow: Progress['flow'], steps: Step[]): Promise<Answers> {
  let state: Progress = { flow, done: [], answers: {}, updatedAt: '' };
  const prev = loadProgress(configDir);
  if (prev && prev.flow === flow) {
    const last = prev.done[prev.done.length - 1];
    if (last === undefined) clearProgress(configDir);
    else if (await confirm(io, `Continue where you stopped (${last})?`, true)) state = prev;
    else clearProgress(configDir);
  }
  const answers = await walk(steps, state, (s) => {
    state = { ...state, ...s, updatedAt: new Date().toISOString() };
    saveProgress(configDir, state);
  });
  clearProgress(configDir);
  return answers;
}

// The same steps (with "go back"), starting from given answers and saving nothing: the wizard
// menu's redo of the ticket mapping, which is short and is simply started again if interrupted.
export async function runStepsFrom(steps: Step[], answers: Answers): Promise<Answers> {
  return walk(steps, { done: [], answers }, () => {});
}

async function walk(steps: Step[], start: { done: string[]; answers: Answers }, save: (s: { done: string[]; answers: Answers }) => void): Promise<Answers> {
  let state = { done: start.done, answers: start.answers };
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    if (state.done.includes(step.id)) { i++; continue; }
    const out = await step.run(state.answers);
    if ('goto' in out && typeof out.goto === 'string' && Object.keys(out).length === 1) {
      const t = steps.findIndex((s) => s.id === out.goto);
      if (t < 0) throw new HubError('BAD_STEP', `Unknown step: ${out.goto}`);
      const drop = new Set(steps.slice(t).map((s) => s.id));
      state = { ...state, done: state.done.filter((d) => !drop.has(d)) };
      i = t;
    } else {
      state = { done: [...state.done, step.id], answers: { ...state.answers, ...out } };
      i++;
    }
    save(state);
  }
  return state.answers;
}
