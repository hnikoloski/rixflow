import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

let bundle = '';
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'tio-'));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, `import { terminalIo } from ${JSON.stringify(join(process.cwd(), 'src/cli/init.ts'))};
(async () => {
  const io = terminalIo();
  const a = await io.ask('A? ');
  const b = await io.askHidden('B? ');
  const c = await io.ask('C? ');
  process.stderr.write(JSON.stringify({ a, b, c, closed: io.closed }) + '\\n');
})();`);
  bundle = join(dir, 'out.cjs');
  buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
});

const run = (input: string | null) => spawnSync('node', [bundle], { input: input ?? '', encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
const result = (stderr: string) => JSON.parse(stderr.trim().split('\n').pop() as string);

describe('terminalIo with a real process', () => {
  it('receives every piped answer', () => {
    const r = run('one\ntwo\nthree\n');
    expect(r.status).toBe(0);
    expect(result(r.stderr)).toEqual({ a: 'one', b: 'two', c: 'three', closed: false });
  });
  it('sets closed on EOF without hanging or a stack trace', () => {
    const r = spawnSync('node', [bundle], { stdio: [openSync('/dev/null', 'r'), 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000 });
    expect(r.signal).toBeNull();
    expect(result(r.stderr)).toEqual({ a: '', b: '', c: '', closed: true });
    expect(r.stderr).not.toMatch(/AbortError|\n\s+at /);
  });
  it('keeps answers given before EOF', () => {
    const r = run('only\n');
    expect(result(r.stderr)).toEqual({ a: 'only', b: '', c: '', closed: true });
  });
  it.skipIf(spawnSync('python3', ['-c', 'import pty']).status !== 0)('Ctrl+C in a pty ends cleanly', async () => {
    const py = `import pty,os,sys,time,select
pid,fd=pty.fork()
if pid==0:
    os.execvp('node',['node',sys.argv[1]])
time.sleep(1.0)
os.write(fd,b'\\x03')
out=b''
end=time.time()+4
while time.time()<end:
    r,_,_=select.select([fd],[],[],0.2)
    if r:
        try:
            d=os.read(fd,4096)
        except OSError:
            break
        if not d: break
        out+=d
_,st=os.waitpid(pid,0)
sys.stdout.write(out.decode('utf8','replace'))
sys.exit(0 if os.WIFEXITED(st) else 1)`;
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const c = spawn('python3', ['-I', '-c', py, bundle]);
      let text = '';
      c.stdout.on('data', (d) => { text += d; });
      c.on('close', (code) => resolve({ code, text }));
    });
    expect(out.code).toBe(0);
    expect(out.text).not.toMatch(/AbortError|\n\s+at /);
    expect(out.text).toContain('"closed":true');
  }, 10000);
});
