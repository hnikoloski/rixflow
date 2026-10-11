import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { refreshHookCopy } from '../core/hookcopy';
import { hubCliPath } from '../core/command';
import { configDir, loadCtx } from '../core/config';
import { makeSource, persist } from '../core/runtime';
import { createServer } from './server';

// Once per start, best effort: keep the pre-commit copy of the CLI in step with the hub.cjs next to this bundle.
refreshHookCopy(configDir(), hubCliPath());

// stdout carries only MCP protocol messages; everything else goes to stderr.
const server = createServer({ ctx: () => loadCtx(), source: (ctx) => makeSource(ctx), persist });
server.connect(new StdioServerTransport()).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
