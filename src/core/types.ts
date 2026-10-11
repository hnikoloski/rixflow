export type Role = 'dev' | 'pm';

export interface UserConfig {
  name: string;
  role: Role;
  projectsRoot: string;
  asanaWorkspace?: string;
  siteFolders: Record<string, string>;
  taskSites: Record<string, string>;
}

export interface Ctx {
  hubDir: string;
  configDir: string;
  user: UserConfig;
  now: () => Date;
}

export interface CheckState {
  lastPromptCheck?: string;
  seenTaskModified: Record<string, string>;
  notified: string[];
  // Time (ISO) of the last summarizer failure already shown in a session brief.
  summaryFailureReported?: string;
  // Calendar day (YYYY-MM-DD, UTC) of the last "offline, 0 pending" / "no remote" notice.
  offlineNoticeDay?: string;
  noRemoteNoticeDay?: string;
}

export class HubError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HubError';
  }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const GID = /^\d{1,30}$/;
const MESSAGE_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/;
const SITE = /^[A-Z0-9]{1,10}$/;

export function assertName(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !NAME.test(v)) throw new HubError('BAD_NAME', `invalid person name: ${String(v)}`);
}
export function assertGid(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !GID.test(v)) throw new HubError('BAD_GID', `invalid Asana task id: ${String(v)}`);
}
export function assertMessageId(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !MESSAGE_ID.test(v)) throw new HubError('BAD_ID', `invalid message id: ${String(v)}`);
}
export function assertSiteCode(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !SITE.test(v)) throw new HubError('BAD_SITE', `invalid site code: ${String(v)}`);
}
