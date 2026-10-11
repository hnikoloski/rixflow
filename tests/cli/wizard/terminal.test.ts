import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let bundle = '';
let hidden = '';
let tmp = '';
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'tio-'));
  tmp = dir;
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
  const entry2 = join(dir, 'hidden.ts');
  writeFileSync(entry2, `import { terminalIo } from ${JSON.stringify(join(process.cwd(), 'src/cli/init.ts'))};
(async () => {
  const io = terminalIo();
  const s = await io.askHidden('SECRET> ');
  const h = await io.ask('PLAIN> ');
  process.stdout.write('RESULT ' + JSON.stringify({ ok: s === 'SECRETPW', h, closed: io.closed }) + '\\n');
})();`);
  hidden = join(dir, 'hidden.cjs');
  buildSync({ entryPoints: [entry2], bundle: true, platform: 'node', format: 'cjs', outfile: hidden, logLevel: 'silent' });
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
  const hasPty = spawnSync('python3', ['-c', 'import pty']).status === 0;
  // steps: [waitForText, keysToSend]; keys are sent only after the text shows up in the pty output.
  const pty = (script: string, steps: Array<[string, string]>) => new Promise<{ code: number | null; text: string }>((resolve) => {
    const py = `import pty,os,sys,time,select,json
script=sys.argv[1]; steps=json.loads(sys.argv[2])
pid,fd=pty.fork()
if pid==0:
    os.execvp('node',['node',script])
out=b''; eof=False
def pump(until,limit):
    global out,eof
    end=time.time()+limit
    while time.time()<end and not eof and (until is None or until.encode() not in out):
        r,_,_=select.select([fd],[],[],0.1)
        if r:
            try: d=os.read(fd,4096)
            except OSError: eof=True; break
            if not d: eof=True; break
            out+=d
for wait,keys in steps:
    pump(wait,5)
    if eof: break
    time.sleep(0.1)
    os.write(fd,keys.encode())
    out+=b'\\n<<SENT>>\\n'
pump(None,1.5)
_,st=os.waitpid(pid,0)
sys.stdout.write(out.decode('utf8','replace'))
sys.exit(0 if os.WIFEXITED(st) else 1)`;
    const c = spawn('python3', ['-I', '-c', py, script, JSON.stringify(steps)]);
    let text = '';
    c.stdout.on('data', (d) => { text += d; });
    c.on('close', (code) => resolve({ code, text }));
  });

  it.skipIf(!hasPty)('hidden input is not echoed and echo returns afterwards', async () => {
    const out = await pty(hidden, [['SECRET> ', 'SECRETPW\r'], ['PLAIN> ', 'hello\r']]);
    expect(out.code).toBe(0);
    expect(out.text).not.toContain('SECRETPW');
    expect(out.text).toContain('hello');
    expect(out.text).toContain('"ok":true');
  }, 15000);
  it.skipIf(!hasPty)('Ctrl+C at a hidden prompt ends cleanly', async () => {
    const out = await pty(hidden, [['SECRET> ', '\x03']]);
    expect(out.code).toBe(0);
    expect(out.text).not.toMatch(/AbortError|\n\s+at /);
  }, 15000);
  it.skipIf(!hasPty)('Ctrl+C at a normal prompt ends cleanly', async () => {
    const out = await pty(bundle, [['A? ', '\x03']]);
    expect(out.code).toBe(0);
    expect(out.text).not.toMatch(/AbortError|\n\s+at /);
    expect(out.text).toContain('"closed":true');
  }, 15000);
});
