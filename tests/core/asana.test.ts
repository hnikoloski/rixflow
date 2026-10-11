import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsanaClient } from '../../src/core/asana';
import { KEYCHAIN_TIMEOUT_MS, getToken, setToken } from '../../src/core/token';
import { HubError } from '../../src/core/types';

function fakeFetch(pages: unknown[]) {
  const calls: Array<{ url: string; method: string; auth: string }> = [];
  let i = 0;
  const fn = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), auth: String((init.headers as Record<string, string>).Authorization) });
    const body = pages[Math.min(i++, pages.length - 1)];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Every request the client makes is recorded here, whatever method the client method uses.
function recordingFetch(body: unknown = { data: {} }) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; redirect?: string }> = [];
  const fn = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), headers: init.headers as Record<string, string>, redirect: init.redirect });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const SECRET = 'secrettoken-9f8e7d6c5b4a';

describe('AsanaClient', () => {
  it('only issues GET requests and follows pagination', async () => {
    const { fn, calls } = fakeFetch([
      { data: [{ gid: '1' }], next_page: { offset: 'abc' } },
      { data: [{ gid: '2' }], next_page: null },
    ]);
    const client = new AsanaClient('tok', fn);
    const tasks = await client.getMyTasks('111');
    expect(tasks.map((t) => t.gid)).toEqual(['1', '2']);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls[0].auth).toBe('Bearer tok');
    expect(calls[0].url).toContain('assignee=me');
    expect(calls[0].url).toContain('workspace=111');
    expect(calls[1].url).toContain('offset=abc');
  });

  it('issues only GET requests from every client method', async () => {
    const calls: Array<{ method: string }> = [];
    const fn = (async (url: URL, init: RequestInit) => {
      calls.push({ method: String(init.method) });
      const isList = url.pathname.endsWith('/tasks') || url.pathname.endsWith('/stories');
      const data = isList ? [] : { gid: '5', name: 'x', workspaces: [] };
      return new Response(JSON.stringify({ data, next_page: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new AsanaClient('tok', fn);
    await client.getMe();
    await client.getMyTasks('111');
    await client.getTask('5');
    await client.getComments('5');
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.map((c) => c.method)).toEqual(calls.map(() => 'GET'));
  });

  it('maps 401 to ASANA_AUTH', async () => {
    const fn = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(new AsanaClient('bad', fn).getTask('1')).rejects.toMatchObject({ code: 'ASANA_AUTH' });
  });

  it('maps 403 to ASANA_AUTH and other failures to ASANA_HTTP', async () => {
    const forbidden = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    await expect(new AsanaClient('t', forbidden).getTask('1')).rejects.toMatchObject({ code: 'ASANA_AUTH' });
    const broken = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(new AsanaClient('t', broken).getTask('1')).rejects.toMatchObject({ code: 'ASANA_HTTP' });
  });

  it('maps a network failure to ASANA_NETWORK without leaking the token', async () => {
    const fn = (async () => {
      throw new Error(`socket hang up while using ${SECRET}`);
    }) as unknown as typeof fetch;
    const err = await new AsanaClient(SECRET, fn).getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).code).toBe('ASANA_NETWORK');
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('gives every request a timeout signal and maps a timeout to ASANA_NETWORK', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const hang = ((_url: URL, init: RequestInit) => new Promise<Response>((_ok, fail) => {
      signals.push(init.signal);
      init.signal?.addEventListener('abort', () => fail(init.signal?.reason));
    })) as unknown as typeof fetch;
    const err = await new AsanaClient('tok', hang, undefined, 20).getMyTasks('111').catch((e: unknown) => e);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).code).toBe('ASANA_NETWORK');
    const { fn, calls } = recordingFetch({ data: {} });
    const seen: Array<AbortSignal | null | undefined> = [];
    await new AsanaClient('tok', ((u: URL, i: RequestInit) => { seen.push(i.signal); return fn(u, i); }) as unknown as typeof fetch).getMe();
    expect(calls).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it('never puts the token in an error message, even when Asana echoes it back', async () => {
    const fn = (async () => new Response(`bad token ${SECRET}`, { status: 401 })) as unknown as typeof fetch;
    const err = await new AsanaClient(SECRET, fn).getTask('1').catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  it('rejects invalid gids before any request is made', async () => {
    const { fn, calls } = recordingFetch();
    const client = new AsanaClient('tok', fn);
    await expect(client.getTask('../x')).rejects.toMatchObject({ code: 'BAD_GID' });
    await expect(client.getTask('1/2')).rejects.toMatchObject({ code: 'BAD_GID' });
    await expect(client.getComments('abc')).rejects.toMatchObject({ code: 'BAD_GID' });
    await expect(client.getMyTasks('ws?x=1')).rejects.toMatchObject({ code: 'BAD_GID' });
    expect(calls).toEqual([]);
  });

  it('caps pagination at exactly 50 calls when the offset keeps changing', async () => {
    const calls: string[] = [];
    const fn = (async (url: URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [], next_page: { offset: `o${calls.length}` } }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(new AsanaClient('t', fn).getMyTasks('111')).rejects.toMatchObject({ code: 'ASANA_PAGINATION' });
    expect(calls.length).toBe(50);
  });

  it('stops when Asana repeats a page offset', async () => {
    const { fn, calls } = fakeFetch([{ data: [], next_page: { offset: 'same' } }]);
    await expect(new AsanaClient('t', fn).getMyTasks('111')).rejects.toMatchObject({ code: 'ASANA_PAGINATION' });
    expect(calls.length).toBe(2);
  });

  it('sends requests only to app.asana.com with redirects refused', async () => {
    const { fn, calls } = recordingFetch({ data: [], next_page: null });
    await new AsanaClient('tok', fn).getMyTasks('111');
    expect(new URL(calls[0].url).host).toBe('app.asana.com');
    expect(calls[0].redirect).toBe('error');
  });

  it('throws ASANA_HTTP when getTask or getMe returns no object in data', async () => {
    const noData = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await expect(new AsanaClient('t', noData).getTask('1')).rejects.toMatchObject({ code: 'ASANA_HTTP' });
    const stringData = (async () => new Response('{"data":"x"}', { status: 200 })) as unknown as typeof fetch;
    await expect(new AsanaClient('t', stringData).getMe()).rejects.toMatchObject({ code: 'ASANA_HTTP' });
  });

  it('returns only comment stories, most recent last', async () => {
    const { fn } = fakeFetch([{ data: [
      { created_at: '1', created_by: { name: 'A' }, text: 'assigned', resource_subtype: 'assigned' },
      { created_at: '2', created_by: { name: 'Designer' }, text: 'move the logo', resource_subtype: 'comment_added' },
    ] }]);
    expect(await new AsanaClient('t', fn).getComments('9')).toEqual([{ created_at: '2', author: 'Designer', text: 'move the logo' }]);
  });

  it('exposes no write methods', () => {
    const proto = Object.getOwnPropertyNames(AsanaClient.prototype);
    expect(proto.filter((n) => /create|update|delete|post|put|patch|add|set/i.test(n))).toEqual([]);
  });
});

describe('token storage', () => {
  const noKeychain = () => { throw new Error('no keychain'); };
  const tmp = () => mkdtempSync(join(tmpdir(), 'tok-'));

  it('prefers ASANA_TOKEN from env', () => {
    expect(getToken('/nope', { ASANA_TOKEN: 'envtok' }, noKeychain)).toBe('envtok');
  });
  it('falls back to a 0600 file when no keychain exists', () => {
    const dir = tmp();
    expect(setToken(dir, 'filetok', noKeychain)).toBe('file');
    expect(readFileSync(join(dir, 'asana-token'), 'utf8')).toBe('filetok');
    expect(statSync(join(dir, 'asana-token')).mode & 0o777).toBe(0o600);
    expect(getToken(dir, {}, noKeychain)).toBe('filetok');
  });
  it('replaces an existing looser token file with a 0600 one', () => {
    const dir = tmp();
    const file = join(dir, 'asana-token');
    writeFileSync(file, 'old', { mode: 0o644 });
    expect(setToken(dir, 'newtok', noKeychain)).toBe('file');
    expect(readFileSync(file, 'utf8')).toBe('newtok');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it('creates the config directory without world access', () => {
    const dir = join(tmp(), 'rixflow');
    setToken(dir, 'dirtok', noKeychain);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, 'asana-token')).mode & 0o777).toBe(0o600);
  });
  it('uses the keychain when available and never passes the token as an argument', () => {
    const store = new Map<string, string>();
    const argsSeen: string[][] = [];
    const exec = (cmd: string, args: string[], input?: string) => {
      argsSeen.push(args);
      if (args.includes('store') || args.includes('add-generic-password')) { store.set('t', input ?? args[args.length - 1]); return ''; }
      if (store.has('t')) return `${store.get('t')}\n`;
      throw new Error('missing');
    };
    const dir = tmp();
    expect(setToken(dir, 'kctok', exec)).toBe('keychain');
    expect(getToken(dir, {}, exec)).toBe('kctok');
    expect(getToken(tmp(), {}, noKeychain)).toBeNull();
    expect(existsSync(join(dir, 'asana-token'))).toBe(false);
    if (process.platform !== 'darwin') {
      expect(argsSeen.flat().some((a) => a.includes('kctok'))).toBe(false);
    }
  });
  it('does not write the token to disk when the keychain accepts it', () => {
    const exec = (_cmd: string, args: string[]) => (args.includes('store') ? '' : 'x');
    const dir = tmp();
    setToken(dir, 'kctok2', exec);
    expect(existsSync(join(dir, 'asana-token'))).toBe(false);
  });
  it('treats an empty keychain answer as no token and falls back to the file', () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'asana-token'), 'filetok2\n', { mode: 0o600 });
    expect(getToken(dir, {}, () => '\n')).toBe('filetok2');
  });
  it('keys the keychain account by user name and still reads the legacy account (M7)', () => {
    const store = new Map<string, string>();
    const exec = (_cmd: string, args: string[], input?: string) => {
      const account = args[args.indexOf(process.platform === 'darwin' ? '-a' : 'account') + 1];
      if (args.includes('store') || args.includes('add-generic-password')) { store.set(account, input ?? args[args.length - 1]); return ''; }
      if (store.has(account)) return `${store.get(account)}\n`;
      throw new Error('missing');
    };
    const dir = tmp();
    store.set('asana', 'legacytok');
    expect(getToken(dir, {}, exec, 'pm')).toBe('legacytok');
    expect(setToken(dir, 'pmtok', exec, 'pm')).toBe('keychain');
    expect(setToken(dir, 'metok', exec, 'me')).toBe('keychain');
    expect(store.get('asana:pm')).toBe('pmtok');
    expect(store.get('asana:me')).toBe('metok');
    expect(getToken(dir, {}, exec, 'pm')).toBe('pmtok');
    expect(getToken(dir, {}, exec, 'me')).toBe('metok');
    expect(store.get('asana')).toBe('legacytok');
  });
  it('returns null when nothing is stored', () => {
    expect(getToken(tmp(), {}, noKeychain)).toBeNull();
  });
});

describe('hardening: token edge cases', () => {
  it('trims ASANA_TOKEN from the environment', () => {
    const noKeychain = () => { throw new Error('no keychain'); };
    expect(getToken('/nope', { ASANA_TOKEN: '  envtok\n' }, noKeychain)).toBe('envtok');
  });

  it('treats a whitespace-only ASANA_TOKEN as absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tok-'));
    writeFileSync(join(dir, 'asana-token'), 'filetok3', { mode: 0o600 });
    expect(getToken(dir, { ASANA_TOKEN: '   ' }, () => { throw new Error('none'); })).toBe('filetok3');
  });

  it('rejects empty tokens and tokens with whitespace or newlines without storing anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tok-'));
    const calls: string[][] = [];
    const exec = (_c: string, args: string[]) => { calls.push(args); return ''; };
    for (const bad of ['', 'a b', 'abc\n', ' abc', 'ab\tc']) {
      let code: string | undefined;
      try { setToken(dir, bad, exec); } catch (e) { code = (e as HubError).code; }
      expect(code).toBe('BAD_TOKEN');
    }
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, 'asana-token'))).toBe(false);
  });

  it('gives keychain commands a timeout', () => {
    expect(KEYCHAIN_TIMEOUT_MS).toBe(5000);
  });
});
