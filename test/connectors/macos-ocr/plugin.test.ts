import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { macosOcrConnector, ocrCheck } from '../../../src/connectors/macos-ocr/plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { ProcessRunner, RunResult } from '../../../src/core/process/types.js';
import { createTestContext } from '../../support/context.js';

function runnerReturning(result: RunResult): { run: ProcessRunner; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: ProcessRunner = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    return result;
  };
  return { run, calls };
}

const recognized = (text: string): RunResult => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, method: 'vision', pages: 1, text }),
  stderr: '',
  timedOut: false,
});

describe('macosOcrConnector', () => {
  it('declares the connector identity', () => {
    const plugin = macosOcrConnector();
    expect(plugin.manifest).toEqual({
      id: 'connector.macos-ocr',
      kind: 'connector',
      title: 'Text recognition on this Mac (Vision)',
    });
  });

  it('provides the ocr capability backed by the given helper path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ax-kit-ocr-test-'));
    try {
      const image = join(dir, 'receipt.png');
      await writeFile(image, new Uint8Array([1, 2, 3]));
      const { run, calls } = runnerReturning(recognized('합계 12,500원'));
      const { ctx } = createTestContext();
      await macosOcrConnector({ run, helperPath: async () => '/bin/ax-ocr' }).setup(ctx);

      const result = await ctx.use(Contracts.ocr).recognize(image);

      expect(result).toEqual({ method: 'vision', pages: 1, text: '합계 12,500원' });
      expect(calls).toEqual([{ cmd: '/bin/ax-ocr', args: [image, '--languages', 'ko-KR,en-US', '--max-pages', '10'] }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ocrCheck', () => {
  it('passes when swiftc reports its version', async () => {
    const { run, calls } = runnerReturning({
      code: 0,
      stdout: 'swift-driver version: 1.100\nTarget: arm64-apple-macosx',
      stderr: '',
      timedOut: false,
    });

    const check = await ocrCheck(run);

    expect(check).toEqual({ id: 'ocr.swiftc', ok: true, detail: 'swift-driver version: 1.100' });
    expect(calls).toEqual([{ cmd: 'swiftc', args: ['--version'] }]);
  });

  it('fails with the install hint when swiftc is missing', async () => {
    const { run } = runnerReturning({
      code: 1,
      stdout: '',
      stderr: 'xcrun: error: unable to find utility "swiftc"',
      timedOut: false,
    });

    const check = await ocrCheck(run);

    expect(check.ok).toBe(false);
    expect(check.detail).toContain('unable to find utility');
    expect(check.fix).toBe('xcode-select --install');
  });

  it('fails with the install hint when swiftc cannot start', async () => {
    const run: ProcessRunner = async () => {
      throw new Error('spawn swiftc ENOENT');
    };

    const check = await ocrCheck(run);

    expect(check).toEqual({
      id: 'ocr.swiftc',
      ok: false,
      detail: 'swiftc is not installed',
      fix: 'xcode-select --install',
    });
  });
});
