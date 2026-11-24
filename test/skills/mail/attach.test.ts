import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mimeOf, readAttachments } from '../../../src/skills/mail/attach.js';

describe('reading files to attach', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ax-att-'));
    await mkdir(join(home, 'Documents'));
    await mkdir(join(home, '.ssh'));
    await writeFile(join(home, 'Documents', 'deck.pdf'), 'pdf');
    await writeFile(join(home, '.ssh', 'id_rsa'), 'secret');
    await symlink(join(home, '.ssh', 'id_rsa'), join(home, 'Documents', 'link.pdf'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('reads home files and refuses hidden folders, links and paths outside home', async () => {
    const [file] = await readAttachments(['~/Documents/deck.pdf'], home);
    expect(file).toMatchObject({ filename: 'deck.pdf', mimeType: 'application/pdf' });
    await expect(readAttachments(['~/.ssh/id_rsa'], home)).rejects.toThrow();
    await expect(readAttachments(['~/Documents/link.pdf'], home)).rejects.toThrow('Not a plain file');
    await expect(readAttachments(['/etc/hosts'], home)).rejects.toThrow('~/');
    await expect(readAttachments(['~/../x'], home)).rejects.toThrow();
    expect(mimeOf('a.HWP')).toBe('application/x-hwp');
  });
});
