import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_WORKFLOW, compareVersions, loadWorkflow, workflowToYaml, writeWorkflow, type Workflow } from '../../src/core/workflow';
import { WORKFLOW_REQUIRES } from '../../src/core/version';

let hub: string;
beforeEach(() => {
  hub = mkdtempSync(join(tmpdir(), 'wf-'));
  mkdirSync(join(hub, 'config'));
});
const put = (text: string) => writeFileSync(join(hub, 'config', 'workflow.yml'), text);
const JIRA = 'tracker:\n  type: jira\n  url: https://acme.atlassian.net\n  flavor: cloud\nproject:\n  from: component\n';

describe('workflow.yml', () => {
  it('missing file gives the legacy default', () => {
    const wf = loadWorkflow(hub);
    expect(wf).toEqual(LEGACY_WORKFLOW);
    expect(wf.legacy).toBe(true);
    wf.urgent.values.push('x');
    expect(loadWorkflow(hub).urgent.values).not.toContain('x');
    expect(() => LEGACY_WORKFLOW.urgent.values.push('x')).toThrow();
  });

  it('round-trips the spec sketch', () => {
    const wf: Workflow = {
      requires: '0.3.0',
      legacy: false,
      tracker: { type: 'jira', url: 'https://acme.atlassian.net', flavor: 'cloud', projects: ['WEB', 'OPS'] },
      project: { from: 'component', field: null, values: { 'Acme site': 'AC', 'Globex web': 'GL' } },
      status: { field: null, todo: ['To Do', 'Backlog'], in_progress: ['In Progress', 'In Review'], waiting: ['Waiting for feedback', 'Blocked'], done: ['Done'] },
      sprints: { mode: 'jira-sprints', board: 12 },
      urgent: { field: 'priority', values: ['Highest', 'Critical'] },
    };
    writeWorkflow(hub, wf);
    expect(loadWorkflow(hub, '0.3.0')).toEqual(wf);
    // A patch release still reads it: setup writes the format version, not the release version.
    expect(loadWorkflow(hub)).toEqual(wf);
    expect(WORKFLOW_REQUIRES).toBe('0.3.0');
  });

  it('round-trips asana with codes and no requires', () => {
    const wf = { ...structuredClone(LEGACY_WORKFLOW), legacy: false };
    writeWorkflow(hub, wf);
    expect(loadWorkflow(hub)).toEqual(wf);
  });

  it('never writes the legacy key', () => {
    expect(workflowToYaml(LEGACY_WORKFLOW)).not.toMatch(/legacy/);
    writeWorkflow(hub, LEGACY_WORKFLOW);
    expect(readFileSync(join(hub, 'config', 'workflow.yml'), 'utf8')).not.toMatch(/legacy/);
  });

  it('rejects an unknown tracker type', () => {
    put('tracker:\n  type: trello\n');
    expect(() => loadWorkflow(hub)).toThrow('config/workflow.yml: unknown tracker type: trello');
  });
  it('rejects jira without url', () => {
    put('tracker:\n  type: jira\n  flavor: cloud\n');
    expect(() => loadWorkflow(hub)).toThrow('config/workflow.yml: jira tracker needs a url');
  });
  it('rejects jira without flavor', () => {
    put('tracker:\n  type: jira\n  url: https://acme.atlassian.net\n');
    expect(() => loadWorkflow(hub)).toThrow('config/workflow.yml: jira tracker needs flavor: cloud or server');
  });
  it('rejects a non-https jira url', () => {
    put(JIRA.replace('https://', 'http://'));
    expect(() => loadWorkflow(hub)).toThrow('config/workflow.yml: jira url must use https');
  });
  it('rejects a bad project code', () => {
    put(`${JIRA}  values:\n    Acme: bad-code\n`);
    expect(() => loadWorkflow(hub)).toThrow('config/workflow.yml: invalid project code for "Acme": bad-code');
  });
  it('rejects a status in two buckets', () => {
    put(`${JIRA}status:\n  todo: [Blocked]\n  waiting: [blocked]\n`);
    expect(() => loadWorkflow(hub)).toThrow('config/workflow.yml: status "blocked" is listed in both todo and waiting');
  });
  it('rejects custom-field without field', () => {
    put('tracker:\n  type: asana\nproject:\n  from: custom-field\n');
    expect(() => loadWorkflow(hub)).toThrow('config/workflow.yml: project source custom-field needs a field');
  });
  it('reports invalid yaml with the same prefix', () => {
    put('tracker: [');
    expect(() => loadWorkflow(hub)).toThrow(/^config\/workflow\.yml: invalid YAML/);
  });

  it('requires a newer RixFlow', () => {
    put(`requires: 9.0.0\n${JIRA}`);
    expect(() => loadWorkflow(hub)).toThrow(/needs RixFlow 9\.0\.0 or newer\. Update RixFlow: \/plugin marketplace update rixflow, then restart Claude Code/);
    try {
      loadWorkflow(hub);
    } catch (e) {
      expect((e as { code: string }).code).toBe('WORKFLOW_TOO_NEW');
    }
  });
  it('loads an older requires; empty requires is null', () => {
    put(`requires: 0.1.0\n${JIRA}`);
    expect(loadWorkflow(hub).requires).toBe('0.1.0');
    put(`requires: ''\n${JIRA}`);
    expect(loadWorkflow(hub).requires).toBeNull();
  });

  it('strips the trailing slash and keeps a context path', () => {
    put(JIRA.replace('acme.atlassian.net', 'jira.example.com/jira/'));
    const wf = loadWorkflow(hub);
    expect(wf.tracker).toMatchObject({ url: 'https://jira.example.com/jira' });
  });

  it('compares versions', () => {
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
  });
});
