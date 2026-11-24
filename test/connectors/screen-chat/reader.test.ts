import { describe, expect, it } from 'vitest';
import { ScreenReadError } from '../../../src/connectors/screen-chat/ax-tree.js';
import { HelperAxReader } from '../../../src/connectors/screen-chat/reader.js';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { fakeRunner, okResult } from './helpers.js';

const HELPER = '/Users/example/bin/ax-read-abc123';

function readerWith(run: ProcessRunner): HelperAxReader {
  return new HelperAxReader({ run, helperPath: async () => HELPER });
}

const RUNNING = JSON.stringify({
  ok: true,
  running: true,
  frontmost: true,
  windows: ['KakaoTalk'],
  truncated: false,
  nodes: [[0, 0, 'AXWindow', '', '', 'KakaoTalk', 'KakaoTalk']],
});

describe('HelperAxReader', () => {
  it('asks the helper whether accessibility is trusted', async () => {
    const { run, calls } = fakeRunner(() => okResult(JSON.stringify({ ok: true, trusted: true })));
    const reader = readerWith(run);

    expect(await reader.trusted()).toBe(true);
    expect(calls[0]?.cmd).toBe(HELPER);
    expect(calls[0]?.args).toEqual(['trusted']);
    expect(calls[0]?.opts.timeoutMs).toBe(20_000);
  });

  it('reports an untrusted helper as false', async () => {
    const { run } = fakeRunner(() => okResult(JSON.stringify({ ok: true, trusted: false })));
    expect(await readerWith(run).trusted()).toBe(false);
  });

  it('dumps the requested bundles and node cap', async () => {
    const { run, calls } = fakeRunner(() => okResult(RUNNING));
    const reader = readerWith(run);

    const snapshot = await reader.dump(['com.a', 'com.b'], 40);

    expect(calls[0]?.args).toEqual(['dump', '--bundle', 'com.a,com.b', '--max-nodes', '40']);
    expect(snapshot).toEqual({
      running: true,
      frontmost: true,
      windows: ['KakaoTalk'],
      truncated: false,
      nodes: [
        {
          window: 0,
          depth: 0,
          role: 'AXWindow',
          subrole: '',
          identifier: '',
          label: 'KakaoTalk',
          value: 'KakaoTalk',
        },
      ],
    });
  });

  it('omits the node cap when none is given', async () => {
    const { run, calls } = fakeRunner(() => okResult(RUNNING));
    await readerWith(run).dump(['com.a']);
    expect(calls[0]?.args).toEqual(['dump', '--bundle', 'com.a']);
  });

  it('maps a helper accessibility refusal to its own error code', async () => {
    const { run } = fakeRunner(() => okResult('{"ok":false,"error":"accessibility"}'));
    await expect(readerWith(run).dump(['com.a'])).rejects.toMatchObject({ code: 'accessibility' });
  });

  it('maps a timeout to timeout', async () => {
    const { run } = fakeRunner(() => ({ code: 1, stdout: '', stderr: '', timedOut: true }));
    await expect(readerWith(run).dump(['com.a'])).rejects.toMatchObject({ code: 'timeout' });
  });

  it('maps invalid JSON to a helper error', async () => {
    const { run } = fakeRunner(() => okResult('not json'));
    await expect(readerWith(run).dump(['com.a'])).rejects.toMatchObject({ code: 'helper' });
  });

  it('maps a non-zero exit to a helper error', async () => {
    const { run } = fakeRunner(() => ({ code: 2, stdout: '', stderr: 'boom', timedOut: false }));
    await expect(readerWith(run).dump(['com.a'])).rejects.toMatchObject({ code: 'helper' });
  });

  it('maps a runner that cannot start to failed', async () => {
    const run: ProcessRunner = async () => {
      throw new Error('spawn failed');
    };
    const error = await readerWith(run)
      .dump(['com.a'])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScreenReadError);
    expect(error).toMatchObject({ code: 'failed' });
  });

  it('returns a stopped snapshot when the app is not running', async () => {
    const { run } = fakeRunner(() => okResult('{"ok":true,"running":false}'));
    expect(await readerWith(run).dump(['com.a'])).toEqual({
      running: false,
      frontmost: false,
      windows: [],
      truncated: false,
      nodes: [],
    });
  });
});
