import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIosShortcuts } from '../../../src/mobile/files/ios-shortcut.js';
import { signShortcut, type Exec } from '../../../src/mobile/files/sign.js';

const realExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
      resolve({ code, stdout, stderr });
    });
  });

describe.skipIf(process.env.AX_KIT_REAL_SIGN !== '1')('signShortcut with the real macOS commands', () => {
  it('signs the location shortcut into an AEA1 archive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ax-kit-sign-'));
    try {
      const location = buildIosShortcuts({
        assistantName: '테스트',
        url: 'https://example.com/m/v1/ingest',
        token: 'test-token',
      }).find((shortcut) => shortcut.kind === 'location');
      if (location === undefined) throw new Error('location shortcut was not built');

      const xmlPath = join(dir, 'location.plist');
      const binPath = join(dir, 'location.unsigned.shortcut');
      const signedPath = join(dir, 'location.shortcut');
      await writeFile(xmlPath, location.plistXml, 'utf8');

      await signShortcut({ exec: realExec, xmlPath, binPath, signedPath });

      const signed = await readFile(signedPath);
      expect(signed.subarray(0, 4).toString('latin1')).toBe('AEA1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
