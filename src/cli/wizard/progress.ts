import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const SUSPECT = /token|password|secret/i;

function suspicious(text: string): boolean {
  return SUSPECT.test(text) || findSecrets(text).length > 0;
}

function assertClean(v: unknown, depth = 0): void {
  if (depth > 50) throw new HubError('BAD_PROGRESS', 'Progress is nested too deeply.');
  if (typeof v === 'string') {
    if (suspicious(v)) throw new HubError('BAD_PROGRESS', 'Refusing to save a secret in the setup progress file.');
  } else if (Array.isArray(v)) {
    for (const x of v) assertClean(x, depth + 1);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (suspicious(k)) throw new HubError('BAD_PROGRESS', 'Refusing to save a secret in the setup progress file.');
      assertClean(x, depth + 1);
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
    if (existsSync(f) || lstatOrNull(f)) {
      if (lstatSync(f).isSymbolicLink()) throw new HubError('BAD_PROGRESS', `${f} is a symlink; refusing to write it.`);
    }
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
      state = { ...state, done: [...state.done, step.id], answers: { ...state.answers, ...out }, updatedAt: new Date().toISOString() };
      i++;
    }
    saveProgress(configDir, state);
  }
  clearProgress(configDir);
  return state.answers;
}
