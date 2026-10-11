import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Emoji-capable glyphs are drawn 2 cells wide by some terminals while the layout counts 1, so the
// glyph is clipped and the text after it shifts. The mod must use single-width glyphs only.
describe('mod glyphs', () => {
  for (const file of ['ui/hooks/register.tsx', 'ui/hooks/model.ts']) {
    it(`${file} has no emoji-capable glyph or variation selector`, () => {
      const text = readFileSync(file, 'utf8');
      expect(text.match(/\p{Extended_Pictographic}/gu) ?? []).toEqual([]);
      expect(text).not.toContain('\uFE0F');
      expect(text).not.toContain('\uFE0E');
    });
  }
});
