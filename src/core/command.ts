import { basename, dirname, join, resolve } from 'node:path';

// The `hub` CLI is not on PATH: it ships inside the plugin as dist/hub.cjs. Every hint shown to
// the user therefore names the real file: the running hub.cjs, or the hub.cjs next to the running
// mcp.cjs (the MCP server and the CLI are bundled side by side).
export function hubCliPath(argv1: string | undefined = process.argv[1]): string | null {
  for (const candidate of [argv1, typeof __filename === 'string' ? __filename : undefined]) {
    if (!candidate) continue;
    const abs = resolve(candidate);
    const name = basename(abs);
    if (name === 'hub.cjs') return abs;
    if (name === 'mcp.cjs') return join(dirname(abs), 'hub.cjs');
  }
  return null;
}

// Double-quoted for a POSIX shell: \, ", $ and ` are escaped.
const quote = (p: string): string => `"${p.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;

export function hubCommand(
  sub: string,
  argv1: string | undefined = process.argv[1],
  env: Record<string, string | undefined> = process.env,
): string {
  const path = hubCliPath(argv1)
    ?? (env.CLAUDE_PLUGIN_ROOT ? join(env.CLAUDE_PLUGIN_ROOT, 'dist', 'hub.cjs') : '<RixFlow plugin folder>/dist/hub.cjs');
  return `node ${quote(path)} ${sub}`;
}
