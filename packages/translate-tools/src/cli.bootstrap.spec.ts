import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('cli entry', () => {
  let dir: string;
  let stderr: string[];
  const argv = process.argv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmtranslate-bin-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src/ns.ts'),
      `export const a = createNamespace('a', { x: 'X' });`,
    );
    fs.writeFileSync(
      path.join(dir, 'src/reg.ts'),
      `registerNamespace(() => import('./ns').then((m) => m.a.translation), {});`,
    );
    stderr = [];
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const level of ['warn', 'error'] as const)
      vi.spyOn(console, level).mockImplementation((m: unknown) => {
        stderr.push(String(m));
      });
  });

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runCli = async (...args: string[]) => {
    process.argv = ['node', 'mmtranslate', ...args];
    vi.resetModules();
    await import('./cli');
    return process.exitCode;
  };

  it('runs the command from process.argv in process.cwd()', async () => {
    expect(await runCli('export', '--out', 'i18n')).toBe(0);
    expect(fs.existsSync(path.join(dir, 'i18n/a.en.json'))).toBe(true);
  });

  it('sets a non-zero exit code on failure', async () => {
    expect(await runCli('export', '--out')).toBe(1);
    expect(stderr.join('\n')).toContain('Missing value for --out');
  });

  it('prints usage for an inherited object key', async () => {
    expect(await runCli('constructor')).toBe(1);
    expect(stderr.join('\n')).toContain('Usage: mmtranslate');
  });
});
