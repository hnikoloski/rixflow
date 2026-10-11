import { describe, expect, it } from 'vitest';
import { checkChanges, parseNameStatus } from '../../src/core/ownership';
import { HubError } from '../../src/core/types';

describe('parseNameStatus', () => {
  it('parses NUL-separated git output and maps T to M', () => {
    expect(parseNameStatus('A\0inbox/pm/x.md\0M\0people/a/n.md\0T\0shared/s.md\0D\0people/a/old.md\0')).toEqual([
      { status: 'A', path: 'inbox/pm/x.md' },
      { status: 'M', path: 'people/a/n.md' },
      { status: 'M', path: 'shared/s.md' },
      { status: 'D', path: 'people/a/old.md' },
    ]);
  });
  it('returns an empty list for empty output', () => {
    expect(parseNameStatus('')).toEqual([]);
  });
  it('maps a rename into a delete of the old path and an add of the new path', () => {
    expect(parseNameStatus('R100\0people/ana/a.md\0people/hristijan/b.md\0')).toEqual([
      { status: 'D', path: 'people/ana/a.md' },
      { status: 'A', path: 'people/hristijan/b.md' },
    ]);
  });
  it('maps a copy into a delete of the source and an add of the target', () => {
    expect(parseNameStatus('C075\0shared/a.md\0shared/b.md\0')).toEqual([
      { status: 'D', path: 'shared/a.md' },
      { status: 'A', path: 'shared/b.md' },
    ]);
  });
  it('keeps non-ASCII paths intact', () => {
    expect(parseNameStatus('A\0people/hristijan/é.md\0')).toEqual([
      { status: 'A', path: 'people/hristijan/é.md' },
    ]);
  });
  it('throws BAD_DIFF on an unknown status', () => {
    expect(() => parseNameStatus('U\0people/a/x.md\0')).toThrow(HubError);
    expect(() => parseNameStatus('X\0people/a/x.md\0')).toThrow(/BAD_DIFF|unknown status/);
  });
  it('throws BAD_DIFF on a malformed record with a missing or empty path', () => {
    expect(() => parseNameStatus('A\0')).toThrow(HubError);
    expect(() => parseNameStatus('A\0\0M\0people/a/x.md\0')).toThrow(HubError);
    expect(() => parseNameStatus('R100\0people/a/old.md\0')).toThrow(HubError);
  });
});

describe('checkChanges', () => {
  const u = 'hristijan';
  it('allows own folder, own inbox, new messages to others, shared and config edits, root files', () => {
    expect(checkChanges(u, [
      { status: 'D', path: 'people/hristijan/checkpoints/1.md' },
      { status: 'M', path: 'inbox/hristijan/2026-10-08-aaaa.md' },
      { status: 'A', path: 'inbox/pm/2026-10-08-bbbb.md' },
      { status: 'M', path: 'shared/decisions/ab-200.md' },
      { status: 'A', path: 'config/sites.yml' },
      { status: 'M', path: 'README.md' },
      { status: 'A', path: 'people/hristijan/é.md' },
    ])).toEqual([]);
  });
  it('rejects edits to other people and their inbox messages', () => {
    const v = checkChanges(u, [
      { status: 'M', path: 'people/ana/notes/x.md' },
      { status: 'M', path: 'inbox/pm/2026-10-08-bbbb.md' },
    ]);
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('people/ana/notes/x.md');
    expect(v[1]).toContain('inbox/pm/2026-10-08-bbbb.md');
  });
  it('rejects deletes in shared and unknown top-level folders', () => {
    expect(checkChanges(u, [{ status: 'D', path: 'shared/x.md' }])).toHaveLength(1);
    expect(checkChanges(u, [{ status: 'A', path: 'random/x.md' }])).toHaveLength(1);
  });
  it('rejects a rename that moves a file out of the user folder', () => {
    const changes = parseNameStatus('R100\0people/hristijan/a.md\0people/ana/a.md\0');
    const v = checkChanges(u, changes);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('people/ana/a.md');
  });
  it('rejects a rename that moves a file into another person folder', () => {
    const changes = parseNameStatus('R100\0inbox/hristijan/a.md\0people/ana/a.md\0');
    const v = checkChanges(u, changes);
    expect(v.some((m) => m.includes('people/ana/a.md'))).toBe(true);
  });
  it('rejects traversal into another person folder via people/<user>/../<other>', () => {
    const v = checkChanges(u, [{ status: 'M', path: 'people/hristijan/../ana/x' }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('people/hristijan/../ana/x');
  });
  it('rejects traversal via inbox/pm/../<user>', () => {
    const v = checkChanges(u, [{ status: 'M', path: 'inbox/pm/../hristijan/x' }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('inbox/pm/../hristijan/x');
  });
  it('rejects empty, dot, backslash and absolute paths', () => {
    expect(checkChanges(u, [{ status: 'M', path: 'people/hristijan//x' }])).toHaveLength(1);
    expect(checkChanges(u, [{ status: 'M', path: 'people/hristijan/./x' }])).toHaveLength(1);
    expect(checkChanges(u, [{ status: 'M', path: 'people\\ana\\x' }])).toHaveLength(1);
    expect(checkChanges(u, [{ status: 'M', path: '/people/ana/x' }])).toHaveLength(1);
  });
  it('throws BAD_NAME for an invalid user name', () => {
    expect(() => checkChanges('Bad Name', [])).toThrow(HubError);
    expect(() => checkChanges('../x', [])).toThrow(HubError);
  });
});
