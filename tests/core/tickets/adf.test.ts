import { describe, expect, it } from 'vitest';
import { adfToText } from '../../../src/core/tickets/adf';

const doc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { text: '@Dana' } }, { type: 'text', text: ' please look' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
    ] },
  ],
};

describe('adfToText', () => {
  it('renders paragraphs, bullet lists and mentions', () => {
    expect(adfToText(doc)).toBe('Hi @Dana please look\n- one\n- two');
  });
  it('falls back to text for unknown nodes and tolerates junk', () => {
    expect(adfToText({ type: 'doc', content: [{ type: 'panel', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'note' }] }] }] })).toBe('note');
    expect(adfToText(null)).toBe('');
    expect(adfToText('plain')).toBe('plain');
  });
  it('never throws on malformed input', () => {
    const bad: unknown[] = [
      { type: 'paragraph', content: 'oops' }, { type: 'paragraph', content: {} }, { type: 'mention', attrs: { text: 5 } },
      { type: 'listItem', content: {} }, null, 42, [],
      { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: {} }, 7] }, { type: 'mention', attrs: { text: 5 } }] },
    ];
    for (const b of bad) expect(typeof adfToText(b)).toBe('string');
  });
});
