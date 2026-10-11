import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDoc, writeGuarded } from '../../src/core/hubfs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sl-'));
  const hub = join(root, 'hub');
  mkdirSync(join(hub, '.git'), { recursive: true });
  mkdirSync(join(hub, 'shared'), { recursive: true });
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'f.md'), 'untouched');
  return { root, hub, outside };
}

describe('symlink-safe writes', () => {
  it('writeDoc refuses a symlinked final file, exclusive or not', () => {
    const { hub, outside } = fixture();
    symlinkSync(join(outside, 'f.md'), join(hub, 'shared/l.md'));
    expect(() => writeDoc(join(hub, 'shared/l.md'), {}, 'x')).toThrowError(expect.objectContaining({ code: 'SYMLINK' }));
    expect(() => writeDoc(join(hub, 'shared/l.md'), {}, 'x', { exclusive: true })).toThrow();
    expect(readFileSync(join(outside, 'f.md'), 'utf8')).toBe('untouched');
  });

  it('writeDoc refuses a symlinked parent directory, even for new files', () => {
    const { hub, outside } = fixture();
    symlinkSync(outside, join(hub, 'shared/dir'));
    expect(() => writeDoc(join(hub, 'shared/dir/new.md'), {}, 'x')).toThrowError(expect.objectContaining({ code: 'SYMLINK' }));
    expect(() => writeDoc(join(hub, 'shared/dir/sub/new.md'), {}, 'x')).toThrowError(expect.objectContaining({ code: 'SYMLINK' }));
    expect(() => writeDoc(join(outside, 'f.md'), {}, 'x')).not.toThrow(); // outside any hub: no check above the root
  });

  it('writes normally when a directory above the hub root is a symlink', () => {
    const { root, hub } = fixture();
    const alias = join(root, 'alias');
    symlinkSync(root, alias);
    writeDoc(join(alias, 'hub/shared/ok.md'), {}, 'fine');
    expect(readFileSync(join(hub, 'shared/ok.md'), 'utf8')).toContain('fine');
  });

  it('refuses a symlinked hub root, with a hint', () => {
    const { root, hub } = fixture();
    const alias = join(root, 'alias');
    symlinkSync(hub, alias);
    expect(() => writeDoc(join(alias, 'shared/x.md'), {}, 'x')).toThrowError(expect.objectContaining({ code: 'SYMLINK', message: expect.stringMatching(/real/) }));
  });

  it('a symlinked dir pointing at a directory with .git does not end the walk early', () => {
    const { root, hub } = fixture();
    const target = join(root, 'target');
    mkdirSync(join(target, '.git'), { recursive: true });
    rmSync(join(hub, 'shared'), { recursive: true });
    symlinkSync(target, join(hub, 'shared'));
    expect(() => writeDoc(join(hub, 'shared/x.md'), {}, 'x')).toThrowError(expect.objectContaining({ code: 'SYMLINK' }));
    expect(readdirSync(target)).toEqual(['.git']);
  });

  it('writeGuarded writes raw content and refuses symlinks', () => {
    const { hub, outside } = fixture();
    writeGuarded(join(hub, 'shared/raw.txt'), 'raw');
    expect(readFileSync(join(hub, 'shared/raw.txt'), 'utf8')).toBe('raw');
    symlinkSync(join(outside, 'f.md'), join(hub, 'shared/l2.md'));
    expect(() => writeGuarded(join(hub, 'shared/l2.md'), 'x')).toThrowError(expect.objectContaining({ code: 'SYMLINK' }));
  });
});
