import { describe, expect, it } from 'vitest';
import { LocalFolderScanner } from '../../../src/connectors/local-files/scanner.js';
import type { LocalFolderScannerOptions } from '../../../src/connectors/local-files/scanner.js';
import type { FileRules } from '../../../src/core/files/filter.js';
import { DEFAULT_FILE_RULES } from '../../../src/core/files/filter.js';
import type { ProcessRunner, RunResult } from '../../../src/core/process/types.js';
import { FakeLocalFs, captureLogger } from './helpers.js';

const HOME = '/home/me';
const DOCS = '/home/me/Documents';

function rules(overrides: Partial<FileRules> = {}): FileRules {
  return { ...DEFAULT_FILE_RULES, ...overrides };
}

function ok(stdout = ''): RunResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

function scanner(fs: FakeLocalFs, overrides: Partial<LocalFolderScannerOptions> = {}): LocalFolderScanner {
  const run: ProcessRunner = async () => ok();
  return new LocalFolderScanner({
    fs,
    run,
    rules: rules(),
    home: HOME,
    log: captureLogger(),
    maxEntries: 100,
    maxDepth: 4,
    ...overrides,
  });
}

describe('LocalFolderScanner.open', () => {
  it('expands and dedupes roots, then walks with display paths', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/note.md`, 'hello', 1_000);
    const scan = scanner(fs).open(['~/Documents', DOCS]);

    const result = await scan.walk();

    expect(result.files.map((file) => file.path)).toEqual(['~/Documents/note.md']);
    expect(result.files[0]?.id).toBe(`${DOCS}/note.md`);
  });

  it('skips folders that are relative or cannot be resolved', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/note.md`, 'hello', 1_000);
    const log = captureLogger();
    const scan = scanner(fs, { log }).open(['relative/path', '/home/me/Missing', '~/Documents']);

    const result = await scan.walk();

    expect(result.files.map((file) => file.path)).toEqual(['~/Documents/note.md']);
    expect(log.warnings).toContain('folder-scan: a folder is not an absolute path');
    expect(log.warnings).toContain('folder-scan: a folder could not be opened');
  });

  it('reports nothing when no folder is known', async () => {
    const scan = scanner(new FakeLocalFs()).open([]);

    await expect(scan.walk()).resolves.toEqual({ files: [], repos: [], truncated: false });
  });
});

describe('LocalFolderScanner.excerpt', () => {
  it('reads a readable file up to the byte cap', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/note.md`, 'hello world', 1_000);
    const scan = scanner(fs).open(['~/Documents']);

    await expect(scan.excerpt(`${DOCS}/note.md`, 5)).resolves.toBe('hello');
    await expect(scan.excerpt(`${DOCS}/note.md`, 100_000)).resolves.toBe('hello world');
  });

  it('caps the read at the rule size', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/note.md`, '0123', 1_000);
    const scan = scanner(fs, { rules: rules({ maxBytes: 4 }) }).open(['~/Documents']);

    await expect(scan.excerpt(`${DOCS}/note.md`, 100)).resolves.toBe('0123');
  });

  it('refuses symlinks, files outside the roots and sensitive or disallowed files', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/note.md`, 'hello', 1_000)
      .addFile(`${DOCS}/.env`, 'SECRET=1', 1_000)
      .addFile(`${DOCS}/big.md`, 'x'.repeat(50), 1_000)
      .addFile('/home/me/Outside/secret.md', 'outside', 1_000)
      .addSymlink(`${DOCS}/link.md`, `${DOCS}/note.md`, 1_000);
    const scan = scanner(fs, { rules: rules({ maxBytes: 10 }) }).open(['~/Documents']);

    await expect(scan.excerpt(`${DOCS}/link.md`, 10)).rejects.toThrow(/symlink/i);
    await expect(scan.excerpt('/home/me/Outside/secret.md', 10)).rejects.toThrow(/outside/i);
    await expect(scan.excerpt(`${DOCS}/.env`, 10)).rejects.toThrow(/rules/i);
    await expect(scan.excerpt(`${DOCS}/big.md`, 10)).rejects.toThrow(/rules/i);
  });
});

describe('LocalFolderScanner.repo', () => {
  const REPO = `${DOCS}/app`;

  function repoFs(): FakeLocalFs {
    return new FakeLocalFs()
      .addFile(`${REPO}/README.md`, 'readme', 1_000)
      .addFile(`${REPO}/src/main.ts`, 'main', 1_000)
      .addDir(`${REPO}/.git`, 1_000)
      .addFile(`${DOCS}/plain/note.md`, 'note', 1_000);
  }

  it('reads details for a repository inside a root', async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (_cmd, args) => {
      calls.push([...args]);
      if (args.includes('log')) return ok('2026-11-17T05:00:00Z\x1fhello');
      if (args.includes('ls-files')) return ok('src/main.ts\0');
      return ok();
    };
    const scan = scanner(repoFs(), { run }).open(['~/Documents']);

    const details = await scan.repo(REPO);

    expect(details.readme).toBe('readme');
    expect(details.commits).toEqual([{ at: '2026-11-17T05:00:00Z', subject: 'hello' }]);
    expect(details.languages).toEqual([{ ext: 'ts', files: 1 }]);
    expect(calls.find((args) => args.includes('log'))).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      REPO,
      'log',
      '-n15',
      '--no-merges',
      '--format=%cI%x1f%s',
    ]);
  });

  it('refuses folders outside the roots and non-repositories', async () => {
    const fs = repoFs().addFile('/home/me/Outside/other.md', 'x', 1_000);
    const scan = scanner(fs).open(['~/Documents']);

    await expect(scan.repo('/home/me/Outside/other.md')).rejects.toThrow(/outside/i);
    await expect(scan.repo(`${DOCS}/plain`)).rejects.toThrow(/repository/i);
  });
});
