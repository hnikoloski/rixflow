import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDoc, stringifyDoc } from '../../src/core/frontmatter';
import { findSecrets, scrub } from '../../src/core/scrub';
import { isoDate, newMessageId } from '../../src/core/ids';
import { insideHub, listMd, personDir, readDoc, writeDoc } from '../../src/core/hubfs';
import { makeCtx } from '../helpers';
import { buildBrief } from '../../src/core/brief';
import { asTicket, field, task } from '../fixtures/asana';

describe('frontmatter', () => {
  it('round-trips and keeps numeric-looking ids as strings', () => {
    const text = stringifyDoc({ task: '1219093521695631', status: 'new', skip: undefined }, 'Hello');
    const doc = parseDoc(text);
    expect(doc.data).toEqual({ task: '1219093521695631', status: 'new' });
    expect(doc.body).toBe('Hello\n');
  });
  it('treats text without frontmatter as body', () => {
    expect(parseDoc('just text')).toEqual({ data: {}, body: 'just text' });
  });
});

describe('scrub', () => {
  it('redacts credentials in URLs but keeps the host and path', () => {
    const out = scrub('see https://globexdev:e5f6a7b8@dev.globex.example.com/dei/ now');
    expect(out).toBe('see https://[redacted]@dev.globex.example.com/dei/ now');
  });
  it('redacts known token shapes and extra literals', () => {
    const text = 'gh ghp_' + 'a'.repeat(36) + ' key sk-ant-' + 'b'.repeat(30) + ' AKIA' + 'C'.repeat(16) + ' pw hunter2secret';
    const out = scrub(text, ['hunter2secret']);
    expect(out).not.toMatch(/ghp_a|sk-ant-b|AKIAC|hunter2secret/);
  });
  it('redacts Asana personal access tokens and bearer tokens', () => {
    const out = scrub('2/1204567890/1205678901:' + 'f'.repeat(32) + ' Authorization: Bearer ' + 'x'.repeat(40));
    expect(out).toBe('[redacted] Authorization: Bearer [redacted]');
  });
  it('redacts passwords containing @ up to the last @ before the path', () => {
    expect(scrub('see https://user:p@ss@host.example.com/path now')).toBe('see https://[redacted]@host.example.com/path now');
  });
  it('findSecrets names what it found', () => {
    expect(findSecrets('https://a:b@c.com')).toEqual(['url-credentials']);
  });

  it('redacts credential URLs glued to a preceding word character', () => {
    expect(scrub('xhttps://u:p@host.com/a and _http://u:p@h.com')).toBe('xhttps://[redacted]@host.com/a and _http://[redacted]@h.com');
    expect(findSecrets('clean text')).toEqual([]);
  });
});

const SECRET_FIXTURES = [
  'see https://globexdev:e5f6a7b8@dev.globex.example.com/dei/ now',
  'https://user:p@ss@host.example.com/path',
  'xhttps://u:p@host.com/a and _http://u:p@h.com',
  'clone https://dev@bitbucket.org/team/repo.git',
  'Stage link: https://acmestage:a1b2c3d4@stage.acme.example.com/en/pricing/',
  'sftp://sftpuser:Secr3t!@sftp.globex.example.com:2222/',
  'ftp://deploy:hunter22@ftp.example.com/public_html',
  'mysql://root:rootpw@127.0.0.1:3306/wp',
  'redis://:s3cretpass@cache.internal:6379/0',
  'postgres://app:pg-pass@db.example.com:5432/app',
  'POSTGRESQL://App:Pw@Db/x',
  'https://[redacted]@x:pass@host/',
  'sftp://[redacted]@x:pass@host/',
  '2/1204567890/1205678901:' + 'f'.repeat(32),
  'gh ghp_' + 'a'.repeat(36),
  'sk-ant-' + 'b'.repeat(30),
  'AKIA' + 'C'.repeat(16),
  'Authorization: Bearer ' + 'x'.repeat(40),
];

describe('scrub is a fixed point of findSecrets', () => {
  it('leaves nothing findSecrets would flag, for every fixture and their concatenation', () => {
    for (const text of [...SECRET_FIXTURES, SECRET_FIXTURES.join('\n')]) {
      expect(findSecrets(text), text).not.toEqual([]);
      const once = scrub(text);
      expect(findSecrets(once), once).toEqual([]);
      expect(scrub(once), once).toBe(once);
    }
  });
  it('scrubs a Stage-link handover brief into something the pre-commit check accepts', () => {
    const t = task({ gid: '101', name: 'Stage https://u:p@x.example.com/', custom_fields: [field('Stage link - Web', 'https://acmestage:a1b2c3d4@stage.acme.example.com/en/pricing/'), field('Dev Link', 'https://dev@bitbucket.org/x/y')] });
    const brief = buildBrief(asTicket(t), [asTicket(t)], [], 'Asana');
    expect(brief).toContain('https://[redacted]@stage.acme.example.com/en/pricing/');
    expect(findSecrets(brief)).toEqual([]);
  });
  it('redacts credentials in any URL scheme and keeps the host', () => {
    expect(scrub('sftp://sftpuser:Secr3t!@sftp.globex.example.com:2222/')).toBe('sftp://[redacted]@sftp.globex.example.com:2222/');
    expect(scrub('redis://:s3cretpass@cache.internal:6379/0')).toBe('redis://[redacted]@cache.internal:6379/0');
    expect(scrub('mysql://root:rootpw@127.0.0.1:3306/wp')).toBe('mysql://[redacted]@127.0.0.1:3306/wp');
    expect(scrub('postgres://app:pg-pass@db.example.com:5432/app')).toBe('postgres://[redacted]@db.example.com:5432/app');
    expect(scrub('ftp://deploy:hunter22@ftp.example.com/x')).toBe('ftp://[redacted]@ftp.example.com/x');
    expect(findSecrets('sftp://a:b@c')).toEqual(['url-credentials']);
  });
  it('runs in linear time on long runs of scheme characters (N1)', () => {
    for (const text of ['a'.repeat(200_000), 'https://' + 'a'.repeat(200_000), 'x://' + 'a:'.repeat(100_000), 'a1+.-'.repeat(40_000), ':a'.repeat(100_000)]) {
      const started = performance.now();
      scrub(text);
      findSecrets(text);
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(200);
    }
  });
  it('leaves user-only non-http URLs and plain text alone', () => {
    expect(scrub('ssh://git@github.com/org/repo.git')).toBe('ssh://git@github.com/org/repo.git');
    expect(scrub('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git');
    expect(findSecrets('https://example.com/a?u=x@y')).toEqual([]);
  });
});

describe('ids', () => {
  it('formats date and id', () => {
    const d = new Date('2026-10-08T23:30:00Z');
    expect(isoDate(d)).toBe('2026-10-08');
    expect(newMessageId(d, () => 0)).toBe('2026-10-08-aaaa');
    expect(newMessageId(d)).toMatch(/^2026-10-08-[a-z0-9]{4}$/);
  });
});

describe('hubfs', () => {
  it('writeDoc scrubs body and string frontmatter values', () => {
    const ctx = makeCtx();
    const path = join(ctx.hubDir, 'people', 'hristijan', 'x.md');
    writeDoc(path, { link: 'https://u:p@h.com/a' }, 'body https://u:p@h.com/b');
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('u:p@');
    expect(readDoc(path).data.link).toBe('https://[redacted]@h.com/a');
  });
  it('writeDoc scrubs nested frontmatter arrays and objects on disk', () => {
    const ctx = makeCtx();
    const linksPath = join(ctx.hubDir, 'people', 'hristijan', 'links.md');
    writeDoc(linksPath, { links: ['https://u:p@h.com/x'] }, 'body');
    expect(readFileSync(linksPath, 'utf8')).not.toContain('u:p@');
    const metaPath = join(ctx.hubDir, 'people', 'hristijan', 'meta.md');
    writeDoc(metaPath, { meta: { url: 'https://u:p@h.com/x' } }, 'body');
    expect(readFileSync(metaPath, 'utf8')).not.toContain('u:p@');
  });
  it('listMd is recursive and tolerates missing dirs', () => {
    const ctx = makeCtx();
    writeDoc(join(ctx.hubDir, 'shared', 'a.md'), {}, 'a');
    writeDoc(join(ctx.hubDir, 'shared', 'sub', 'b.md'), {}, 'b');
    expect(listMd(join(ctx.hubDir, 'shared')).map((p) => p.slice(ctx.hubDir.length))).toEqual(['/shared/a.md', '/shared/sub/b.md']);
    expect(listMd(join(ctx.hubDir, 'nope'))).toEqual([]);
  });
  it('personDir validates names', () => {
    const ctx = makeCtx();
    expect(personDir(ctx)).toBe(join(ctx.hubDir, 'people', 'hristijan'));
    expect(() => personDir(ctx, '../evil')).toThrowError(expect.objectContaining({ code: 'BAD_NAME' }));
  });
  it('insideHub blocks traversal', () => {
    const ctx = makeCtx();
    expect(insideHub(ctx.hubDir, 'shared/a.md')).toBe(join(ctx.hubDir, 'shared', 'a.md'));
    expect(() => insideHub(ctx.hubDir, '../../etc/passwd')).toThrowError(expect.objectContaining({ code: 'BAD_PATH' }));
    expect(() => insideHub(ctx.hubDir, '/etc/passwd')).toThrowError(expect.objectContaining({ code: 'BAD_PATH' }));
  });
});
