import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeProcessRunner } from '../../../src/core/process/node-runner.js';
import { ensureSwiftHelper } from '../../../src/core/process/swift-helper.js';
import type { ProcessRunner, RunOptions } from '../../../src/core/process/types.js';

describe('nodeProcessRunner', () => {
  it('feeds stdin, adds env and reports the exit code', async () => {
    const script = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(s+process.env.AXK_T);process.exit(3)})';
    const result = await nodeProcessRunner(process.execPath, ['-e', script], {
      input: 'hi-',
      env: { AXK_T: 'env' },
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ code: 3, stdout: 'hi-env', stderr: '', timedOut: false });
  });

  it('kills a program that runs past its timeout', async () => {
    const result = await nodeProcessRunner(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
  });

  it('rejects when the program cannot start', async () => {
    await expect(nodeProcessRunner('/nonexistent/ax-kit-tool', [], { timeoutMs: 1000 })).rejects.toThrow('Could not run');
  });
});

const TEST_BIN = join(tmpdir(), 'ax-kit-test-bin');

describe('ensureSwiftHelper', () => {
  const calls: { cmd: string; args: readonly string[]; opts: RunOptions }[] = [];
  const run: ProcessRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };

  it('reuses a binary built from the same source', async () => {
    calls.length = 0;
    const path = await ensureSwiftHelper(
      { name: 'ax-read', sourcePath: '/src/ax-read.swift', binDir: '/bin-dir' },
      { run, readSource: async () => 'print(1)', exists: async () => true },
    );
    expect(path).toMatch(/^\/bin-dir\/ax-read-[0-9a-f]{12}$/);
    expect(calls).toEqual([]);
  });

  it('names the binary after the source hash and passes frameworks to swiftc', async () => {
    calls.length = 0;
    const first = await ensureSwiftHelper(
      { name: 'ax-ocr', sourcePath: '/src/ocr.swift', binDir: TEST_BIN, frameworks: ['Vision'] },
      { run: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); throw new Error('stop'); }, readSource: async () => 'a', exists: async () => false },
    ).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect(calls[0]?.cmd).toBe('swiftc');
    expect(calls[0]?.args).toContain('Vision');
    const other = await ensureSwiftHelper(
      { name: 'ax-ocr', sourcePath: '/src/ocr.swift', binDir: '/b' },
      { run, readSource: async () => 'b', exists: async () => true },
    );
    expect(other).not.toBe(calls[0]?.args[2]);
  });

  it('embeds an Info.plist and lets its contents change the version hash', async () => {
    calls.length = 0;
    const files: Record<string, string> = { '/src/r.swift': 'print(1)', '/src/Info.plist': '<plist>a</plist>' };
    const capture: ProcessRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      throw new Error('stop');
    };
    const spec = { name: 'ax-reminders', sourcePath: '/src/r.swift', infoPlistPath: '/src/Info.plist', binDir: TEST_BIN, frameworks: ['EventKit'] };
    await ensureSwiftHelper(spec, { run: capture, readSource: async (path) => files[path] ?? '', exists: async () => false }).catch(() => undefined);
    expect(calls[0]?.args.slice(-8)).toEqual(['-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', '/src/Info.plist']);
    const first = calls[0]?.args[2];
    files['/src/Info.plist'] = '<plist>b</plist>';
    await ensureSwiftHelper(spec, { run: capture, readSource: async (path) => files[path] ?? '', exists: async () => false }).catch(() => undefined);
    expect(calls[1]?.args[2]).not.toBe(first);
  });

  it('reports a failed build with the compiler message', async () => {
    const failing: ProcessRunner = async () => ({ code: 1, stdout: '', stderr: 'error: bad', timedOut: false });
    await expect(
      ensureSwiftHelper(
        { name: 'x', sourcePath: '/s.swift', binDir: TEST_BIN },
        { run: failing, readSource: async () => 'c', exists: async () => false },
      ),
    ).rejects.toThrow('error: bad');
  });
});
