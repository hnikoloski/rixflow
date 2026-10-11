# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` (imported above) is the canonical guide: commands, layout, hard rules, plugin text invariants, env vars and conventions. Keep shared guidance there; this file only adds the cross-file flows below.

## How the pieces fit

- **Write path (MCP tools).** `createServer` in `src/mcp/server.ts` takes injected deps (`ctx`, `asana`, `persist`) so tests can swap them. A tool handler calls into `src/core/`, which writes through `writeDoc` (always scrubbed), then calls `persistHub` (`src/core/runtime.ts`): take the hub file lock → commit only the user's owned paths → `sync` (pull --rebase, bounded push retries). Results come back as `SyncResult` statuses, never exceptions. Tool handlers are wrapped in `safe()`, which scrubs all tool output too. It reports a `HubError` as `CODE: message`; any other error becomes a generic `INTERNAL_ERROR`. Set `RIXFLOW_DEBUG=1` to log those to stderr.
- **Hook path.** `runHook` (`src/cli/hooks.ts`) is dependency-injected and never throws. `session-start` / `prompt` inject a brief from `check()` (bounded by a timeout) as `hookSpecificOutput`. `precompact` / `session-end` spawn a detached `hub summary` worker. The worker runs *without* `RIXFLOW_CHILD` so it can do its work; it sets `RIXFLOW_CHILD=1` on the `claude -p` child it launches, and that is what stops hook recursion. The CLI's hooks and `hub status` sync through a detached `hub sync --json` child (`detachedSync`), so a sync they stop waiting for still finishes under the lock instead of being cut off mid-rebase.
- **Paths read through MCP** are resolved against the realpath of the hub dir and checked to stay inside it (`assertRealInside` in `server.ts`). Keep that check on any new tool that takes a path.
