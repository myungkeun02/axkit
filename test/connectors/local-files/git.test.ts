import { describe, expect, it } from 'vitest';
import { readRepo } from '../../../src/connectors/local-files/git.js';
import { FakeLocalFs, captureLogger } from './helpers.js';
import { DEFAULT_FILE_RULES } from '../../../src/core/files/filter.js';
import type { FileRules } from '../../../src/core/files/filter.js';
import type { ProcessRunner, RunOptions, RunResult } from '../../../src/core/process/types.js';

const REPO = '/home/me/Code/app';
const TOKEN = 'sk-abcdefghijklmnopqrstuvwx';
const OPTIONS = { commits: 15, readmeBytes: 4_000, rules: DEFAULT_FILE_RULES };

interface Call {
  cmd: string;
  args: readonly string[];
  opts: RunOptions;
}

function ok(stdout: string): RunResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

function failing(): RunResult {
  return { code: 128, stdout: '', stderr: 'fatal', timedOut: false };
}

function runner(
  handler: (args: readonly string[]) => RunResult | Promise<RunResult>,
): { run: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: ProcessRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return await handler(args);
  };
  return { run, calls };
}

function isLog(args: readonly string[]): boolean {
  return args.includes('log');
}

function isList(args: readonly string[]): boolean {
  return args.includes('ls-files');
}

function readmeFs(): FakeLocalFs {
  return new FakeLocalFs()
    .addFile(`${REPO}/README.md`, `hello\n${TOKEN}`, 1_000)
    .addFile(`${REPO}/src/app.ts`, 'x', 1_000)
    .addFile(`${REPO}/src/util.ts`, 'x', 1_000)
    .addFile(`${REPO}/notes.txt`, 'x', 1_000)
    .addFile(`${REPO}/Makefile`, 'x', 1_000)
    .addFile(`${REPO}/id_rsa`, 'x', 1_000);
}

function rules(overrides: Partial<FileRules> = {}): FileRules {
  return { ...DEFAULT_FILE_RULES, ...overrides };
}

describe('readRepo', () => {
  it('reads and masks the readme, parses commits and counts languages', async () => {
    const fs = readmeFs();
    const { run, calls } = runner((args) => {
      if (isLog(args)) {
        return ok(
          '2026-11-17T05:00:00+09:00\x1ffix: drop the old token\n2026-11-16T09:00:00+09:00\x1fadd files',
        );
      }
      if (isList(args)) return ok('src/app.ts\0src/util.ts\0notes.txt\0Makefile\0id_rsa\0');
      return failing();
    });

    const details = await readRepo({ fs, run, log: captureLogger() }, REPO, OPTIONS);

    expect(details.readme).toContain('[masked]');
    expect(details.readme).not.toContain(TOKEN);
    expect(details.commits).toEqual([
      { at: '2026-11-17T05:00:00+09:00', subject: 'fix: drop the old token' },
      { at: '2026-11-16T09:00:00+09:00', subject: 'add files' },
    ]);
    expect(details.languages).toEqual([
      { ext: 'ts', files: 2 },
      { ext: 'txt', files: 1 },
    ]);

    const logCall = calls.find((call) => isLog(call.args));
    expect(logCall?.cmd).toBe('git');
    expect(logCall?.args).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      REPO, 'log', '-n15', '--no-merges', '--format=%cI%x1f%s']);
    expect(logCall?.opts.env).toEqual({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
    expect(logCall?.opts.timeoutMs).toBe(10_000);
  });

  it('masks token-like subjects and truncates them to 200 characters', async () => {
    const long = `${'word '.repeat(60)}${TOKEN}`;
    const fs = new FakeLocalFs().addFile(`${REPO}/README`, 'readme', 1_000);
    const { run } = runner((args) => (isLog(args) ? ok(`2026-11-17T05:00:00Z\x1f${long}`) : ok('')));

    const details = await readRepo({ fs, run, log: captureLogger() }, REPO, OPTIONS);

    expect(details.commits[0]?.subject).toHaveLength(200);
    expect(details.commits[0]?.subject).not.toContain(TOKEN);
    expect(details.readme).toBe('readme');
  });

  it('caps the readme at readmeBytes', async () => {
    const fs = new FakeLocalFs().addFile(`${REPO}/readme.markdown`, 'abcdefghijklmnop', 1_000);
    const { run } = runner(() => ok(''));

    const details = await readRepo({ fs, run, log: captureLogger() }, REPO, {
      commits: 1,
      readmeBytes: 10,
      rules: DEFAULT_FILE_RULES,
    });

    expect(details.readme).toBe('abcdefghij');
  });

  it('ignores a readme that is a symlink and leaves the key out', async () => {
    const fs = new FakeLocalFs()
      .addFile('/home/me/Outside/notes.md', 'outside', 1_000)
      .addSymlink(`${REPO}/README.md`, '/home/me/Outside/notes.md', 1_000);
    const { run } = runner(() => ok(''));

    const details = await readRepo({ fs, run, log: captureLogger() }, REPO, OPTIONS);

    expect(details).not.toHaveProperty('readme');
  });

  it('returns no commits or languages when git fails', async () => {
    const fs = new FakeLocalFs().addFile(`${REPO}/a.ts`, 'x', 1_000);
    const nonzero = runner(() => failing());
    const thrown: ProcessRunner = async () => {
      throw new Error('ENOENT');
    };

    const failed = await readRepo({ fs, run: nonzero.run, log: captureLogger() }, REPO, OPTIONS);
    expect(failed).toMatchObject({ commits: [], languages: [] });

    const missing = await readRepo({ fs, run: thrown, log: captureLogger() }, REPO, OPTIONS);
    expect(missing).toMatchObject({ commits: [], languages: [] });
  });

  it('drops sensitive paths from the language counts', async () => {
    const fs = new FakeLocalFs().addFile(`${REPO}/a.ts`, 'x', 1_000);
    const { run } = runner((args) =>
      isList(args) ? ok('a.ts\0.env\0secret/id_rsa\0docs/guide.md\0') : ok(''),
    );

    const details = await readRepo({ fs, run, log: captureLogger() }, REPO, {
      ...OPTIONS,
      rules: rules({ exclude: ['guide'] }),
    });

    expect(details.languages).toEqual([{ ext: 'ts', files: 1 }]);
  });

  it('keeps at most eight languages, largest first then by extension', async () => {
    const names = ['a.ts', 'b.ts', 'c.md', 'd.md', 'e.py', 'f.go', 'g.rs', 'h.rb', 'i.c', 'j.java', 'k.csv'];
    const fs = new FakeLocalFs().addFile(`${REPO}/a.ts`, 'x', 1_000);
    const { run } = runner((args) => (isList(args) ? ok(`${names.join('\0')}\0`) : ok('')));

    const details = await readRepo({ fs, run, log: captureLogger() }, REPO, OPTIONS);

    expect(details.languages).toHaveLength(8);
    expect(details.languages.slice(0, 2)).toEqual([
      { ext: 'md', files: 2 },
      { ext: 'ts', files: 2 },
    ]);
  });
});
