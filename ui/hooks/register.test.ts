import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const status = (o: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, at: '2026-10-10T18:00:00.000Z', user: 'hristijan', initialized: true,
  sync: { status: 'ok', pending: 0, detail: '' }, current: null,
  inbox: [{ id: '2026-10-10-8qsc', from: 'pm', type: 'request', task: '111', preview: 'Consent v2 by Wed', status: 'new', created: '2026-10-10T17:58:00.000Z' }],
  paused: [], sprint: null, problems: [], ...o,
})

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const FILE = { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
const START = { cwd: '/w', surface: 'terminal' as const, isInteractive: true }

// What a session answers beneath the mod; each test adds the calls it checks
// (ui.status included: one event takes one hook of the test's).
const world = (on: On, env: Record<string, string> = {}) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-10T18:00:00.000Z') })
  mock.store(on)
  mock.env(on, { HOME: '/home/u', ...env })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  return clock
}

test('session start draws the status line from hub status', async ($, on) => {
  const clock = world(on)
  const lines: Array<string | undefined> = []
  const argvs: string[][] = []
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    return ran(status())
  })
  on('ui.status', async (_$, e) => { lines.push(e.text); return { value: undefined } })
  on('fs.stat', async () => FILE)
  await $.session.start(START)
  await clock.settle() // the startup polls run unawaited
  expect(argvs[0]).toContain('status')
  expect(lines.at(-1)).toBe('✉ 1 new │ ✓ synced')
})

test('a missing CLI shows setup needed and runs nothing', async ($, on) => {
  const clock = world(on)
  const lines: Array<string | undefined> = []
  let calls = 0
  on('process.run', async () => { calls++; return ran('') })
  on('fs.stat', async () => ({ deny: 'ENOENT' }))
  on('ui.status', async (_$, e) => { lines.push(e.text); return { value: undefined } })
  await $.session.start(START)
  await clock.settle()
  expect(calls).toBe(0)
  expect(lines.at(-1)).toBe('setup needed')
})

test('invalid output keeps the last good view', async ($, on) => {
  world(on)
  const lines: Array<string | undefined> = []
  let call = 0
  on('process.run', async () => ran(call++ === 0 ? status() : '{"v":'))
  on('fs.stat', async () => FILE)
  on('ui.status', async (_$, e) => { lines.push(e.text); return { value: undefined } })
  await $.session.start(START)
  await $.command.run({ command: 'rixflow-ui', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(lines.at(-1)).toBe('✉ 1 new │ ✓ synced')
})

test('a button never fills over a draft', async ($, on) => {
  const clock = world(on)
  const fills: string[] = []
  const toasts: string[] = []
  on('process.run', async () => ran(status()))
  on('fs.stat', async () => FILE)
  on('prompt.read', async () => ({ value: { text: 'half a thought', cursor: 14 } }))
  on('prompt.fill', async (_$, e) => { fills.push(e.text); return { isFilled: true } })
  on('ui.toast', async (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.status', async () => ({ value: undefined }))
  await $.session.start(START)
  await clock.settle()
  const band = await $.ui.mount({ plugin: 'rixflow-ui', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } })
  await band.press({ key: 'band-open' })
  expect(fills).toEqual([])
  expect(toasts).toEqual(['Prompt box not empty'])
})

test('start_task sets the current task passed as --task', async ($, on) => {
  const clock = world(on)
  const argvs: string[][] = []
  on('process.run', async (_$, e) => { argvs.push([...e.argv]); return ran(status()) })
  on('fs.stat', async () => FILE)
  on('ui.status', async () => ({ value: undefined }))
  on('tool.call', { tool: 'mcp__plugin_rixflow_hub__start_task' }, async () => ({ result: { content: [] } }))
  await $.session.start(START)
  await clock.settle() // session start's own polls are done
  const before = argvs.length
  await $.tool.call({ tool: 'mcp__plugin_rixflow_hub__start_task', task: '1219374889411287', cwd: '/w' })
  await clock.settle() // the refresh the tool call started runs unawaited
  expect(argvs.length).toBe(before + 1)
  expect(argvs.at(-1)).toEqual(expect.arrayContaining(['--task', '1219374889411287']))
  expect(argvs.at(-1)).toContain('--asana')
})

test('a tool call during a running poll queues its refresh instead of dropping it', async ($, on) => {
  const clock = world(on)
  const argvs: string[][] = []
  let hold: Promise<void> | null = null
  let release!: () => void
  on('process.run', async (_$, e) => { argvs.push([...e.argv]); if (hold) await hold; return ran(status()) })
  on('fs.stat', async () => FILE)
  on('ui.status', async () => ({ value: undefined }))
  on('tool.call', { tool: 'mcp__plugin_rixflow_hub__start_task' }, async () => ({ result: { content: [] } }))
  await $.session.start(START)
  await clock.settle() // startup polls done
  hold = new Promise<void>(r => (release = r))
  const refreshed = $.command.run({ command: 'rixflow-ui', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await clock.settle() // the --refresh run is now blocked in process.run
  const before = argvs.length
  await $.tool.call({ tool: 'mcp__plugin_rixflow_hub__start_task', task: '1219374889411287', cwd: '/w' })
  hold = null
  release()
  await refreshed
  await clock.settle()
  expect(argvs).toHaveLength(before + 1) // the queued post-tool run
  expect(argvs.at(-2)).toContain('--refresh')
  expect(argvs.at(-1)).toEqual(expect.arrayContaining(['--task', '1219374889411287', '--asana']))
  expect(argvs.at(-1)).not.toContain('--refresh')
})

test('/rixflow-ui refresh waits for a queued refresh before answering', async ($, on) => {
  world(on)
  const argvs: string[][] = []
  on('process.run', async (_$, e) => { argvs.push([...e.argv]); return ran(status()) })
  on('fs.stat', async () => FILE)
  on('ui.status', async () => ({ value: undefined }))
  await $.session.start(START) // its --asana poll is still running, unawaited
  const out = await $.command.run({ command: 'rixflow-ui', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(out.text).toBe('RixFlow refreshed.')
  expect(argvs.at(-1)).toEqual(expect.arrayContaining(['--asana', '--refresh']))
})

test('the pane draws every section and its buttons fill an empty box', async ($, on) => {
  world(on)
  const fills: string[] = []
  const full = status({
    current: { task: '1', title: 'Fix banner overlap', sites: ['AC'], status: 'TODO', due: 'Wed 14', startedAt: '2026-10-10T17:00:00.000Z', source: 'session' },
    paused: [{ task: '2', title: 'Consent mode v2', site: 'GL', pausedAt: '2026-10-09T17:00:00.000Z' }],
    sprint: { name: 'SPRINT 1', fetchedAt: '2026-10-10T17:59:00.000Z', items: [{ task: '3', title: 'Hero section', sites: ['AC'], status: null, due: null, paused: false }] },
    problems: ['hub: 1 file not synced'],
  })
  on('process.run', async () => ran(full))
  on('fs.stat', async () => FILE)
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', async (_$, e) => { fills.push(e.text); return { isFilled: true } })
  await $.session.start(START)
  const pane = await $.ui.mount({
    plugin: 'rixflow-ui', surface: 'terminal', component: 'Pane', requestId: 'rixflow',
    props: { title: 'RixFlow', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    viewport: { columns: 60, rows: 40 },
  })
  expect(await pane.find({ type: 'Text', text: /Fix banner overlap/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: ' ✉ INBOX ' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '1 NEW / 1' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '● SYNCED' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /hub: 1 file not synced/ })).toBeDefined()
  await pane.press({ key: 'open-2026-10-10-8qsc' })
  await pane.press({ key: 'resume-2' })
  await pane.press({ key: 'start-3' })
  await pane.press({ key: 'wrapup' })
  expect(fills).toEqual(['/rixflow:inbox 2026-10-10-8qsc', '/rixflow:resume 2', '/rixflow:start 3', '/rixflow:wrapup'])
})

test('a non-interactive, non-terminal or RixFlow child session runs nothing', async ($, on) => {
  const clock = world(on, { RIXFLOW_CHILD: '1' })
  let calls = 0
  const lines: Array<string | undefined> = []
  on('process.run', async () => { calls++; return ran(status()) })
  on('fs.stat', async () => FILE)
  on('ui.status', async (_$, e) => { lines.push(e.text); return { value: undefined } })
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(calls).toBe(0)
  expect(lines).toEqual([])
})

test('a -p run (not interactive) runs no status process', async ($, on) => {
  const clock = world(on)
  let calls = 0
  on('process.run', async () => { calls++; return ran(status()) })
  on('fs.stat', async () => FILE)
  on('ui.status', async () => ({ value: undefined }))
  await $.session.start({ cwd: '/w', surface: null, isInteractive: false })
  await clock.settle()
  expect(calls).toBe(0)
})

test('session start does not wait for the first status run', async ($, on) => {
  const clock = world(on)
  const lines: Array<string | undefined> = []
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  on('process.run', async () => { await gate; return ran(status()) })
  on('fs.stat', async () => FILE)
  on('ui.status', async (_$, e) => { lines.push(e.text); return { value: undefined } })
  await $.session.start(START)
  expect(lines).toEqual([])
  release()
  await clock.settle()
  expect(lines.at(-1)).toBe('✉ 1 new │ ✓ synced')
})

test('an old core without status (exit 1, no output) asks for an update', async ($, on) => {
  const clock = world(on)
  const lines: Array<string | undefined> = []
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: "error: unknown command 'status'", isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.stat', async () => FILE)
  on('ui.status', async (_$, e) => { lines.push(e.text); return { value: undefined } })
  await $.session.start(START)
  await clock.settle()
  expect(lines.at(-1)).toBe('⚠ update rixflow / rixflow-ui')
})

test('/rixflow-ui refresh reports a failed status fetch', async ($, on) => {
  const clock = world(on)
  let call = 0
  on('process.run', async () => ran(call++ < 2 ? status() : '{"v":'))
  on('fs.stat', async () => FILE)
  on('ui.status', async () => ({ value: undefined }))
  await $.session.start(START)
  await clock.settle()
  const out = await $.command.run({ command: 'rixflow-ui', args: 'refresh', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(out.text).toBe('RixFlow refresh failed.')
})

test('the pane footer shows no sync part when the hub was locked', async ($, on) => {
  const clock = world(on)
  on('process.run', async () => ran(status({ sync: { status: 'locked', pending: 0, detail: '' } })))
  on('fs.stat', async () => FILE)
  on('ui.status', async () => ({ value: undefined }))
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({
    plugin: 'rixflow-ui', surface: 'terminal', component: 'Pane', requestId: 'rixflow',
    props: { title: 'RixFlow', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    viewport: { columns: 60, rows: 40 },
  })
  expect(await pane.find({ type: 'Text', text: /^updated now/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /SYNCED/ })).toBeUndefined()
})

test('the band shows a new message with Open and Later', async ($, on) => {
  const clock = world(on)
  const fills: string[] = []
  on('process.run', async () => ran(status()))
  on('fs.stat', async () => FILE)
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', async (_$, e) => { fills.push(e.text); return { isFilled: true } })
  await $.session.start(START)
  await clock.settle()
  const band = await $.ui.mount({
    plugin: 'rixflow-ui', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
    viewport: { columns: 100, rows: 40 },
  })
  expect(await band.find({ type: 'Text', text: ' ✉ NEW ' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: / request · Consent v2 by Wed/ })).toBeDefined()
  await band.press({ key: 'band-open' })
  expect(fills).toEqual(['/rixflow:inbox 2026-10-10-8qsc'])
})

test('the pane marks a sprint cached long ago as stale', async ($, on) => {
  const clock = world(on)
  on('process.run', async () => ran(status({ sprint: { name: 'Sprint 1', fetchedAt: '2026-10-10T10:00:00.000Z', items: [] } })))
  on('fs.stat', async () => FILE)
  on('ui.status', async () => ({ value: undefined }))
  await $.session.start(START)
  await clock.settle()
  const pane = await $.ui.mount({
    plugin: 'rixflow-ui', surface: 'terminal', component: 'Pane', requestId: 'rixflow',
    props: { title: 'RixFlow', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    viewport: { columns: 60, rows: 40 },
  })
  expect(await pane.find({ type: 'Text', text: '⚠ 8h old · 0' })).toBeDefined()
})
