import { describe, expect, it } from 'vitest';
import { askValid, choose, confirm } from '../../../src/cli/wizard/prompts';
import { scriptedIo } from './io';

const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];

describe('prompts', () => {
  it('choose re-asks on bad input then accepts', async () => {
    expect(await choose(scriptedIo(['9', '2']), 'Pick', opts)).toBe('b');
  });
  it('choose aborts after three bad answers', async () => {
    await expect(choose(scriptedIo(['x', '0', '7', '1']), 'Pick', opts)).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('choose uses the fallback on empty', async () => {
    expect(await choose(scriptedIo(['']), 'Pick', opts, 'b')).toBe('b');
  });
  it('aborts on a closed stdin instead of looping', async () => {
    const io = scriptedIo([]);
    await expect(choose(io, 'Pick', opts, 'a')).rejects.toMatchObject({ code: 'ABORTED', message: 'Setup stopped. Run it again to continue where you left off.' });
    await expect(confirm(scriptedIo([]), 'ok?')).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(askValid(scriptedIo([]), 'x', () => null, 'd')).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('confirm handles defaults and answers', async () => {
    expect(await confirm(scriptedIo(['']), 'q')).toBe(true);
    expect(await confirm(scriptedIo(['']), 'q', false)).toBe(false);
    expect(await confirm(scriptedIo(['maybe', 'N']), 'q')).toBe(false);
    expect(await confirm(scriptedIo(['yes']), 'q', false)).toBe(true);
  });
  it('askValid shows the error and retries, then aborts', async () => {
    const v = (s: string) => (s.startsWith('ok') ? null : 'nope');
    const io = scriptedIo(['bad', 'ok1']);
    expect(await askValid(io, 'q', v)).toBe('ok1');
    expect(io.logs).toContain('nope');
    await expect(askValid(scriptedIo(['a', 'b', 'c']), 'q', v)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(await askValid(scriptedIo(['']), 'q', v, 'ok-default')).toBe('ok-default');
  });
});
