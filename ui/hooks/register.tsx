import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { InboxItem, Status, View } from '../types'
import {
  ACCENT, bandParts, canFill, cell, contextBadge, cliPath, fitRow, staleAge, titleHasSite, fillFor, fit, nextCurrentTask, parseStatus, relTime, remember, RIXFLOW_TOOL,
  PANE_PAD_X, refreshGate, rule, shouldFetchAsana, statusArgv, statusLine, syncBadge, TOOL, unseen, UPDATE_PROBLEM, type Action, type Refresh,
} from './model'

const PANE = 'rixflow'
const SEEN_KEY = 'seenMessageIds'
const FAST_MS = 30_000
const TICK_ASANA_MS = 60_000
const RUN_TIMEOUT_MS = 10_000

const view = atom({ plugin: 'rixflow-ui', key: 'view' } as const, { status: null, error: null, updatedAt: 0 } as View)
const currentTask = atom({ plugin: 'rixflow-ui', key: 'currentTask' } as const, null as string | null)

// Module state: a reload runs the module afresh (timers dropped), and session.start sets it again.
// `$` is only ever handed to the top-level functions below (`claude plugin validate` requires that).
// `active` is set only for an interactive terminal session that is not a RixFlow child; every
// other hook is a no-op until then.
const mod = { active: false, cwd: '.', lastAsanaAt: 0, lastPromptAt: 0, context: null as ReturnType<typeof contextBadge>, seen: [] as string[] }

// At most one `status` process at a time. A timer tick that finds one running is skipped; an
// event (a rixflow tool call, ↻, `/rixflow-ui refresh`) is queued and runs once after it.
const gate = refreshGate()

// Resolves true when this run got a good status.
async function poll($: EngineInterface, r: Refresh): Promise<boolean> {
  const home = (await $.env.get('HOME')) ?? ''
  const cli = cliPath(await $.env.get('RIXFLOW_CONFIG_DIR'), home)
  try {
    await $.fs.stat(cli)
  } catch {
    await update($, view, v => ({ ...v, error: 'setup' as const }))
    $.ui.status(statusLine(null, true))
    return false
  }
  if (r.asana) mod.lastAsanaAt = await $.clock.now()
  let error: View['error'] = null
  let next: Status | null = null
  try {
    const out = await $.process.run(statusArgv(cli, mod.cwd, await read($, currentTask), r), { timeoutMs: RUN_TIMEOUT_MS })
    if (out.exitCode !== 0 && !out.stdout.trim()) {
      // A core without `status` exits 1 with nothing on stdout: before any good status, ask for an update.
      error = (await read($, view)).status ? 'failed' : 'version'
    } else {
      const parsed = parseStatus(out.stdout)
      if (parsed.ok) next = parsed.status
      else error = parsed.reason
    }
  } catch {
    error = 'failed'
  }
  const now = await $.clock.now()
  const v = await update($, view, old => next ? { status: next, error: null, updatedAt: now } : { ...old, error })
  $.ui.status(v.error === 'version' ? '▲ update rixflow / rixflow-ui' : statusLine(v.status, false, mod.context?.text ?? null))
  return next !== null
}

// The context meter: never a model call, never breaks the session.
async function setContext($: EngineInterface, c: Parameters<typeof contextBadge>[0]): Promise<void> {
  try {
    mod.context = contextBadge(c)
    const v = await read($, view)
    if (v.status && !v.error) $.ui.status(statusLine(v.status, false, mod.context?.text ?? null))
    $.ui.invalidate('ui.render')
  } catch {
    // ignore
  }
}

// Resolves true only when a run covering this call finished with a good status.
async function refresh($: EngineInterface, r: Refresh, queue = false): Promise<boolean> {
  try {
    return await gate(r, next => poll($, next), queue)
  } catch {
    return false
  }
}

async function fill($: EngineInterface, a: Action): Promise<void> {
  try {
    const box = await $.prompt.read()
    if (!canFill(box.text)) {
      $.ui.toast('Prompt box not empty')
      return
    }
    await $.prompt.fill({ text: fillFor(a), mode: 'replace' })
  } catch {
    // A button never breaks the session.
  }
}

async function markSeen($: EngineInterface, items: InboxItem[]): Promise<void> {
  mod.seen = remember(mod.seen, items.map(m => m.id))
  $.ui.invalidate('ui.render')
  try {
    await $.store.set(SEEN_KEY, mod.seen)
  } catch {
    // Kept for this session even when the store refuses.
  }
}

async function togglePane($: EngineInterface): Promise<string> {
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === PANE && p.isPlaced && p.isShown)) {
    await $.ui.close({ id: PANE })
    return 'RixFlow pane closed.'
  }
  await $.ui.open({ id: PANE, title: 'RixFlow' })
  return 'RixFlow pane opened.'
}

function startPolling($: EngineInterface): void {
  $.clock.every(FAST_MS, () => void refresh($, { asana: false, refresh: false }))
  $.clock.every(TICK_ASANA_MS, () => void tickAsana($))
}

async function tickAsana($: EngineInterface): Promise<void> {
  try {
    if (shouldFetchAsana(await $.clock.now(), mod.lastAsanaAt, mod.lastPromptAt)) await refresh($, { asana: true, refresh: false })
  } catch {
    // next tick
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    try {
      mod.active = e.isInteractive && e.surface === 'terminal' && (await $.env.get('RIXFLOW_CHILD')) !== '1'
    } catch {
      mod.active = false
    }
    if (!mod.active) return ran
    try {
      mod.cwd = e.cwd || mod.cwd
      const stored = await $.store.get(SEEN_KEY)
      mod.seen = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
    } catch {
      // Nothing seen yet.
    }
    try {
      await $.command.register({ name: 'rixflow-ui', description: 'Toggle the RixFlow pane (add "refresh" to refresh now)', argumentHint: '[refresh]' })
      void $.ui.open({ id: PANE, title: 'RixFlow' }).catch(() => undefined)
      // Not awaited: the first turn never waits on git or Asana. The Asana run queues behind the fast one.
      void refresh($, { asana: false, refresh: false })
      void refresh($, { asana: true, refresh: false }, true)
      startPolling($)
      void $.session.usage().then(u => setContext($, u.context)).catch(() => undefined)
    } catch {
      // The UI must never break the session.
    }
    return ran
  })

  on('session.measure', async ($, e, next) => {
    const ran = await next(e)
    if (mod.active && e.changed.includes('context')) await setContext($, e.context)
    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (!mod.active) return next(e)
    try {
      mod.lastPromptAt = await $.clock.now()
    } catch {
      // ignore
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!mod.active || !RIXFLOW_TOOL.test(e.tool)) return ran
    try {
      const isOk = ran.deny === undefined && !ran.isError
      await update($, currentTask, prev => nextCurrentTask(prev, e.tool, e as { task?: unknown }, isOk))
      const switched = e.tool === TOOL.start || e.tool === TOOL.resume || e.tool === TOOL.finish
      void refresh($, { asana: switched, refresh: false }, true)
    } catch {
      // ignore
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'rixflow-ui' }, async ($, e) => {
    if (!mod.active) return { text: 'RixFlow UI runs only in interactive terminal sessions.' }
    try {
      if (e.args.trim() === 'refresh') {
        const ran = await refresh($, { asana: true, refresh: true }, true)
        return { text: ran ? 'RixFlow refreshed.' : 'RixFlow refresh failed.' }
      }
      return { text: await togglePane($) }
    } catch {
      return { text: 'RixFlow: could not open the pane.' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!mod.active) return next(e)
    const { status } = await read($, view)
    const items = unseen(status, mod.seen)
    const update = status?.problems.includes(UPDATE_PROBLEM) ?? false
    if ((!items.length && !update) || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const [one] = items
    const open: Action = items.length === 1 && one ? { kind: 'inbox', id: one.id } : { kind: 'inbox' }
    const band = items.length ? bandParts(items) : null
    return (
      <Box flexDirection="column" paddingX={1}>
        {update && <Text color="warning" wrap="truncate">▲ {UPDATE_PROBLEM}</Text>}
        {band && (
          <Box>
            <Text backgroundColor={ACCENT.inbox} color="inverseText" bold> {band.chip} </Text>
            <Text color={ACCENT.inbox} bold> {band.who}</Text>
            <Box flexShrink={1}>
              <Text color="subtle" wrap="truncate"> {band.what} </Text>
            </Box>
            <Box gap={1} marginLeft={1}>
              <Button key="band-open" variant="primary" label={items.length === 1 ? 'Open' : 'Open inbox'} onPress={async () => { await markSeen($, items); await fill($, open) }} />
              <Button key="band-later" dimColor label="Later" onPress={() => markSeen($, items)} />
            </Box>
          </Box>
        )}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!mod.active) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const { status: s, error, updatedAt } = await read($, view)
    const now = await $.clock.now()
    // The columns inside the pane's own horizontal padding: every row and rule is sized to this.
    const width = Math.max(32, e.props.bodyColumns ?? e.viewport?.columns ?? 60) - 2 * PANE_PAD_X
    if (error === 'setup' || (s && !s.initialized)) {
      return (
        <Box flexDirection="column" paddingX={PANE_PAD_X} paddingY={1}>
        <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text color="warning" bold>◆ RIXFLOW · SETUP NEEDED</Text>
          <Text color="subtle">RixFlow is not set up on this machine.</Text>
          <Box marginTop={1}>
            <Button key="setup" variant="primary" label="Setup" onPress={() => fill($, { kind: 'setup' })} />
          </Box>
        </Box>
        </Box>
      )
    }
    if (error === 'version') return <Box paddingX={PANE_PAD_X} paddingY={1}><Text color="warning" wrap="truncate">▲ update rixflow / rixflow-ui</Text></Box>
    if (!s) return <Box paddingX={PANE_PAD_X} paddingY={1}><Text color="subtle">◆ RIXFLOW · loading…</Text></Box>
    const rows = Math.max(8, (e.viewport?.rows ?? 30) - 14)
    const per = Math.max(2, Math.floor(rows / 3))
    const inbox = fit(s.inbox, per)
    const paused = fit(s.paused, per)
    const sprint = fit(s.sprint?.items.filter(i => !i.paused && i.task !== s.current?.task) ?? [], per)
    const fresh = s.inbox.filter(m => m.status === 'new').length
    const badge = syncBadge(s)
    const age = relTime(new Date(updatedAt).toISOString(), now) || 'now'
    const failed = error === 'failed' || error === 'invalid'
    const stale = s.sprint ? staleAge(s.sprint.fetchedAt, now) : null
    // Room left on a row for its text after the gutter (2) and its button (~10).
    const text = Math.max(12, width - 12)

    // The title row stacks (name above, badges below) when both do not fit side by side.
    const rightLen = (badge ? [...badge.label].length : 0) + (mod.context ? [...mod.context.text].length : 0) + (badge && mod.context ? 1 : 0)
    const user = `@${s.user ?? '?'}`
    const stacked = 9 + 2 + [...user].length + 1 + rightLen > width
    const userText = cell(user, Math.max(2, width - 11)).trimEnd()

    // A section: an inverse chip in the section's color, a rule to the right edge and a count.
    const head = (icon: string, full: string, color: string, meta: string) => {
      const label = cell(full, Math.max(4, width - meta.length - 9)).trimEnd()
      return (
      <Box marginTop={1}>
        <Text backgroundColor={color} color="inverseText" bold> {icon} {label} </Text>
        <Text color={color}> {rule(width, label.length + meta.length + 9)} </Text>
        <Text color={color} bold>{meta}</Text>
      </Box>
      )
    }
    const gutter = (color: string) => <Text color={color}>▎ </Text>
    const more = (n: number, color: string) => n > 0 && <Box>{gutter(color)}<Text color="subtle">+{n} more</Text></Box>
    const empty = (label: string, color: string) => <Box>{gutter(color)}<Text color="inactive" italic>{label}</Text></Box>

    return (
      <Box flexDirection="column" paddingX={PANE_PAD_X} paddingY={1}>
        <Box justifyContent="space-between" flexDirection={stacked ? 'column' : 'row'}>
          <Box>
            <Text color={ACCENT.brand} bold>◆ RIXFLOW</Text>
            <Text color="subtle">  {userText}</Text>
          </Box>
          <Box gap={1}>
            {badge && <Text color={badge.color} bold>{badge.label}</Text>}
            {mod.context && <Text color={mod.context.color}>{mod.context.text}</Text>}
          </Box>
        </Box>

        {s.current ? (
          <Box flexDirection="column" borderStyle="round" borderColor={ACCENT.now} paddingX={1} marginTop={1}>
            <Box justifyContent="space-between">
              <Text backgroundColor={ACCENT.now} color="inverseText" bold> ▸ NOW </Text>
              {s.current.startedAt && <Text color={ACCENT.now}>◷ {relTime(s.current.startedAt, now)}</Text>}
            </Box>
            <Box>
              {s.current.sites.length > 0 && !titleHasSite(s.current.title, s.current.sites) && <Text color={ACCENT.now} bold>{s.current.sites.join(' ')}  </Text>}
              <Text bold wrap="truncate">{s.current.title}</Text>
            </Box>
            <Box>
              {s.current.status && <Text color="subtle" wrap="truncate">{s.current.status.toUpperCase()}</Text>}
              {s.current.due && <Text color="warning" wrap="truncate">{s.current.status ? '  ·  ' : ''}due {s.current.due}</Text>}
            </Box>
            <Box marginTop={1} gap={2}>
              <Button key="checkpoint" variant="primary" hotkey="c" label="Checkpoint" onPress={() => fill($, { kind: 'checkpoint' })} />
              <Button key="wrapup" hotkey="w" label="Wrap up" onPress={() => fill($, { kind: 'wrapup' })} />
            </Box>
          </Box>
        ) : (
          <Box borderStyle="round" borderColor="inactive" paddingX={1} marginTop={1}>
            <Text color="inactive" bold>▸ NOW  </Text>
            <Text color="inactive" italic>no task in this session</Text>
          </Box>
        )}

        {head('✦', 'INBOX', ACCENT.inbox, fresh ? `${fresh} NEW / ${s.inbox.length}` : `${s.inbox.length}`)}
        {inbox.shown.length === 0 && empty('no messages', ACCENT.inbox)}
        {inbox.shown.map(m => {
          const dot = m.status === 'new' ? '● ' : '○ '
          const r = fitRow(text, [[dot, 2], [m.from, 11], [m.type.toUpperCase(), 9], [relTime(m.created, now), 5]], m.preview)
          return (
          <Box key={`m-${m.id}`}>
            {gutter(ACCENT.inbox)}
            <Box flexGrow={1} flexShrink={1}>
              <Text color={m.status === 'new' ? ACCENT.inbox : 'inactive'}>{dot}</Text>
              {r.cols[1] !== undefined && <Text bold={m.status === 'new'}>{r.cols[1]}</Text>}
              {r.cols[2] !== undefined && <Text color="subtle">{r.cols[2]}{r.cols[3] ?? ''}</Text>}
              <Text bold={m.status === 'new'}>{r.flex}</Text>
            </Box>
            <Button key={`open-${m.id}`} dimColor={m.status !== 'new'} label="Open" onPress={() => fill($, { kind: 'inbox', id: m.id })} />
          </Box>
          )
        })}
        {more(inbox.more, ACCENT.inbox)}

        {head('‖', 'PAUSED', ACCENT.paused, `${s.paused.length}`)}
        {paused.shown.length === 0 && empty('nothing paused', ACCENT.paused)}
        {paused.shown.map(p => {
          const r = fitRow(text, [[p.site ?? '', 6]], p.title, ` ${relTime(p.pausedAt, now)}`)
          return (
          <Box key={`p-${p.task}`}>
            {gutter(ACCENT.paused)}
            <Box flexGrow={1} flexShrink={1}>
              <Text color={ACCENT.paused} bold>{r.cols[0]}</Text>
              <Text>{r.flex}</Text>
              {r.tail && <Text color="subtle">{r.tail}</Text>}
            </Box>
            <Button key={`resume-${p.task}`} dimColor label="Resume" onPress={() => fill($, { kind: 'resume', task: p.task })} />
          </Box>
          )
        })}
        {more(paused.more, ACCENT.paused)}

        {head('▦', (s.sprint?.name ?? 'SPRINT').toUpperCase(), stale ? 'warning' : ACCENT.sprint, s.sprint ? `${stale ? `▲ ${stale} old · ` : ''}${sprint.shown.length + sprint.more}` : '')}
        {!s.sprint && empty(s.problems.find(p => p.startsWith('tickets')) ?? 'loading tickets…', ACCENT.sprint)}
        {s.sprint && sprint.shown.length === 0 && empty('nothing open', ACCENT.sprint)}
        {sprint.shown.map(t => {
          const r = fitRow(text, [[t.sites.join(','), 6]], t.title, ` ${cell((t.status ?? '—').toUpperCase(), 17)}`)
          return (
          <Box key={`t-${t.task}`}>
            {gutter(ACCENT.sprint)}
            <Box flexGrow={1} flexShrink={1}>
              <Text color={ACCENT.sprint} bold>{r.cols[0]}</Text>
              <Text>{r.flex}</Text>
              {r.tail && <Text color="subtle">{r.tail}</Text>}
            </Box>
            <Button key={`start-${t.task}`} dimColor label="Start" onPress={() => fill($, { kind: 'start', task: t.task })} />
          </Box>
          )
        })}
        {more(sprint.more, ACCENT.sprint)}

        {s.problems.filter(p => !p.startsWith('tickets') || s.sprint).map(p => (
          <Box key={`pr-${p}`} marginTop={1}>
            <Text backgroundColor="warning" color="inverseText" bold> ! </Text>
            <Text color="warning"> {p}</Text>
          </Box>
        ))}

        <Text color="inactive">{rule(width, 0)}</Text>
        <Box justifyContent="space-between">
          <Text color={failed ? 'warning' : 'subtle'}>{failed ? `▲ refresh failed · updated ${age} ago` : `updated ${age}`}</Text>
          <Button key="refresh" plain hotkey="r" label="↻ refresh" onPress={() => refresh($, { asana: true, refresh: true }, true)} />
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
