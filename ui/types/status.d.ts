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
  paused: Array<{ task: string; title: string; site: string | null; pausedAt: string | null }>
  sprint: { name: string | null; fetchedAt: string; items: StatusTask[] } | null
  problems: string[]
}

export type View = {
  status: Status | null
  error: 'invalid' | 'version' | 'failed' | 'setup' | null
  updatedAt: number
}
