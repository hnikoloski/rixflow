---
description: Show how to set up RixFlow on this machine (prints the exact terminal commands)
---

Help the user set up RixFlow. Never run the commands yourself: `init` asks questions and reads the ticket-system token as hidden input, so it needs the user's own terminal.

1. Call the `setup_info` tool.
2. If `configured` is true: call the `team_info` tool and tell the user they are set up as `me`, listing the team members and project codes. If they asked about the token, show the `tokenSet` command.
3. If `configured` is false: tell the user to open a terminal and run the `init` command exactly as returned, in a fenced block. Explain that init opens a guided setup with two paths: join a team (it clones the team's hub, asks for their name and projects folder, stores their token for the team's ticket system, Asana or Jira, and installs the pre-commit check) or create a team (it connects the ticket system, maps projects and tickets, and creates the hub). Mention that the hub git URL needs working access without a password prompt (ssh-agent for ssh, a credential helper for https).
   If `configured` is true and they want to change something (add a teammate or project, redo the ticket mapping, reconnect their ticket account, start over), tell them to run the same `init` command again: it opens a menu for those changes.
4. After they say it is done, call the `setup_info` tool again to confirm.
