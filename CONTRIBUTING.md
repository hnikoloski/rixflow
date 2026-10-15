# Contributing to RixFlow

Thanks for helping out. Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and asking for features

Open an [issue](https://github.com/hnikoloski/rixflow/issues/new/choose) and pick the template that fits. For a bug, say which version you run (`/plugin` shows it), your ticket system (Asana or Jira) and what you expected to happen.

Never paste tokens, passwords, hub contents or real ticket text into an issue. Replace them with made-up values. Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Getting started

Requires **Node 20+** and **git** on PATH (the tests build real temporary repos and bare remotes).

```sh
git clone https://github.com/hnikoloski/rixflow.git && cd rixflow
npm install
npm run check
```

`npm run check` is the full gate: typecheck, tests, build, and a failure if the committed `plugin/dist` bundles differ from a fresh build. Run it before every commit. There is no CI, so this is what keeps `main` working.

To try your changes in Claude Code, run `claude --plugin-dir plugin` (core) or `claude --plugin-dir ui` (the UI mod).

[`AGENTS.md`](AGENTS.md) is the full contributor guide: layout, commands, the rules the code enforces and conventions. The short version is below.

## Rules that matter

- **Rebuild after any `src/` change.** `npm run build` bundles `src/` into `plugin/dist/*.cjs`. The bundles are committed and are what actually runs, so commit them together with your source change.
- **Ticket clients stay read-only.** The Asana and Jira clients hardcode `GET` in a single request path. Never add a write method or a method that takes an HTTP verb.
- **Everything written to the hub goes through `scrub()`.** Keep it that way for any new write path.
- **Hooks never fail a session.** A hook always exits 0 and prints nothing on failure.
- **Plugin text is tested.** Slash commands and the skill may only mention MCP tools that exist in `src/mcp/server.ts`; `tests/plugin.test.ts` checks this.

## Pull requests

- Keep each pull request to one change, with a test that fails without it.
- Use [conventional commit](https://www.conventionalcommits.org/) messages: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- Match the surrounding style: single quotes, semicolons, 2-space indent. There is no formatter config.
- Use made-up data in tests and examples: `acme`, `globex`, `example.com`, `alice`, `bob`. Never real company names, hosts, ticket text or credentials.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
