import { describe, expect, it } from 'vitest';
import { assertTicketId, normalizeTicketId } from '../../src/core/types';

describe('assertTicketId', () => {
  it('accepts Asana gids and Jira keys', () => {
    for (const id of ['1219374948018663', 'WEB-123', 'MY_PROJ-9']) expect(() => assertTicketId(id)).not.toThrow();
  });
  it('rejects anything else', () => {
    for (const id of ['web-123', 'WEB-', '../x', 'WEB-1/2', 'A'.repeat(21) + '-1', '']) {
      expect(() => assertTicketId(id)).toThrowError(expect.objectContaining({ code: 'BAD_TICKET' }));
    }
    expect(() => assertTicketId(42)).toThrowError(/invalid ticket id: 42/);
  });
});

describe('normalizeTicketId', () => {
  it('normalizes jira keys', () => {
    expect(normalizeTicketId(' web-123 ')).toBe('WEB-123');
    expect(normalizeTicketId('42')).toBe('42');
    expect(() => normalizeTicketId('x y')).toThrowError(expect.objectContaining({ code: 'BAD_TICKET' }));
  });
});
