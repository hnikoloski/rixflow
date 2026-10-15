# Security policy

RixFlow handles ticket-system tokens and writes to a shared git repo, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through [GitHub's private vulnerability reporting](https://github.com/hnikoloski/rixflow/security/advisories/new) instead.

Include what you found, how to reproduce it and which version you run. You should get a reply within a few days.

## In scope

- A token, password or other secret that reaches the hub repo, a log or tool output without being scrubbed.
- A way for a teammate to change files they do not own in the hub (another person's folder, or a message they did not receive).
- A write to Asana or Jira. The ticket clients are meant to be read-only.
- A path that lets an MCP tool read files outside the hub.

## Supported versions

Only the latest release gets fixes. Update with `/plugin marketplace update rixflow` and restart Claude Code.
