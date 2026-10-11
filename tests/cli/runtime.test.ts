import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JiraClient } from '../../src/core/tickets/jira';
import { makeSource, persist, syncHub } from '../../src/core/runtime';
import { LEGACY_WORKFLOW, type Workflow } from '../../src/core/workflow';
import { makeCtx } from '../helpers';

describe('runtime helpers', () => {
  it('makeSource is null without workspace or token', () => {
    const ctx = makeCtx();
    const noWorkspace = { ...ctx, user: { ...ctx.user, asanaWorkspace: undefined } };
    expect(makeSource(ctx, { ASANA_TOKEN: 'tok' })?.kind).toBe('asana');
    expect(makeSource(noWorkspace, { ASANA_TOKEN: 'tok' })).toBeNull();
    expect(makeSource({ ...ctx, configDir: join(ctx.configDir, 'none') }, {})).toBeNull();
  });
  it("makeSource takes the workspace from workflow.yml first, ", () => {
    const ctx = makeCtx();
    const noWorkspace = { ...ctx, user: { ...ctx.user, asanaWorkspace: undefined } };
    const pinned: Workflow = { ...structuredClone(LEGACY_WORKFLOW), legacy: false, tracker: { type: 'asana', workspace: '222' } };
    expect(makeSource(noWorkspace, { ASANA_TOKEN: 'tok' }, pinned)).not.toBeNull();
  });
  it('makeSource builds a JiraClient from the jira token and, for Cloud, the machine email', () => {
    const ctx = makeCtx();
    const base: Workflow = { ...structuredClone(LEGACY_WORKFLOW), legacy: false };
    const cloud: Workflow = { ...base, tracker: { type: 'jira', url: 'https://acme.example.com', flavor: 'cloud', projects: ['WEB'] } };
    const withEmail = { ...ctx, user: { ...ctx.user, jiraEmail: 'dev@acme.example.com' } };
    expect(makeSource(withEmail, { JIRA_TOKEN: 'tok' }, cloud)).toBeInstanceOf(JiraClient);
    expect(makeSource(ctx, { JIRA_TOKEN: 'tok' }, cloud)).toBeNull();
    expect(makeSource(withEmail, { ASANA_TOKEN: 'tok' }, cloud)).toBeNull();
    const server: Workflow = { ...base, tracker: { type: 'jira', url: 'https://jira.globex.example.com/jira/', flavor: 'server', projects: [] } };
    expect(makeSource(ctx, { JIRA_TOKEN: 'tok' }, server)?.kind).toBe('jira');
    expect(makeSource(ctx, {}, server)).toBeNull();
  });
  it('makeSource throws BAD_CONFIG for an invalid workflow.yml', () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.hubDir, 'config', 'workflow.yml'), 'tracker:\n  type: trello\n');
    expect(() => makeSource(ctx, { ASANA_TOKEN: 'tok' })).toThrowError(expect.objectContaining({ code: 'BAD_CONFIG' }));
  });
  it('syncHub is null when the hub is not a git repo', async () => {
    expect(await syncHub(makeCtx())).toBeNull();
  });
  it('persist never throws and returns a status', async () => {
    const ctx = makeCtx();
    expect((await persist(ctx, 'm')).detail).toContain('not a git repo');
    mkdirSync(join(ctx.hubDir, '.git'));
    writeFileSync(join(ctx.hubDir, '.git', 'HEAD'), 'garbage');
    expect((await persist(ctx, 'm')).status).toBe('blocked');
    const missing = { ...ctx, hubDir: join(mkdtempSync(join(tmpdir(), 'x-')), 'nope') };
    expect((await persist(missing, 'm')).status).toBe('blocked');
  });
});
