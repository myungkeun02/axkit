import { describe, expect, it } from 'vitest';
import { shortcutsAvailable, signShortcut, type Exec, type ExecResult } from '../../../src/mobile/files/sign.js';

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const PATHS = {
  xmlPath: '/tmp/location.plist',
  binPath: '/tmp/location.unsigned.shortcut',
  signedPath: '/tmp/location.shortcut',
};

interface Call {
  cmd: string;
  args: string[];
}

function fakeExec(results: ExecResult[]): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const result = results.shift();
    if (result === undefined) throw new Error(`unexpected call to ${cmd}`);
    return result;
  };
  return { exec, calls };
}

describe('signShortcut', () => {
  it('converts to binary1 and signs with the exact plutil and shortcuts arguments', async () => {
    const { exec, calls } = fakeExec([OK, OK]);

    await signShortcut({ exec, ...PATHS });

    expect(calls).toEqual([
      { cmd: 'plutil', args: ['-convert', 'binary1', '-o', PATHS.binPath, PATHS.xmlPath] },
      {
        cmd: 'shortcuts',
        args: ['sign', '--mode', 'anyone', '--input', PATHS.binPath, '--output', PATHS.signedPath],
      },
    ]);
  });

  it('stops before signing when plutil fails', async () => {
    const { exec, calls } = fakeExec([{ code: 1, stdout: '', stderr: 'bad plist' }]);

    await expect(signShortcut({ exec, ...PATHS })).rejects.toThrow(/plutil failed.*bad plist/);
    expect(calls).toHaveLength(1);
  });

  it('surfaces signing failures with the iCloud alternative', async () => {
    const { exec } = fakeExec([OK, { code: 1, stdout: '', stderr: 'not signed in' }]);

    await expect(signShortcut({ exec, ...PATHS })).rejects.toThrow(/shortcuts sign failed.*not signed in/);
    await expect(signShortcut({ exec: fakeExec([OK, { code: 1, stdout: '', stderr: 'x' }]).exec, ...PATHS })).rejects.toThrow(
      /signed in to iCloud/,
    );
    await expect(signShortcut({ exec: fakeExec([OK, { code: 1, stdout: '', stderr: 'x' }]).exec, ...PATHS })).rejects.toThrow(
      /iCloud link route/,
    );
  });

  it('falls back to stdout when stderr is empty', async () => {
    const { exec } = fakeExec([OK, { code: 2, stdout: 'denied', stderr: '' }]);

    await expect(signShortcut({ exec, ...PATHS })).rejects.toThrow(/denied/);
  });
});

describe('shortcutsAvailable', () => {
  it('is true when the command exits zero', async () => {
    const { exec, calls } = fakeExec([OK]);

    await expect(shortcutsAvailable(exec)).resolves.toBe(true);
    expect(calls).toEqual([{ cmd: 'shortcuts', args: ['--help'] }]);
  });

  it('is false for a non-zero exit or a spawn error', async () => {
    const failing = fakeExec([{ code: 1, stdout: '', stderr: 'unknown command' }]);
    const missing: Exec = async () => {
      throw new Error('spawn shortcuts ENOENT');
    };

    await expect(shortcutsAvailable(failing.exec)).resolves.toBe(false);
    await expect(shortcutsAvailable(missing)).resolves.toBe(false);
  });
});
