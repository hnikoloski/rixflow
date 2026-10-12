import type { InboxItem, Status } from '../types/status'

export const STATUS_VERSION = 2

export const TOOL = {
  start: 'mcp__plugin_rixflow_hub__start_task',
  resume: 'mcp__plugin_rixflow_hub__resume_task',
  checkpoint: 'mcp__plugin_rixflow_hub__checkpoint',
  finish: 'mcp__plugin_rixflow_hub__finish_task',
  drop: 'mcp__plugin_rixflow_hub__drop_task',
} as const

export const RIXFLOW_TOOL = /^mcp__plugin_rixflow_hub__/

export type Parsed = { ok: true; status: Status } | { ok: false; reason: 'invalid' | 'version' }

export function parseStatus(stdout: string): Parsed {
  let v: unknown
  try {
    v = JSON.parse(stdout)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'invalid' }
  const s = v as Status
  if (s.v !== STATUS_VERSION) return { ok: false, reason: 'version' }
  if (!Array.isArray(s.inbox) || !Array.isArray(s.paused) || !Array.isArray(s.problems) || typeof s.sync !== 'object' || s.sync === null) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true, status: s }
}

// `locked`: another process held the hub lock, so this poll did not sync; say nothing.
export function syncPart(s: Status): string | null {
  switch (s.sync.status) {
    case 'ok':
      return '✓ synced'
    case 'offline':
      return `▲ offline (${s.sync.pending} unsynced)`
    case 'skipped':
    case 'locked':
      return null
    default:
      return '▲ sync blocked'
  }
}

export function statusLine(s: Status | null, setupMissing: boolean, context: string | null = null): string {
  // The engine prefixes a plugin's status line with its name ("rixflow-ui:"), so none is added here.
  if (setupMissing || (s && !s.initialized)) return 'setup needed'
  if (!s) return '…'
  const parts: string[] = []
  if (s.current) {
    const { sites, title } = s.current
    parts.push(`▸ ${sites.length && !titleHasSite(title, sites) ? `${sites.join(',')} ` : ''}${title}`)
  }
  const fresh = s.inbox.filter(m => m.status === 'new').length
  if (fresh) parts.push(`✦ ${fresh} new`)
  const sync = syncPart(s)
  if (sync) parts.push(sync)
  if (context) parts.push(context)
  return parts.join(' │ ') || 'idle'
}

// Theme keys, so the colors follow the person's light or dark theme.
export const ACCENT = { brand: 'claude', now: 'success', inbox: 'suggestion', paused: 'warning', sprint: 'permission' } as const

// The header badge: null when this poll did not sync (skipped, locked).
export function syncBadge(s: Status): { label: string; color: 'success' | 'warning' | 'error' } | null {
  switch (s.sync.status) {
    case 'ok':
      return { label: '● SYNCED', color: 'success' }
    case 'offline':
      return { label: `● OFFLINE ${s.sync.pending}`, color: 'warning' }
    case 'skipped':
    case 'locked':
      return null
    default:
      return { label: '● BLOCKED', color: 'error' }
  }
}

const units = (n: number): string => n >= 1_000_000 ? `${+(n / 1e6).toFixed(1)}m` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

// The context-window meter, as in the terminal status line: `████░░░░░░ 42% · 84k/200k`.
// null until the session has a reading with a percent.
export function contextBadge(c: { tokens?: number; window: number; percent?: number } | null): { text: string; color: 'success' | 'warning' | 'error' } | null {
  if (!c || typeof c.percent !== 'number' || !Number.isFinite(c.percent)) return null
  const pct = Math.min(100, Math.max(0, Math.floor(c.percent)))
  const filled = Math.min(10, Math.floor(pct / 10))
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
  const win = Number.isFinite(c.window) && c.window > 0 ? c.window : 0
  const used = Math.max(0, c.tokens ?? Math.round((pct / 100) * win))
  const text = `${bar} ${pct}%${win ? ` · ${units(used)}/${units(win)}` : ''}`
  return { text, color: pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success' }
}

// Columns of padding either side of the pane's content; the pane's width math subtracts twice this.
export const PANE_PAD_X = 2

// A horizontal rule filling what is left of `width` after `used` columns (never negative).
export const rule = (width: number, used: number): string => '─'.repeat(Math.max(0, Math.floor(width) - used))

// `n` columns, the last always a space so columns never touch: cut with an ellipsis, or padded.
export function cell(text: string, n: number): string {
  const room = Math.max(0, n - 1)
  const chars = [...text]
  const fitted = chars.length > room ? `${chars.slice(0, Math.max(0, room - 1)).join('')}…` : text
  return fitted + ' '.repeat(Math.max(1, n - [...fitted].length))
}

// One list row inside `budget` columns: fixed leading columns `cols` ([text, width] each), then
// a flexible `flex` text, then a `tail`. Too narrow: the tail goes first, then the columns from the
// right, so the row's total never exceeds `budget`. The first column is always kept.
export function fitRow(budget: number, cols: ReadonlyArray<readonly [string, number]>, flex: string, tail = '', minFlex = 8): { cols: string[]; flex: string; tail: string } {
  const keep = cols.slice()
  let tl = tail
  const used = () => keep.reduce((n, c) => n + c[1], 0) + [...tl].length
  if (budget - used() < minFlex) tl = ''
  while (keep.length > 1 && budget - used() < minFlex) keep.pop()
  const rest = Math.max(1, budget - used())
  return { cols: keep.map(c => cell(c[0], c[1])), flex: cell(flex, rest), tail: tl }
}

// Asana titles often start with the site code ("AC: …", "AC - …"); then the code is not repeated.
// A title that only begins with the same letters ("ACME import") still gets it.
export function titleHasSite(title: string, sites: readonly string[]): boolean {
  return sites.some(site => title.startsWith(site) && /^(?:$|[\s:|/-])/.test(title.slice(site.length)))
}

// How old a cached sprint is, once it is older than a fresh Asana poll would leave it; else null.
export const STALE_SPRINT_MS = 20 * 60_000
export function staleAge(fetchedAt: string, nowMs: number): string | null {
  const t = Date.parse(fetchedAt)
  return Number.isNaN(t) || nowMs - t < STALE_SPRINT_MS ? null : relTime(fetchedAt, nowMs)
}

export function unseen(s: Status | null, seen: readonly string[]): InboxItem[] {
  if (!s) return []
  const known = new Set(seen)
  return s.inbox.filter(m => m.status === 'new' && !known.has(m.id))
}

// The `hub status` problem for a team setup that needs a newer RixFlow; the band shows it too.
export const UPDATE_PROBLEM = 'tickets: update rixflow'

export type BandParts = { chip: string; who: string; what: string }

export function bandParts(items: InboxItem[]): BandParts {
  const [one] = items
  if (items.length === 1 && one) return { chip: '✦ NEW', who: one.from, what: `${one.type} · ${one.preview}` }
  const senders = [...new Set(items.map(m => m.from))]
  return { chip: `✦ ${items.length} NEW`, who: senders.join(', '), what: 'waiting in your inbox' }
}

export function remember(seen: readonly string[], ids: readonly string[], cap = 200): string[] {
  const add = ids.filter(id => !seen.includes(id))
  return [...seen, ...add].slice(-cap)
}

export type Action =
  | { kind: 'checkpoint' }
  | { kind: 'wrapup' }
  | { kind: 'inbox'; id?: string }
  | { kind: 'resume'; task: string }
  | { kind: 'start'; task: string }
  | { kind: 'setup' }

export function fillFor(a: Action): string {
  switch (a.kind) {
    case 'inbox':
      return a.id ? `/rixflow:inbox ${a.id}` : '/rixflow:inbox'
    case 'resume':
      return `/rixflow:resume ${a.task}`
    case 'start':
      return `/rixflow:start ${a.task}`
    default:
      return `/rixflow:${a.kind}`
  }
}

export const canFill = (draft: string): boolean => draft.trim() === ''

export function relTime(iso: string | null, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t)) return ''
  const min = Math.floor((nowMs - t) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

export function fit<T>(items: readonly T[], room: number): { shown: T[]; more: number } {
  const n = Math.max(0, Math.min(items.length, room))
  return { shown: items.slice(0, n), more: items.length - n }
}

export function nextCurrentTask(prev: string | null, tool: string, input: { task?: unknown }, isOk: boolean): string | null {
  if (!isOk) return prev
  if (tool === TOOL.start || tool === TOOL.resume) return typeof input.task === 'string' && /^(\d{1,30}|[A-Z][A-Z0-9_]{0,19}-\d{1,10})$/.test(input.task) ? input.task : prev
  // Pausing or finishing another task leaves this session's task alone.
  if (tool === TOOL.checkpoint) return input.task === undefined || input.task === prev ? null : prev
  if (tool === TOOL.finish || tool === TOOL.drop) return input.task === prev ? null : prev
  return prev
}

const ASANA_EVERY_MS = 15 * 60_000

export function shouldFetchAsana(nowMs: number, lastAsanaAt: number, lastPromptAt: number): boolean {
  return nowMs - lastAsanaAt >= ASANA_EVERY_MS && nowMs - lastPromptAt < ASANA_EVERY_MS
}

export type Refresh = { asana: boolean; refresh: boolean }

type RefreshJob = { r: Refresh; work: (r: Refresh) => Promise<boolean>; waiters: Array<(ok: boolean) => void> }

// At most one refresh runs at a time. A call made while one runs is skipped (a timer tick,
// `queue` false) or kept in one pending slot (an event, `queue` true): queued calls merge
// (`asana` / `refresh` ORed, the latest `work`) and run once after the current one ends.
// Resolves with what the run covering the call returned (a throwing `work` counts as false),
// false when skipped. Each waiter gets its own run's result, never a later run's.
export function refreshGate(): (r: Refresh, work: (r: Refresh) => Promise<boolean>, queue: boolean) => Promise<boolean> {
  let running = false
  let pending: RefreshJob | null = null
  const loop = async (first: RefreshJob) => {
    let job: RefreshJob | null = first
    while (job) {
      let ok = false
      try {
        ok = await job.work(job.r)
      } catch {
        // the caller's work reports its own failures
      }
      for (const done of job.waiters) done(ok)
      job = pending
      pending = null
    }
    running = false
  }
  return (r, work, queue) => new Promise<boolean>(resolve => {
    if (!running) {
      running = true
      void loop({ r, work, waiters: [resolve] })
    } else if (!queue) {
      resolve(false)
    } else {
      const prev: RefreshJob | null = pending
      pending = prev
        ? { r: { asana: prev.r.asana || r.asana, refresh: prev.r.refresh || r.refresh }, work, waiters: [...prev.waiters, resolve] }
        : { r, work, waiters: [resolve] }
    }
  })
}

export function statusArgv(cli: string, cwd: string, task: string | null, r: Refresh): string[] {
  const argv = ['node', cli, 'status', '--json', '--cwd', cwd]
  if (task) argv.push('--task', task)
  if (r.asana) argv.push('--asana')
  if (r.refresh) argv.push('--refresh')
  return argv
}

export function cliPath(configDirEnv: string | undefined, home: string): string {
  const dir = configDirEnv ? configDirEnv.replace(/\/+$/, '') : `${home.replace(/\/+$/, '')}/.config/rixflow`
  return `${dir}/hub.cjs`
}
