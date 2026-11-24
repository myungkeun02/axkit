import { describe, expect, it } from 'vitest';
import { DocWriter, safeFileName } from '../../../src/skills/knowledge/writer.js';
import { MemoryDocFs } from './helpers.js';

const ROOT = '/kb';
const AT = '2026-11-17 09:00 (Asia/Seoul)';

function createWriter() {
  const fs = new MemoryDocFs();
  return { fs, writer: new DocWriter(ROOT, fs) };
}

const render = (stamp: string): string => `# Doc\n\n> 1줄 · 갱신 ${stamp}\n`;

describe('safeFileName', () => {
  it('keeps one safe segment and never returns an empty name', () => {
    expect(safeFileName('  ..a/b:c  ')).toBe('a b c');
    expect(safeFileName('')).toBe('untitled');
    expect(safeFileName('...')).toBe('untitled');
    expect(safeFileName('a\nb')).toBe('a b');
    expect(safeFileName('x'.repeat(100))).toHaveLength(60);
  });
});

describe('writeStable', () => {
  it('creates directories and files with private modes', async () => {
    const { fs, writer } = createWriter();

    expect(await writer.writeStable('notes/a.md', render, AT)).toBe(true);

    expect(fs.dirs).toContainEqual({ path: '/kb/notes', mode: 0o700 });
    expect(fs.writes).toContainEqual({ path: '/kb/notes/a.md.tmp', mode: 0o600 });
    expect(fs.chmods).toContainEqual({ path: '/kb/notes/a.md', mode: 0o600 });
    expect(fs.files.get('/kb/notes/a.md')).toBe(render(AT));
  });

  it('keeps the file untouched when a rerender with its own stamp is identical', async () => {
    const { fs, writer } = createWriter();
    await writer.writeStable('notes/a.md', render, AT);
    const writes = fs.writes.length;

    expect(await writer.writeStable('notes/a.md', render, '2026-11-18 09:00 (Asia/Seoul)')).toBe(false);

    expect(fs.writes).toHaveLength(writes);
    expect(fs.files.get('/kb/notes/a.md')).toBe(render(AT));
  });

  it('rewrites when the rendered content really changed', async () => {
    const { fs, writer } = createWriter();
    await writer.writeStable('notes/a.md', render, AT);

    expect(await writer.writeStable('notes/a.md', (stamp) => `# Doc\n\n> 2줄 · 갱신 ${stamp}\n`, AT)).toBe(true);

    expect(fs.files.get('/kb/notes/a.md')).toContain('2줄');
  });

  it('refuses paths that escape the root', async () => {
    const { writer } = createWriter();

    await expect(writer.writeStable('../evil.md', render, AT)).rejects.toThrow(/escapes/);
    await expect(writer.writeStable('/tmp/evil.md', render, AT)).rejects.toThrow(/escapes/);
  });
});

describe('writeText and remove', () => {
  it('writes only on change and removes existing files', async () => {
    const { fs, writer } = createWriter();

    expect(await writer.writeText('README.md', 'one')).toBe(true);
    expect(await writer.writeText('README.md', 'one')).toBe(false);
    expect(await writer.remove('README.md')).toBe(true);
    expect(await writer.remove('README.md')).toBe(false);
    expect(fs.removed).toEqual(['/kb/README.md']);
  });
});
