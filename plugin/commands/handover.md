---
description: Hand a task over to a teammate (saves your work, sends them a handover)
argument-hint: <task id> <person> [note]
---

Hand over: $ARGUMENTS

1. Work out the task id (the argument, else the task started or resumed in this conversation, else ask) and the teammate. Check the teammate's name with the `team_info` tool; ask if it is missing or not on the team. If they are not on the team, they cannot receive the handover.
2. Make the work reachable for them. Your teammate cannot see your machine, so never use a stash here. In the project repository:
   - If there are uncommitted changes: if not already on a `wip/` branch, `git switch -c wip/<task>-<yyyymmdd>`; review `git status`, stage the work files explicitly (never `.env`, secrets or credentials), then `git commit -m "wip: <task> handover"`.
   - Ask before pushing: `Push <branch> to origin so <person> can pick it up? (y / n)`. Push only on `y`. If the user says no, tell them the teammate will not see the unpushed work.
   - Note an open pull request for the branch if you can find one (for example with `gh pr view`).
3. Call the `checkpoint` tool with `task`, `done`, `pending`, `blockers`, `resume` (exact steps for the teammate to continue, written for someone who has not seen this session), `branch` and `handedTo` set to the teammate.
4. Call the `write_session` tool with `trigger: "checkpoint"`, `phase`, the session id, the task, and goal / done / decisions / deadEnds / next for this session.
5. Draft the handover message:
   - one or two lines on what the task is and where it stands;
   - what is done and what is left, with blockers;
   - the branch (and that it is pushed) and the pull request link, if any;
   - the user's note;
   - a last line: `Pick it up with /rixflow:resume <task> from <your name>`. The ticket, its epic and subtasks, your checkpoint and your session notes are in the hub; resuming loads them.
6. Follow the approval rule from the rixflow skill. On `y`, call the `send_message` tool with `type: "handover"`, `to` the teammate and the task id.
7. Report the sync status the tools returned, and remind the user to reassign the ticket to the teammate in the tracker themselves (RixFlow is read-only).

Never put passwords, tokens or credential URLs in anything written to the hub.
If the ticket is restricted, never copy its details into hub notes, checkpoints, messages, session summaries or `promote_to_shared`; the teammate reads them from the tracker with their own login.
