import { describe, expect, it } from 'vitest';
import { LlmCoder, safeRelativePath } from '../../../src/skills/dev-assist/llm-coder.js';
import type { CoderFs } from '../../../src/skills/dev-assist/workspace.js';
import { ScriptedLlm } from '../../support/context.js';
import { FakeRunner } from './helpers.js';

const DIR = '/work/job_1';

class FakeFs implements CoderFs {
  readonly files = new Map<string, string>();
  readonly writes: { path: string; content: string }[] = [];

  async read(path: string, maxBytes: number): Promise<string | undefined> {
    const value = this.files.get(path);
    return value === undefined ? undefined : value.slice(0, maxBytes);
  }

  async write(path: string, content: string): Promise<void> {
    this.writes.push({ path, content });
  }
}

function coder(files: readonly string[], llm: ScriptedLlm, fs: FakeFs): LlmCoder {
  const runner = new FakeRunner().on((_cmd, args) => args.includes('ls-files'), { stdout: `${files.join('\n')}\n` });
  return new LlmCoder({ llm, run: runner.run, fs });
}

describe('LlmCoder', () => {
  it('reads chosen files and writes validated edits', async () => {
    const llm = new ScriptedLlm([
      '{"files":["src/a.ts"]}',
      '{"edits":[{"path":"src/a.ts","content":"export const a = 2;"}],"summary":"bump a"}',
    ]);
    const fs = new FakeFs();
    fs.files.set(`${DIR}/src/a.ts`, 'export const a = 1;');

    const result = await coder(['src/a.ts', 'test/a.test.ts'], llm, fs).write({
      dir: DIR,
      instructions: 'Bump a',
    });

    expect(result.ok).toBe(true);
    expect(result.log).toContain('bump a');
    expect(fs.writes).toEqual([{ path: `${DIR}/src/a.ts`, content: 'export const a = 2;' }]);

    expect(llm.requests.map((request) => request.purpose)).toEqual(['dev.code', 'dev.code']);
    expect(llm.requests[0]?.tier).toBe('deep');
    expect(llm.requests[0]?.sensitivity).toBe('masked');
    const second = llm.requests[1]?.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(second).toContain('export const a = 1;');
  });

  it('rejects path traversal before writing anything', async () => {
    const llm = new ScriptedLlm([
      '{"files":[]}',
      '{"edits":[{"path":"../outside.ts","content":"x"},{"path":"src/ok.ts","content":"y"}]}',
    ]);
    const fs = new FakeFs();

    await expect(coder(['src/a.ts'], llm, fs).write({ dir: DIR, instructions: 'x' })).rejects.toThrow('unsafe path');
    expect(fs.writes).toEqual([]);
  });

  it('rejects absolute paths', async () => {
    const llm = new ScriptedLlm(['{"files":[]}', '{"edits":[{"path":"/etc/passwd","content":"x"}]}']);
    const fs = new FakeFs();

    await expect(coder([], llm, fs).write({ dir: DIR, instructions: 'x' })).rejects.toThrow('unsafe path');
  });

  it('rejects edits to protected paths', async () => {
    const llm = new ScriptedLlm([
      '{"files":[]}',
      '{"edits":[{"path":".github/workflows/ci.yml","content":"x"}]}',
    ]);
    const fs = new FakeFs();

    await expect(coder([], llm, fs).write({ dir: DIR, instructions: 'x' })).rejects.toThrow('unsafe path');
    expect(fs.writes).toEqual([]);
  });

  it('does not send protected or unreadable files to the model', async () => {
    const llm = new ScriptedLlm(['{"files":[".env","src/a.ts","assets/logo.png"]}', '{"edits":[]}']);
    const fs = new FakeFs();
    fs.files.set(`${DIR}/.env`, 'TOKEN=secret');
    fs.files.set(`${DIR}/src/a.ts`, 'const a = 1;');

    await coder(['.env', 'src/a.ts', 'assets/logo.png'], llm, fs).write({ dir: DIR, instructions: 'x' });

    const first = llm.requests[0]?.messages.find((message) => message.role === 'user')?.content ?? '';
    const second = llm.requests[1]?.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(first).not.toContain('.env');
    expect(second).not.toContain('TOKEN=secret');
    expect(second).not.toContain('logo.png');
    expect(second).toContain('const a = 1;');
  });

  it('fails when the model returns no usable edit list', async () => {
    const llm = new ScriptedLlm(['{"files":[]}', 'not json']);

    await expect(coder([], llm, new FakeFs()).write({ dir: DIR, instructions: 'x' })).rejects.toThrow(
      'usable edit list',
    );
  });

  it('keeps no more than eight edits', async () => {
    const edits = Array.from({ length: 10 }, (_value, index) => ({
      path: `src/f${index}.ts`,
      content: `export const f${index} = ${index};`,
    }));
    const llm = new ScriptedLlm(['{"files":[]}', JSON.stringify({ edits })]);
    const fs = new FakeFs();

    await coder([], llm, fs).write({ dir: DIR, instructions: 'x' });

    expect(fs.writes).toHaveLength(8);
  });
});

describe('safeRelativePath', () => {
  it('accepts repository-relative paths and normalizes them', () => {
    expect(safeRelativePath('src/a.ts')).toBe('src/a.ts');
    expect(safeRelativePath('./src/a.ts')).toBe('src/a.ts');
    expect(safeRelativePath('src/../test/a.ts')).toBe('test/a.ts');
  });

  it('rejects absolute paths, traversal and empty names', () => {
    for (const path of ['', '..', '../x', 'src/../../x', '/etc/passwd', 'C:/windows', 'a\\..\\..\\x']) {
      expect(safeRelativePath(path), path).toBeUndefined();
    }
  });
});
