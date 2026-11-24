import { describe, expect, it } from 'vitest';
import { DEFAULT_FILE_RULES } from '../../../src/core/files/filter.js';
import type { FileRules } from '../../../src/core/files/filter.js';
import { LocalFilesSource } from '../../../src/connectors/local-files/source.js';
import { FakeLocalFs, captureLogger } from './helpers.js';

const HOME = '/home/me';
const DOCS = '/home/me/Documents';

function rules(overrides: Partial<FileRules> = {}): FileRules {
  return { ...DEFAULT_FILE_RULES, ...overrides };
}

function source(fs: FakeLocalFs, overrides: Partial<FileRules> = {}, includeHidden = false): LocalFilesSource {
  return new LocalFilesSource({
    fs,
    folders: [DOCS],
    rules: rules(overrides),
    includeHidden,
    home: HOME,
    log: captureLogger(),
  });
}

describe('LocalFilesSource.list', () => {
  it('lists allowed text files newest first with display paths', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/a.md`, 'a', 1_000)
      .addFile(`${DOCS}/b.txt`, 'b', 2_000)
      .addFile(`${DOCS}/old.txt`, 'old', 500)
      .addFile(`${DOCS}/image.png`, 'png', 3_000)
      .addFile(`${DOCS}/big.txt`, 'x'.repeat(20), 3_500)
      .addFile(`${DOCS}/.hidden.md`, 'hidden', 4_000)
      .addFile(`${DOCS}/secret-note.md`, 'secret', 4_500)
      .addFile(`${DOCS}/sub/c.md`, 'c', 5_000);

    const listed = await source(fs, { extensions: ['md', 'txt'], maxBytes: 10, exclude: ['secret'] }).list({
      limit: 10,
    });

    expect(listed.map((entry) => entry.path)).toEqual([
      'Documents/sub/c.md',
      'Documents/b.txt',
      'Documents/a.md',
      'Documents/old.txt',
    ]);
    expect(listed[0]).toMatchObject({ id: `${DOCS}/sub/c.md`, name: 'c.md', size: 1 });
    expect(listed[0]?.modifiedAt).toBe(new Date(5_000).toISOString());
  });

  it('never lists sensitive names, even hidden ones when hidden files are on', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/.env`, 'KEY=1', 1_000)
      .addFile(`${DOCS}/id_rsa`, 'key', 1_000)
      .addFile(`${DOCS}/비밀번호.txt`, 'pw', 1_000)
      .addFile(`${DOCS}/.ssh/config`, 'host', 1_000)
      .addFile(`${DOCS}/.notes.md`, 'notes', 1_000)
      .addFile(`${DOCS}/safe.md`, 'safe', 1_000);

    const listed = await source(fs, {}, true).list({ limit: 10 });

    expect(listed.map((entry) => entry.path)).toEqual(['Documents/.notes.md', 'Documents/safe.md']);
  });

  it('applies modifiedAfter and the limit after sorting', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/a.md`, 'a', 1_000)
      .addFile(`${DOCS}/b.md`, 'b', 2_000)
      .addFile(`${DOCS}/c.md`, 'c', 3_000);

    const after = await source(fs).list({ modifiedAfter: new Date(1_500), limit: 10 });
    expect(after.map((entry) => entry.name)).toEqual(['c.md', 'b.md']);

    const limited = await source(fs).list({ limit: 1 });
    expect(limited.map((entry) => entry.name)).toEqual(['c.md']);
    expect(await source(fs).list({ limit: 0 })).toEqual([]);
  });

  it('stops at six folder levels', async () => {
    const nest = (depth: number): string => `${DOCS}/${Array.from({ length: depth }, (_, index) => `d${index + 1}`).join('/')}`;
    const fs = new FakeLocalFs()
      .addFile(`${nest(6)}/ok.md`, 'ok', 1_000)
      .addFile(`${nest(7)}/deep.md`, 'deep', 1_000);

    const listed = await source(fs).list({ limit: 10 });

    expect(listed.map((entry) => entry.path)).toEqual(['Documents/d1/d2/d3/d4/d5/d6/ok.md']);
  });

  it('skips symlinks and folders that point outside the root', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/a.md`, 'a', 1_000)
      .addSymlink(`${DOCS}/link.md`, `${DOCS}/a.md`, 2_000)
      .addFile('/home/me/Outside/secret.md', 'outside', 3_000)
      .addSymlink(`${DOCS}/escape`, '/home/me/Outside', 3_000);

    const listed = await source(fs).list({ limit: 10 });

    expect(listed.map((entry) => entry.name)).toEqual(['a.md']);
  });
});

describe('LocalFilesSource.readText', () => {
  it('reads at most maxBytes and caps at the rule size', async () => {
    const fs = new FakeLocalFs().addFile(`${DOCS}/note.md`, 'hello world', 1_000);
    const local = source(fs, {}, false);

    await expect(local.readText(`${DOCS}/note.md`, 5)).resolves.toBe('hello');
    await expect(local.readText(`${DOCS}/note.md`, 100_000)).resolves.toBe('hello world');
  });

  it('refuses symlinks and files outside every configured folder', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/a.md`, 'a', 1_000)
      .addSymlink(`${DOCS}/link.md`, `${DOCS}/a.md`, 1_000)
      .addFile('/home/me/Outside/secret.md', 'outside', 1_000);

    const local = source(fs);

    await expect(local.readText(`${DOCS}/link.md`, 10)).rejects.toThrow(/symlink/i);
    await expect(local.readText('/home/me/Outside/secret.md', 10)).rejects.toThrow(/outside/i);
  });

  it('applies the file rules again at read time', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/.env`, 'SECRET=1', 1_000)
      .addFile(`${DOCS}/big.md`, 'x'.repeat(50), 1_000);

    const local = source(fs, { maxBytes: 10 });

    await expect(local.readText(`${DOCS}/.env`, 10)).rejects.toThrow(/rules/i);
    await expect(local.readText(`${DOCS}/big.md`, 10)).rejects.toThrow(/rules/i);
  });

  it('skips a configured folder that cannot be opened', async () => {
    const fs = new FakeLocalFs();
    const log = captureLogger();
    const local = new LocalFilesSource({
      fs,
      folders: ['/home/me/Missing', DOCS],
      rules: rules(),
      includeHidden: false,
      home: HOME,
      log,
    });

    await expect(local.list({ limit: 10 })).resolves.toEqual([]);
    expect(log.warnings).toContain('local-files: a configured folder could not be opened');
  });
});
