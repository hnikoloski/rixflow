---
description: Put a picked-up task back (clears it from Now, deletes its checkpoint)
argument-hint: [task id]
---

Drop the task: $ARGUMENTS

1. Work out the task: the argument, else this session's current task (the `[rixflow]` context, or the In progress list from the `plate` tool), else ask.
2. Show its title (the `plate` tool lists it; the `task_details` tool has more). If it has a checkpoint, say the checkpoint will be deleted.
3. Ask: `Drop "<title>"? (y / n)`. Only on `y` call the `drop_task` tool with `task`. On anything else, stop and change nothing.
4. Report what the tool returned (checkpoint removed, handover ended, sync status).
5. Say the ticket keeps its status in the tracker (RixFlow is read-only), so a ticket marked in progress there still shows under In progress until the user changes it.
