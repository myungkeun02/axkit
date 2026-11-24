import { describe, expect, it } from 'vitest';
import type { FileFacts, VisionTextRecognizerOptions } from '../../../src/connectors/macos-ocr/recognizer.js';
import { VisionTextRecognizer } from '../../../src/connectors/macos-ocr/recognizer.js';
import type { ProcessRunner, RunResult } from '../../../src/core/process/types.js';

interface Call {
  cmd: string;
  args: string[];
  timeoutMs: number;
}

function runnerReturning(result: RunResult): { run: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: ProcessRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], timeoutMs: opts.timeoutMs });
    return result;
  };
  return { run, calls };
}

function ok(text: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    code: 0,
    stdout: JSON.stringify({ ok: true, method: 'vision', pages: 1, text }),
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function make(
  run: ProcessRunner,
  options: { helperCalls?: { count: number }; stat?: VisionTextRecognizerOptions['stat'] } = {},
): VisionTextRecognizer {
  const counter = options.helperCalls;
  return new VisionTextRecognizer({
    run,
    helperPath: async () => {
      if (counter !== undefined) counter.count += 1;
      return '/bin/ax-ocr';
    },
    stat: options.stat ?? (async (): Promise<FileFacts> => ({ size: 1_000, isFile: true })),
  });
}

describe('VisionTextRecognizer', () => {
  it('runs the helper with the absolute path, languages and page cap', async () => {
    const { run, calls } = runnerReturning(ok('합계 12,500원'));
    const recognizer = make(run);

    const result = await recognizer.recognize('/tmp/receipt.png', { maxPages: 3 });

    expect(calls).toEqual([
      {
        cmd: '/bin/ax-ocr',
        args: ['/tmp/receipt.png', '--languages', 'ko-KR,en-US', '--max-pages', '3'],
        timeoutMs: 120_000,
      },
    ]);
    expect(result).toEqual({ method: 'vision', pages: 1, text: '합계 12,500원' });
  });

  it('defaults to 10 pages and clamps to 1..50', async () => {
    const { run, calls } = runnerReturning(ok('x'));
    const recognizer = make(run);

    await recognizer.recognize('/tmp/a.pdf');
    await recognizer.recognize('/tmp/a.pdf', { maxPages: 0 });
    await recognizer.recognize('/tmp/a.pdf', { maxPages: 99 });
    await recognizer.recognize('/tmp/a.pdf', { maxPages: Number.NaN });

    expect(calls.map((call) => call.args.at(-1))).toEqual(['10', '1', '50', '10']);
  });

  it('accepts a custom language list', async () => {
    const { run, calls } = runnerReturning(ok('x'));
    await make(run).recognize('/tmp/a.jpg', { languages: ['ko-KR'] });
    expect(calls[0]?.args).toContain('ko-KR');
    expect(calls[0]?.args).not.toContain('ko-KR,en-US');
  });

  it('rejects a relative path before running the helper', async () => {
    const { run, calls } = runnerReturning(ok('x'));
    const helperCalls = { count: 0 };
    await expect(make(run, { helperCalls }).recognize('receipts/scan.png')).rejects.toThrow('must be absolute');
    expect(calls).toEqual([]);
    expect(helperCalls.count).toBe(0);
  });

  it('rejects an unsupported file type before running the helper', async () => {
    const { run, calls } = runnerReturning(ok('x'));
    await expect(make(run).recognize('/tmp/scan.docx')).rejects.toThrow('unsupported file type');
    expect(calls).toEqual([]);
  });

  it('rejects a file over 25 MB', async () => {
    const { run, calls } = runnerReturning(ok('x'));
    const recognizer = make(run, {
      stat: async () => ({ size: 25 * 1024 * 1024 + 1, isFile: true }),
    });
    await expect(recognizer.recognize('/tmp/big.pdf')).rejects.toThrow('too large');
    expect(calls).toEqual([]);
  });

  it('rejects a path that is not a regular file', async () => {
    const recognizer = make(runnerReturning(ok('x')).run, {
      stat: async () => ({ size: 10, isFile: false }),
    });
    await expect(recognizer.recognize('/tmp/folder.pdf')).rejects.toThrow('not a regular file');
  });

  it('reports an unreadable file when stat fails', async () => {
    const recognizer = make(runnerReturning(ok('x')).run, {
      stat: async () => {
        throw new Error('ENOENT');
      },
    });
    await expect(recognizer.recognize('/tmp/gone.pdf')).rejects.toThrow('unreadable');
  });

  it('rejects languages that do not look like BCP 47 tags', async () => {
    const { run, calls } = runnerReturning(ok('x'));
    await expect(make(run).recognize('/tmp/a.png', { languages: ['korean'] })).rejects.toThrow(
      'invalid recognition language',
    );
    await expect(make(run).recognize('/tmp/a.png', { languages: [] })).rejects.toThrow(
      'invalid recognition language',
    );
    expect(calls).toEqual([]);
  });

  it('throws the helper error code from an ok:false result', async () => {
    const { run } = runnerReturning({
      code: 0,
      stdout: JSON.stringify({ ok: false, error: 'bad_image' }),
      stderr: '',
      timedOut: false,
    });
    await expect(make(run).recognize('/tmp/a.png')).rejects.toThrow('bad_image');
  });

  it('reports a timeout separately', async () => {
    const { run } = runnerReturning(ok('', { timedOut: true, stdout: '' }));
    await expect(make(run).recognize('/tmp/a.png')).rejects.toThrow('text recognition timed out');
  });

  it('fails on a non-zero exit or malformed output', async () => {
    const failed = runnerReturning(ok('', { code: 1, stdout: '' }));
    await expect(make(failed.run).recognize('/tmp/a.png')).rejects.toThrow('text recognition failed');

    const garbage = runnerReturning(ok('', { stdout: 'not json' }));
    await expect(make(garbage.run).recognize('/tmp/a.png')).rejects.toThrow('text recognition failed');

    const wrongShape = runnerReturning(ok('', { stdout: JSON.stringify({ ok: true, text: 'x' }) }));
    await expect(make(wrongShape.run).recognize('/tmp/a.png')).rejects.toThrow('text recognition failed');
  });

  it('caps recognized text at 100,000 characters', async () => {
    const { run } = runnerReturning(ok('a'.repeat(100_001)));
    const result = await make(run).recognize('/tmp/a.png');
    expect(result.text).toHaveLength(100_000);
  });

  it('returns the pdf-text method and page count unchanged', async () => {
    const { run } = runnerReturning({
      code: 0,
      stdout: JSON.stringify({ ok: true, method: 'pdf-text', pages: 4, text: 'layer text' }),
      stderr: '',
      timedOut: false,
    });
    await expect(make(run).recognize('/tmp/a.pdf')).resolves.toEqual({
      method: 'pdf-text',
      pages: 4,
      text: 'layer text',
    });
  });
});
