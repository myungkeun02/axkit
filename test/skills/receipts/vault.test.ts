import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeName, Vault } from '../../../src/skills/receipts/vault.js';
import { FakeVaultFs } from './helpers.js';

describe('safeName', () => {
  it('removes path separators, colons and control characters', () => {
    expect(safeName('a/b\\c:d')).toBe('a b c d');
    expect(safeName('\u0000bad\u0001name')).toBe('bad name');
  });

  it('removes leading dots, collapses spaces and caps at 60 characters', () => {
    expect(safeName('..hidden')).toBe('hidden');
    expect(safeName('  many   spaces  ')).toBe('many spaces');
    expect(safeName('가'.repeat(80))).toHaveLength(60);
  });
});

describe('Vault', () => {
  it('writes a document folder with 0700 directories and 0600 files', async () => {
    const fs = new FakeVaultFs();
    const vault = new Vault({ vaultDir: '/vault', fs });

    const files = await vault.writeDoc('2026-11-17', 'receipt', '카페 영수증', 'mail-1234567890', [
      { name: 'mail.txt', data: 'hello' },
    ]);

    expect(files).toEqual(['2026-11/2026-11-17-receipt-카페 영수증-mail-123/mail.txt']);
    const dir = path.join('/vault', '2026-11', '2026-11-17-receipt-카페 영수증-mail-123');
    const file = path.join(dir, 'mail.txt');
    expect(fs.calls).toEqual([
      { op: 'mkdir', path: dir, mode: 0o700 },
      { op: 'chmod', path: '/vault', mode: 0o700 },
      { op: 'chmod', path: path.join('/vault', '2026-11'), mode: 0o700 },
      { op: 'chmod', path: dir, mode: 0o700 },
      { op: 'writeFile', path: file, mode: 0o600 },
      { op: 'chmod', path: file, mode: 0o600 },
    ]);
    expect(fs.files.get(file)).toBe('hello');
  });

  it('keeps every written path under the root even for traversal-looking names', async () => {
    const fs = new FakeVaultFs();
    const vault = new Vault({ vaultDir: '/vault', fs });

    await vault.writeDoc('2026-11-17', 'receipt', '../../etc', '../../../etc/passwd', [
      { name: '../../evil', data: 'x' },
    ]);

    expect(fs.calls.length).toBeGreaterThan(0);
    for (const call of fs.calls) {
      expect(call.path === '/vault' || call.path.startsWith('/vault/')).toBe(true);
      expect(call.path).not.toContain('..');
    }
    expect([...fs.files.keys()].every((target) => target.startsWith('/vault/'))).toBe(true);
  });

  it('resolves a real file path inside the root', async () => {
    const fs = new FakeVaultFs().addFile('/vault/2026-11/doc/receipt.pdf');
    const vault = new Vault({ vaultDir: '/vault', fs });

    await expect(vault.realFileOf('2026-11/doc/receipt.pdf')).resolves.toBe('/vault/2026-11/doc/receipt.pdf');
  });

  it('refuses paths that leave the root, literally or through a symlink', async () => {
    const fs = new FakeVaultFs()
      .addFile('/vault/doc.pdf')
      .addFile('/outside/secret.pdf')
      .addSymlink('/vault/link.pdf', '/outside/secret.pdf');
    const vault = new Vault({ vaultDir: '/vault', fs });

    await expect(vault.realFileOf('../outside/secret.pdf')).rejects.toThrow('outside the vault');
    await expect(vault.realFileOf('/etc/passwd')).rejects.toThrow('outside the vault');
    await expect(vault.realFileOf('link.pdf')).rejects.toThrow('outside the vault');
  });

  it('follows a symlink that stays inside the root', async () => {
    const fs = new FakeVaultFs().addFile('/vault/doc.pdf').addSymlink('/vault/alias.pdf', '/vault/doc.pdf');
    const vault = new Vault({ vaultDir: '/vault', fs });

    await expect(vault.realFileOf('alias.pdf')).resolves.toBe('/vault/doc.pdf');
  });

  it('is index-only when no root is configured', async () => {
    const fs = new FakeVaultFs();
    const vault = new Vault({ fs });

    expect(vault.enabled).toBe(false);
    await expect(vault.writeDoc('2026-11-17', 'receipt', 's', 'm', [{ name: 'mail.txt', data: 'x' }])).resolves.toEqual(
      [],
    );
    expect(fs.calls).toEqual([]);
  });
});
