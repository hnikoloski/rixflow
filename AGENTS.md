# AGENTS.md — RixFlow

Claude Code plugin for async team workflow (plate, handovers, inbox, shared knowledge). TypeScript core in `src/` is bundled with esbuild into the plugin in `plugin/`. Marketplace entries: `.claude-plugin/marketplace.json` → `./plugin` (`rixflow`) and `./ui` (`rixflow-ui`). The plugin itself is Claude Code-specific, but the core is a plain CLI + stdio MCP server — develop and run it from OpenCode as described below.

## Commands

- `npm run check` — the full gate in one command: typecheck, tests, build, and a failure if the committed `plugin/dist` bundles differ from a fresh build. Run it before every commit.
- `npm test` — all tests. Requires `git` on PATH: tests build real temp repos and bare remotes (`tests/gitHub.ts`).
- Single file: `npx vitest run tests/core/scrub.test.ts`
- `npm run typecheck` — `tsc --noEmit` (strict). No linter and no CI exist; typecheck + tests are the only gates.
- `npm run build` — **required after any `src/` change**: bundles `src/cli/main.ts` → `plugin/dist/hub.cjs` and `src/mcp/main.ts` → `plugin/dist/mcp.cjs`. `plugin/dist/*.cjs` is committed and is what actually runs (see `plugin/hooks/hooks.json`, `plugin/.mcp.json`). Source is ESM; bundles are CJS for node20.
- Mod under development: `claude --plugin-dir ui` (or hot reload via the plugin-authoring skill). `hub status --json [--cwd] [--task] [--asana] [--refresh] [--no-sync]` is the mod's only data source; bump `STATUS_VERSION` in both `src/core/status.ts` and `ui/hooks/model.ts` on a breaking change.
- Teammate install: `/plugin install rixflow-ui@rixflow` installs the UI and, through its `dependencies`, the `rixflow` core from the same marketplace. Core only: `/plugin install rixflow@rixflow`.
- On fresh `npm install`, npm may report esbuild's postinstall script as blocked. Builds still work (the binary ships as an optional dependency); approve with `npm install-scripts approve esbuild` only if the CLI is missing.

## Layout

- `src/core/` — deterministic hub core: git sync (pull --rebase + bounded push retries), messages, notes/checkpoints, search, scrub, file lock, read-only Asana client.
- `src/cli/` — `hub` CLI (commander). `hook <event>` is called by Claude Code hooks; `verify-commit` is the hub repo's pre-commit gate; `summary` runs as a detached worker.
- `src/mcp/` — stdio MCP server; tools are registered in `src/mcp/server.ts`.
- `plugin/` — the shipped plugin: `commands/`, `skills/rixflow/SKILL.md`, `hooks/hooks.json`, `.mcp.json`, `dist/`.
- `ui/` — `rixflow-ui`, a Claude Code mod (function hooks, `ui/hooks/register.tsx`). Pure view: it runs `node <configDir>/hub.cjs status --json` and draws a status line, a band above the prompt and the `RixFlow` pane. It is active only in interactive terminal sessions without `RIXFLOW_CHILD=1`. The pane's sprint list includes urgent and in-progress tasks by design (all of `hub status`'s `sprint.items`, minus paused and current). Logic lives in `ui/hooks/model.ts` (`refreshGate` queues one event-driven refresh and skips timer ticks while busy; Vitest: `tests/ui/`). `npm run typecheck` covers `ui/hooks/model.ts` only (root `tsconfig.json`); `register.tsx` is checked by `claude plugin validate ui`, tested with `claude plugin test ui`, and type-checked with `npx tsc -p ui` (its `tsconfig.json` extends the types the engine lays in the git-ignored `ui/.claude-plugin/types/` once it has loaded the mod, e.g. via `claude --plugin-dir ui`).

## Running outside Claude Code (OpenCode)

- OpenCode does not load the plugin (`hooks.json`, `.mcp.json`, marketplace manifest are Claude Code formats). Drive the same core directly: CLI `node plugin/dist/hub.cjs <cmd>` (e.g. `sync`, `scrub`, `hook <event>`), or the stdio MCP server `node plugin/dist/mcp.cjs` — wire that into `opencode.json`: `"mcp": { "hub": { "type": "local", "command": ["node", "plugin/dist/mcp.cjs"] } }`.
- Nothing is auto-configured: set `RIXFLOW_DIR` and `RIXFLOW_CONFIG_DIR` per invocation. Without a `config.yml`, ordinary commands fail with `NOT_INITIALIZED` while hook events silently no-op. `CLAUDE_PLUGIN_ROOT` is only set by Claude Code (it feeds user-facing hints).
- Manual hook test: `echo '{"session_id":"s1","transcript_path":"t.jsonl"}' | RIXFLOW_DIR=<hub> RIXFLOW_CONFIG_DIR=<cfg> node plugin/dist/hub.cjs hook <event>` for events `session-start` / `prompt` / `precompact` / `session-end`. Output is Claude Code hook JSON (`hookSpecificOutput`); empty output is a valid result.

## Hard rules (load-bearing, enforced in code)

- **Ticket clients are read-only by construction**: `AsanaClient` (`src/core/asana.ts`) and `JiraClient` (`src/core/tickets/jira.ts`) each hardcode `method: 'GET'` in a single private request path. Never add write methods or a method that takes a verb.
- **Every string written to the hub passes through `scrub()`** (`src/core/hubfs.ts` `writeDoc`). Keep it that way; `[redacted]` output must stay a fixed point of `findSecrets` (see comment in `src/core/scrub.ts`).
- **Hooks must always exit 0 and print nothing on failure.** A `hub hook` invocation is a complete no-op when `RIXFLOW_CHILD=1`.
- `persistHub` (`src/core/runtime.ts`) never throws — failures come back as `SyncResult` statuses. A `locked` result must not be retried by writing the file again (the write already happened).
- Hub write ownership (enforced by the hub repo's pre-commit `verify-commit`, which fails closed): a user writes only inside `people/<self>/`, may create but never modify files in `inbox/<other>/`, and only the recipient changes a message's `status`.
- ID formats (`src/core/types.ts`): person `^[a-z0-9][a-z0-9-]{0,39}$`, Asana gid `^\d{1,30}$`, message id `^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$`, site code `^[A-Z0-9]{1,10}$`.

## Plugin text invariants (`tests/plugin.test.ts` enforces these)

- Slash-command and skill text may only reference tool names that exist in `src/mcp/server.ts`.
- Plugin text must never mention the hub path (`~/.rixflow`) or bare `hub init` / `hub token` commands. The CLI is not on PATH; user-facing setup hints must point at the `setup_info` / `team_info` tools, which print the real `node <plugin>/dist/hub.cjs …` command.
- `hooks.json` may only invoke hook events handled by `src/cli/hooks.ts`, and must wire all four hooks (SessionStart with matcher, UserPromptSubmit, PreCompact, SessionEnd).

## Env & paths

- `RIXFLOW_DIR` — hub repo location (default `~/.rixflow`, a git repo, never inside a project folder).
- `RIXFLOW_CONFIG_DIR` — per-machine config (default `~/.config/rixflow`; holds `config.yml`, Asana token, pre-commit copy of `hub.cjs`).
- `RIXFLOW_CHILD=1` — set on hook-spawned child processes; `CLAUDE_PLUGIN_ROOT` — set by Claude Code at runtime.

## Conventions

- `docs/`, `.superpowers/` and `brief.pdf` are local-only design/plan history: git-ignored, never committed, and not to be modified.
- Commit messages: conventional commits (`feat:` / `fix:` / `test:` / `chore:`), ending with the line `Co-Authored-By: <implementing model name> <noreply@anthropic.com>`.
- No formatter config; match surrounding style (single quotes, semicolons, 2-space indent).
