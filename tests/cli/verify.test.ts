import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyStaged } from '../../src/cli/verify';
import { Git } from '../../src/core/git';
import { bootstrapHub } from '../../src/core/template';
import { HubError } from '../../src/core/types';
import { buildBrief } from '../../src/core/brief';
import { writeDoc } from '../../src/core/hubfs';
import { asTicket, field, task } from '../fixtures/asana';

const ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
};

async function hub() {
  const dir = join(mkdtempSync(join(tmpdir(), 'v-')), 'hub');
  await bootstrapHub(dir, [{ name: 'hristijan', role: 'dev' }, { name: 'pm', role: 'pm' }], { AC: { folder: 'acme' } }, ENV);
  return { dir, git: new Git(dir, ENV) };
}

function put(dir: string, rel: string, text: string) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

describe('bootstrapHub under symlinks', () => {
  it('succeeds when the parent directory is a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'v-'));
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    await bootstrapHub(join(root, 'link', 'hub'), [{ name: 'a', role: 'dev' }], {}, ENV);
    expect(existsSync(join(root, 'real/hub/README.md'))).toBe(true);
  });
});

describe('bootstrapHub', () => {
  it('creates the layout and an initial commit', async () => {
    const { git } = await hub();
    const files = (await git.run(['ls-files'])).split('\n').filter(Boolean).sort();
    expect(files).toEqual([
      '.gitignore', 'README.md', 'config/sites.yml', 'config/team.yml', 'inbox/hristijan/.gitkeep', 'inbox/pm/.gitkeep',
      'people/hristijan/_index.md', 'people/pm/_index.md', 'shared/_index.md', 'shared/decisions/.gitkeep',
    ]);
  });
  it('rejects bad member names, roles, site codes and folders before writing anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'v-'));
    const ok = [{ name: 'a', role: 'dev' as const }];
    await expect(bootstrapHub(join(root, 'h1'), [{ name: '../x', role: 'dev' }], {}, ENV)).rejects.toMatchObject({ code: 'BAD_NAME' });
    await expect(bootstrapHub(join(root, 'h2'), ok, { 'bad code': { folder: 'f' } }, ENV)).rejects.toMatchObject({ code: 'BAD_SITE' });
    await expect(bootstrapHub(join(root, 'h3'), ok, { AC: { folder: '../x' } }, ENV)).rejects.toBeInstanceOf(HubError);
    await expect(bootstrapHub(join(root, 'h4'), [{ name: 'a', role: 'boss' as never }], {}, ENV)).rejects.toBeInstanceOf(HubError);
    await expect(bootstrapHub(join(root, 'h5'), [ok[0], ok[0]], {}, ENV)).rejects.toBeInstanceOf(HubError);
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5']) expect(existsSync(join(root, h))).toBe(false);
  });
  it('refuses to bootstrap over an existing repo', async () => {
    const { dir } = await hub();
    await expect(bootstrapHub(dir, [{ name: 'a', role: 'dev' }], {}, ENV)).rejects.toBeInstanceOf(HubError);
  });
  it('writes markdown through writeDoc (frontmatter)', async () => {
    const { dir } = await hub();
    expect(readFileSync(join(dir, 'README.md'), 'utf8').startsWith('---\n')).toBe(true);
  });
});

describe('verifyStaged', () => {
  it('passes own changes and new messages to others', async () => {
    const { dir, git } = await hub();
    put(dir, 'people/hristijan/notes/a.md', 'hello');
    put(dir, 'inbox/pm/2026-10-08-aaaa.md', 'question');
    await git.run(['add', '-A']);
    expect(await verifyStaged(git, 'hristijan')).toEqual([]);
  });
  it('blocks edits to other people and staged secrets', async () => {
    const { dir, git } = await hub();
    put(dir, 'people/pm/_index.md', 'tampered');
    put(dir, 'people/hristijan/leak.md', 'see https://user:pw123456@stage.example.com/');
    await git.run(['add', '-A']);
    const problems = await verifyStaged(git, 'hristijan');
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('people/pm/_index.md');
    expect(problems.join('\n')).toContain('url-credentials');
  });
  it('handles paths with spaces and newlines (NUL-separated diff)', async () => {
    const { dir, git } = await hub();
    put(dir, 'people/pm/a b\nc.md', 'x');
    await git.run(['add', '-A']);
    const problems = await verifyStaged(git, 'hristijan');
    expect(problems.join('\n')).toContain('people/pm/');
  });
  it('treats a rename out of someone else\'s folder as a delete there', async () => {
    const { dir, git } = await hub();
    await git.run(['mv', 'people/pm/_index.md', 'people/hristijan/stolen.md']);
    const problems = await verifyStaged(git, 'hristijan');
    expect(problems.join('\n')).toContain('people/pm/_index.md');
  });
  it('fails closed when git fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notrepo-'));
    await expect(verifyStaged(new Git(dir, ENV), 'hristijan')).rejects.toBeTruthy();
  });
});

describe('verifyStaged symlinks', () => {
  it('rejects a staged symlink', async () => {
    const { dir, git } = await hub();
    mkdirSync(join(dir, 'people/hristijan'), { recursive: true });
    symlinkSync('/etc/passwd', join(dir, 'people/hristijan/evil.md'));
    await git.run(['add', '-A']);
    const problems = await verifyStaged(git, 'hristijan');
    expect(problems.some((p) => p.includes('people/hristijan/evil.md') && /symlink/i.test(p))).toBe(true);
  });

  it('lets a commit that deletes a committed symlink pass', async () => {
    const { dir, git } = await hub();
    mkdirSync(join(dir, 'people/hristijan'), { recursive: true });
    symlinkSync('/etc/passwd', join(dir, 'people/hristijan/evil.md'));
    await git.run(['add', '-A']);
    await git.run(['commit', '-q', '-m', 'planted']);
    rmSync(join(dir, 'people/hristijan/evil.md'));
    await git.run(['add', '-A']);
    expect(await verifyStaged(git, 'hristijan')).toEqual([]);
  });
});

describe('verifyStaged accepts what the scrubber produces', () => {
  it('commits a handover with Stage-link and username-only credential URLs written via writeDoc', async () => {
    const { dir, git } = await hub();
    const leaky = task({
      gid: '101', name: 'Implementation to stage',
      notes: 'Stage: https://acmestage:a1b2c3d4@stage.acme.example.com/en/ and repo https://dev@bitbucket.org/t/r.git, sftp://user:pw@h.sftp.example.com/',
      custom_fields: [field('Stage link - Web', 'https://acmestage:a1b2c3d4@stage.acme.example.com/en/pricing/')],
    });
    writeDoc(join(dir, 'people/hristijan/handovers/101.md'), { type: 'handover', task: '101', project_dir: '/p' }, buildBrief(asTicket(leaky), [asTicket(leaky)], [], 'Asana'));
    await git.run(['add', '-A']);
    const staged = await git.run(['show', ':people/hristijan/handovers/101.md']);
    expect(staged).toContain('https://[redacted]@stage.acme.example.com');
    expect(staged).not.toContain('a1b2c3d4');
    expect(await verifyStaged(git, 'hristijan')).toEqual([]);
  });
});
