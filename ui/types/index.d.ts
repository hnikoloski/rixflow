// The mod's contract, named in plugin.json "types". It must be self-contained (no import or
// export … from: `claude plugin validate` refuses one), so the plain types below repeat
// ./status.d.ts, which the root tsc and Vitest load for model.ts. Keep the two in step;
// register.tsx hands model.ts's Status to this file's View, so tsc catches a drift.

export type SyncState = 'ok' | 'offline' | 'rejected' | 'blocked' | 'locked' | 'skipped'

export type StatusTask = { task: string; title: string; sites: string[]; status: string | null; due: string | null; paused: boolean }

export type InboxItem = {
  id: string; from: string; type: 'request' | 'question' | 'answer'; task: string | null
  preview: string; status: 'new' | 'read' | 'done'; created: string
}

export type Status = {
  v: number
  at: string
  user: string | null
  initialized: boolean
  sync: { status: SyncState; pending: number; detail: string }
  current: {
    task: string; title: string; sites: string[]; status: string | null; due: string | null
    startedAt: string | null; source: 'session' | 'cwd'
  } | null
  inbox: InboxItem[]
  paused: Array<{ task: string; title: string; site: string | null; pausedAt: string | null; handedTo?: string | null }>
  sprint: { name: string | null; fetchedAt: string; items: StatusTask[] } | null
  problems: string[]
}

export type View = {
  status: Status | null
  error: 'invalid' | 'version' | 'failed' | 'setup' | null
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'rixflow-ui': { view: View; currentTask: string | null }
  }
}
