---
description: Pause the current task and save where you left off
argument-hint: [task id]
---

Pause the current task: $ARGUMENTS

1. Work out the task id: the argument, else the task started or resumed in this conversation, else ask.
2. In the project repository, if there are uncommitted changes ask: "WIP branch (default) or stash?".
   - Branch: if not already on a `wip/` branch, `git switch -c wip/<task>-<yyyymmdd>`; then review `git status`, stage the work files explicitly (never `.env`, secrets or credentials), then `git commit -m "wip: <task> checkpoint"`.
   - Stash: `git stash push -u -m "rixflow <task>"`, then get its SHA with `git rev-parse stash@{0}` right away (stash indexes shift). Pass `stashRef` as `<sha> rixflow <task>` (the SHA, a space, then the stash message).
3. Call the `checkpoint` tool with `task`, `done`, `pending`, `blockers`, `resume` (exact steps to continue) and `branch` or `stashRef`.
4. Call the `write_session` tool with `trigger: "checkpoint"`, `phase` (one of research, plan, implement, debug, done), the session id, the task, and goal / done / decisions / deadEnds / next for this session.
5. Report the sync status the tools returned.

Never put passwords, tokens or credential URLs in anything written to the hub.
If the ticket is restricted, never copy its details into hub notes, checkpoints, messages, session summaries or `promote_to_shared`.
