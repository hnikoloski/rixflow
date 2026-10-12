import type { TeamMember } from '../../core/team';
import { withoutLogin } from './join';

export const SETUP_LINK = 'https://github.com/hnikoloski/rixflow#installation';

// A ready-to-send invite. It is printed only, never sent, and carries no token or login:
// any user name / password in the hub URL is dropped.
export function inviteText(hubUrl: string, members: TeamMember[], creator: string): string {
  const others = members.filter((m) => m.name !== creator).map((m) => m.name);
  return [
    `${creator} set up RixFlow for our team. To join:`,
    '',
    '1. In Claude Code, install RixFlow:',
    '   /plugin marketplace add hnikoloski/rixflow',
    '   /plugin install rixflow-ui@rixflow',
    '2. Run /rixflow:setup and run the command it prints. Choose "Join an existing team".',
    `3. When asked for the hub, paste: ${withoutLogin(hubUrl)}`,
    `4. Pick your name from the list: ${others.length ? others.join(', ') : '(ask to be added)'}`,
    '',
    `Setup instructions: ${SETUP_LINK}`,
  ].join('\n');
}
