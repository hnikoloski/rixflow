---
description: Send a teammate's Claude a request about a ticket
argument-hint: <person> <task id> [note]
---

The user wants to send a request: $ARGUMENTS

1. Call the `task_details` tool for the task and read it.
2. If something needed to start is unclear or missing (acceptance criteria, links, project, deadline), ask the user up to three short questions, one at a time.
3. Draft the request: what is needed, why, constraints, links (never credentials), and the user's note.
4. Follow the approval rule from the rixflow skill. On `y`, call the `send_message` tool with `type: "request"` and the task id.
