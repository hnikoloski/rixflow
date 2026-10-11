# RixFlow

Async team workflow for [Claude Code](https://claude.com/claude-code). Each teammate's Claude shares one git **hub** repo with the rest of the team, so work moves between people without meetings:

- **Plate:** your Asana tasks, inbox and paused work in one list.
- **Handovers:** start a task with a brief, pause it with a checkpoint, and pick it up later (or let someone else).
- **Inbox:** send requests and questions to a teammate's Claude; it sees them at its next session.
- **Shared knowledge:** searchable notes per site, promoted from sessions.
- **RixFlow UI:** a status line, a band above the prompt and a `RixFlow` pane that show all of the above live.

Asana is **read-only by design**, and every string written to the hub passes through a secret scrubber first.

## Table of contents

- [How it works](#how-it-works)
- [Installation](#installation)
- [First-time setup](#first-time-setup)
- [Usage](#usage)
- [Updating](#updating)
- [Development](#development)
- [License](#license)

## How it works

```
 you + Claude ──┐                         ┌── teammate + Claude
                │   hub (a git repo)      │
   rixflow ─────┼──► people/<you>/  ◄─────┼───── rixflow
   (commands,   │    inbox/<them>/        │
    MCP, hooks) │    shared/sites/…       │
                └─────────────────────────┘
        Asana (read-only) ──► plate, briefs, sprint
```

- Everything is plain Markdown in a git repo that your team owns. RixFlow commits and syncs it for you (pull --rebase with bounded push retries).
- Each person writes only to their own folder. They may drop new messages into someone else's inbox but never edit them. A pre-commit check in the hub enforces this.
- Hooks brief Claude at session start ("2 new requests from pm…") and write a short session summary when a session ends.

## Installation

Two plugins ship from this repository:

| Plugin | What it is |
| --- | --- |
| `rixflow` | The core: slash commands, a stdio MCP server and session hooks. |
| `rixflow-ui` | The live UI (status line, band, pane). It makes no model calls, so it costs no tokens. Installing it also installs `rixflow`. |

### Claude Code

Register the marketplace, then install:

```
/plugin marketplace add hnikoloski/rixflow
/plugin install rixflow-ui@rixflow
```

To get the core without the UI:

```
/plugin install rixflow@rixflow
```

Then run [first-time setup](#first-time-setup).

### From a local clone

```sh
git clone https://github.com/hnikoloski/rixflow.git && cd rixflow
claude plugin marketplace add ./
claude plugin install rixflow-ui@rixflow
```

### OpenCode and other MCP clients

The plugin format is Claude Code's own, but the core is a plain CLI plus a stdio MCP server. Wire the server into `opencode.json`:

```json
{ "mcp": { "hub": { "type": "local", "command": ["node", "plugin/dist/mcp.cjs"] } } }
```

Set `RIXFLOW_DIR` (the hub clone) and `RIXFLOW_CONFIG_DIR` (this machine's config) yourself. See [`AGENTS.md`](AGENTS.md#running-outside-claude-code-opencode).

## First-time setup

### Join an existing team hub

In Claude Code, run:

```
/rixflow:setup
```

It prints the exact `init` command for your machine. Run that command **in your own terminal**: it asks questions and reads your Asana personal access token as hidden input. `init` clones the hub, asks for your name and projects folder, stores the token (system keychain, or a `0600` file) and installs the hub's pre-commit check. The hub URL must work without a password prompt (ssh-agent for ssh, a credential helper for https).

### Create a hub for a new team

Do this once per team, then push the result to a private git remote:

```sh
node plugin/dist/hub.cjs bootstrap ./my-team-hub --members alice:dev,bob:pm --sites AC:acme,GL:globex-web
git -C ./my-team-hub remote add origin <private-git-url>
git -C ./my-team-hub push -u origin main
```

`--sites` maps short site codes to project folder names, so a task tagged `AC` opens in `~/projects/acme`.

## Usage

| Command | What it does |
| --- | --- |
| `/rixflow:plate` | Everything on your plate: Asana tasks, inbox, paused work |
| `/rixflow:start <task id or plate number>` | Start an Asana task with a handover brief |
| `/rixflow:checkpoint [task id]` | Pause the current task and save where you left off |
| `/rixflow:resume <task id>` | Resume a task from its handover and checkpoint |
| `/rixflow:wrapup [task id]` | Finish the task and capture what the team should know |
| `/rixflow:inbox [message id]` | Show your inbox, or open one message |
| `/rixflow:send <person> <task id> [note]` | Send a teammate's Claude a request about a task |
| `/rixflow:ask [person] <question>` | Search the hub first, then ask a teammate |
| `/rixflow:setup` | Show how to set up this machine |
| `/rixflow-ui [refresh]` | Toggle the RixFlow pane, or refresh it now |

The UI runs only in interactive terminal sessions. With the pane focused, `c` checkpoints, `w` wraps up and `r` refreshes.

## Updating

```
/plugin marketplace update rixflow
/plugin update rixflow-ui@rixflow
```

`/plugin update` only picks up a new **version**. If you're working from a local clone without bumping the version, reinstall instead.

## Development

Requires **Node 20+** and **git** on PATH (the tests build real temporary repos).

```sh
git clone https://github.com/hnikoloski/rixflow.git && cd rixflow
npm install
npm run check        # typecheck + tests + build, and fails if plugin/dist is stale
```

| Command | Purpose |
| --- | --- |
| `npm test` | All tests (Vitest) |
| `npx vitest run tests/core/scrub.test.ts` | One test file |
| `npm run typecheck` | Strict `tsc` |
| `npm run build` | Bundle `src/` into `plugin/dist/*.cjs`. The bundles are committed and are what runs, so rebuild after any `src/` change. |
| `claude --plugin-dir ui` | Run the UI mod straight from this checkout |
| `claude plugin validate ui && claude plugin test ui` | Validate the mod and run its kit tests |

[`AGENTS.md`](AGENTS.md) is the contributor guide. It covers the layout, the rules the code enforces (read-only Asana, scrubbing, hooks that never fail a session) and conventions.

## License

[MIT](LICENSE). The bundles in `plugin/dist/` include third-party packages under their own licenses (MIT and ISC): `@modelcontextprotocol/sdk`, `commander`, `yaml` and `zod`.
