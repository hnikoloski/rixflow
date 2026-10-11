import type { AsanaComment, AsanaReader, AsanaTask } from '../../src/core/asana';

export function task(overrides: Partial<AsanaTask> & { gid: string }): AsanaTask {
  return {
    name: `Task ${overrides.gid}`,
    modified_at: '2026-10-07T00:00:00.000Z',
    memberships: [],
    custom_fields: [],
    parent: null,
    ...overrides,
  };
}

export const field = (name: string, display_value: string | null) => ({ name, display_value });

export function fakeAsana(
  tasks: AsanaTask[],
  comments: Record<string, AsanaComment[]> = {},
  myTasks: string[] = tasks.map((t) => t.gid),
): AsanaReader & { calls: string[] } {
  const byGid = new Map(tasks.map((t) => [t.gid, t]));
  const calls: string[] = [];
  return {
    calls,
    async getMyTasks() {
      calls.push('getMyTasks');
      return myTasks.map((g) => byGid.get(g)!);
    },
    async getTask(gid) {
      calls.push(`getTask:${gid}`);
      const t = byGid.get(gid);
      if (!t) throw new Error(`no task ${gid}`);
      return t;
    },
    async getComments(gid, limit = 10) {
      calls.push(`getComments:${gid}`);
      return (comments[gid] ?? []).slice(-limit);
    },
  };
}
