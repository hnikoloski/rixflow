---
description: Finish the current task and capture what the team should know
argument-hint: [task id]
---

Wrap up the current task: $ARGUMENTS

1. Work out the task id: the argument, else the task started or resumed in this conversation, else ask.
2. If work remains outside the code (CMS edits, content, admin settings), write it as a numbered checklist for `next`.
3. Call the `write_session` tool with `trigger: "wrapup"`, `phase: "done"`, the session id and the task.
4. Pick out decisions from this session that would help teammates later (strategic, reusable, or explaining why something is the way it is). For each, draft a short note (a `# Title` line and 3–10 lines) and follow the approval rule from the rixflow skill. On `y`, call the `promote_to_shared` tool with path `shared/decisions/<kebab-title>.md`, or `shared/sites/<site>/<kebab-title>.md` for site-specific notes, plus `content` (the note text), `site` and `type: "decision"`.
5. Call the `finish_task` tool.
6. Remind the user to update the task status in Asana themselves; RixFlow never writes to Asana.

Never put passwords, tokens or credential URLs in anything written to the hub.
If the ticket is restricted, never copy its details into hub notes, checkpoints, messages, session summaries or `promote_to_shared`.
