---
description: Show how to set up RixFlow on this machine (prints the exact terminal commands)
---

Help the user set up RixFlow. Never run the commands yourself: `init` asks questions and reads the Asana token as hidden input, so it needs the user's own terminal.

1. Call the `setup_info` tool.
2. If `configured` is true: call the `team_info` tool and tell the user they are set up as `me`, listing the team members and site codes. If they asked about the Asana token, show the `tokenSet` command.
3. If `configured` is false: tell the user to open a terminal and run the `init` command exactly as returned, in a fenced block. Explain in one line that init clones the hub, asks for their name, projects folder and Asana token, and installs the pre-commit check. Mention that the hub git URL needs working access without a password prompt (ssh-agent for ssh, a credential helper for https).
4. After they say it is done, call the `setup_info` tool again to confirm.
