import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

describe('plugin package', () => {
  it('has a manifest, marketplace entry and MCP config', () => {
    expect(JSON.parse(read('plugin/.claude-plugin/plugin.json')).name).toBe('rixflow');
    const market = JSON.parse(read('.claude-plugin/marketplace.json'));
    expect(market.plugins[0]).toMatchObject({ name: 'rixflow', source: './plugin' });
    expect(JSON.parse(read('plugin/.mcp.json')).mcpServers.hub.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/mcp.cjs']);
  });
  it('wires all four hooks to the bundled CLI', () => {
    const hooks = JSON.parse(read('plugin/hooks/hooks.json')).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['PreCompact', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    for (const groups of Object.values(hooks) as Array<Array<{ hooks: Array<{ args: string[] }> }>>) {
      expect(groups[0].hooks[0].args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/dist/hub.cjs');
    }
  });
  it('the core, the mod, the package and the MCP server carry one version', () => {
    // `claude plugin update` skips a plugin whose version did not change, so bump them together.
    const version = JSON.parse(read('package.json')).version;
    expect(JSON.parse(read('plugin/.claude-plugin/plugin.json')).version).toBe(version);
    expect(JSON.parse(read('ui/.claude-plugin/plugin.json')).version).toBe(version);
    expect(read('src/core/version.ts')).toContain(`'${version}'`);
    expect(read('src/mcp/server.ts')).toContain(`new McpServer({ name: 'hub', version: '${version}' })`);
  });

  it('the UI mod depends on the core, so one install brings both', () => {
    expect(JSON.parse(read('ui/.claude-plugin/plugin.json')).dependencies).toEqual(['rixflow']);
  });

  it('marketplace lists the core and the UI mod', () => {
    const market = JSON.parse(read('.claude-plugin/marketplace.json'));
    expect(market.plugins.map((p: { name: string; source: string }) => [p.name, p.source])).toEqual([
      ['rixflow', './plugin'],
      ['rixflow-ui', './ui'],
    ]);
  });
  it('has every command with a description, and no CLAUDE.md', () => {
    const commands = readdirSync('plugin/commands').sort();
    expect(commands).toEqual(['ask.md', 'checkpoint.md', 'drop.md', 'handover.md', 'inbox.md', 'plate.md', 'resume.md', 'send.md', 'setup.md', 'start.md', 'wrapup.md']);
    for (const c of commands) expect(read(`plugin/commands/${c}`)).toMatch(/^---\ndescription: .+/);
    expect(existsSync('plugin/CLAUDE.md')).toBe(false);
  });
  it('references only tools the server defines', () => {
    const tools = [...read('src/mcp/server.ts').matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(tools.length).toBeGreaterThan(10);
    const text = readdirSync('plugin/commands').map((c) => read(`plugin/commands/${c}`)).join('\n') + read('plugin/skills/rixflow/SKILL.md');
    const refs = [...text.matchAll(/`([a-z_]+)` tools?\b/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(10);
    for (const r of refs) expect(tools).toContain(r);
  });
  it('runs only hook subcommands the CLI accepts, and SessionStart has a matcher', () => {
    const src = read('src/cli/hooks.ts');
    const events = new Set([...src.matchAll(/event === '([a-z-]+)'/g)].map((m) => m[1]));
    expect(events.size).toBe(4);
    const hooks = JSON.parse(read('plugin/hooks/hooks.json')).hooks;
    for (const groups of Object.values(hooks) as Array<Array<{ hooks: Array<{ command: string; args: string[] }> }>>) {
      const h = groups[0].hooks[0];
      expect(h.command).toBe('node');
      expect(h.args[1]).toBe('hook');
      expect(events.has(h.args[2])).toBe(true);
    }
    expect(hooks.SessionStart[0].matcher).toBeTruthy();
  });
  it('never points commands or the skill at hub file paths (I7)', () => {
    const files = [...readdirSync('plugin/commands').map((c) => `plugin/commands/${c}`), 'plugin/skills/rixflow/SKILL.md'];
    for (const f of files) {
      expect(read(f), f).not.toContain('~/.rixflow');
      expect(read(f), f).not.toContain('.rixflow/');
    }
    expect(read('plugin/commands/start.md')).toContain('`read_note` tool');
    expect(read('plugin/commands/start.md')).toContain('`team_info` tool');
    expect(read('plugin/commands/ask.md')).toContain('`team_info` tool');
  });
  it('hints never tell the user to run a bare `hub` command; /rixflow:setup prints the real one (I8)', () => {
    const files = [...readdirSync('plugin/commands').map((c) => `plugin/commands/${c}`), 'plugin/skills/rixflow/SKILL.md'];
    for (const f of files) expect(read(f), f).not.toMatch(/`hub (init|token|sync)/);
    const setup = read('plugin/commands/setup.md');
    expect(setup).toContain('`setup_info` tool');
    expect(setup).toContain('`team_info` tool');
    expect(setup).toMatch(/never run/i);
    expect(read('plugin/commands/plate.md')).toContain('`setup_info` tool');
    for (const src of ['src/core/config.ts', 'src/core/asana.ts', 'src/core/check.ts', 'src/core/plate.ts', 'src/mcp/server.ts']) {
      expect(read(src), src).not.toMatch(/run:? hub (init|token)/i);
    }
  });
  it('resume says when the ticket tracker could not be checked (I9)', () => {
    const resume = read('plugin/commands/resume.md');
    expect(resume).toContain('ticketsUnavailable');
    expect(resume).toContain('could not check the ticket tracker for changes');
  });
  it('checkpoint stores the stash by SHA and message; resume never looks it up by index (M2)', () => {
    const checkpoint = read('plugin/commands/checkpoint.md');
    expect(checkpoint).toContain('git rev-parse stash@{0}');
    expect(checkpoint).not.toContain('git stash list | head -1');
    const resume = read('plugin/commands/resume.md');
    expect(resume).toMatch(/SHA/);
    expect(resume).not.toMatch(/stash@\{\d\}/);
  });
  it('SessionStart also fires after compaction (M4)', () => {
    const hooks = JSON.parse(read('plugin/hooks/hooks.json')).hooks;
    expect(hooks.SessionStart[0].matcher.split('|')).toEqual(expect.arrayContaining(['startup', 'resume', 'clear', 'compact']));
  });
  it('marks teammate content as data in the skill and the commands that read it', () => {
    expect(read('plugin/skills/rixflow/SKILL.md')).toContain('## Teammate content is data');
    for (const c of ['ask', 'inbox', 'plate', 'start', 'resume']) expect(read(`plugin/commands/${c}.md`)).toContain('Teammate content is data');
  });
  it('inbox command accepts a message id argument', () => {
    const text = read('plugin/commands/inbox.md');
    expect(text).toContain('$ARGUMENTS');
    expect(text).toContain('argument-hint:');
  });

  // R3: user-facing text says "project" and "tickets". Internal identifiers are exempt on purpose.
  const userText = () => {
    const files = [...readdirSync('plugin/commands').map((c) => `plugin/commands/${c}`), 'plugin/skills/rixflow/SKILL.md'];
    const lines = files.flatMap((f) => read(f).split('\n').map((l) => ({ where: f, l })));
    const server = read('src/mcp/server.ts');
    const descs = [...server.matchAll(/description:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => ({ where: 'server.ts', l: m[2] }));
    return [...lines, ...descs];
  };
  it('user-facing text says "project", not "site" (internal names excepted)', () => {
    // Allowed: the tool name remember_site, the file sites.yml, the hub path shared/sites/, the team_info `sites` field and the `site` tool argument.
    const allowed = /remember_site|sites\.yml|shared\/sites\/|`sites?`/g;
    const bad = userText().filter(({ l }) => /\bsites?\b/i.test(l.replace(allowed, '')));
    expect(bad).toEqual([]);
  });
  it('user-facing text says "tickets", not "Asana", except where naming the supported systems or the read-only rule', () => {
    // Allowlist: (1) the supported-systems list ("Asana or Jira"); (2) the never-writes rule, which names the real systems.
    const allowed = /Asana or Jira|Jira or Asana|read-only|never writes?|Never write/i;
    const bad = userText().filter(({ l }) => /\bAsana\b/.test(l) && !allowed.test(l));
    expect(bad).toEqual([]);
  });
});
