import { describe, expect, it } from 'vitest';
import { HelperMacAppsClient, MacAppsError } from '../../../src/connectors/mac-apps/client.js';
import type { ProcessRunner, RunResult } from '../../../src/core/process/types.js';

const APP = { name: '메모', bundle: 'com.apple.Notes', pid: 42, active: true, hidden: false };

function fake(documents: unknown[] | ((args: readonly string[]) => unknown)) {
  const calls: string[][] = [];
  const queue = Array.isArray(documents) ? [...documents] : undefined;
  const run: ProcessRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const doc = queue !== undefined ? queue.shift() : (documents as (a: readonly string[]) => unknown)(args);
    return { code: 0, stdout: JSON.stringify(doc), stderr: '', timedOut: false };
  };
  return { calls, client: new HelperMacAppsClient({ run, helperPath: async () => '/bin/ax-control' }) };
}

describe('HelperMacAppsClient', () => {
  it('reads trust and the running apps', async () => {
    const { client, calls } = fake([{ ok: true, trusted: true }, { ok: true, apps: [APP] }]);
    expect(await client.trusted()).toBe(true);
    expect(await client.apps()).toEqual([APP]);
    expect(calls).toEqual([['/bin/ax-control', 'trusted'], ['/bin/ax-control', 'apps']]);
  });

  it('reads the focused window and keeps secure values blank', async () => {
    const { client, calls } = fake([
      {
        ok: true,
        app: APP,
        window: '새로운 메모',
        truncated: true,
        nodes: [
          [0, 'AXWindow', 'AXStandardWindow', '새로운 메모', '', ''],
          [1, 'AXTextArea', '', '본문', '장보기 목록', 'f'],
          [1, 'AXSecureTextField', '', '암호', 'leaked', 's'],
          [1, 'AXButton', '', '공유', '', 'd'],
        ],
      },
    ]);
    const snapshot = await client.window({ bundle: 'com.apple.Notes', maxDepth: 5, maxNodes: 100, redact: true });
    expect(calls[0]).toEqual([
      '/bin/ax-control', 'window', '--bundle', 'com.apple.Notes', '--max-depth', '5', '--max-nodes', '100', '--redact', '1',
    ]);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes[1]).toMatchObject({ role: 'AXTextArea', value: '장보기 목록', focused: true });
    expect(snapshot.nodes[2]).toMatchObject({ role: 'AXSecureTextField', value: '', secure: true });
    expect(snapshot.nodes[3]).toMatchObject({ disabled: true });
  });

  it('sends each action with its arguments', async () => {
    const done = { ok: true, app: APP, role: 'AXButton', label: '저장', done: true };
    const { client, calls } = fake((args) => (args[0] === 'selected' ? { ok: true, app: APP, text: '' } : done));
    await client.selected('com.apple.Notes');
    await client.activate('com.apple.Notes');
    await client.press('com.apple.Notes', [{ role: 'AXSheet' }, { role: 'AXButton', title: '저장' }]);
    await client.set('com.apple.Notes', [{ role: 'AXTextField', title: '제목' }], '회의록');
    expect(await client.menu('com.apple.Notes', ['파일', '새로운 메모'])).toEqual({ app: APP, role: 'AXButton', label: '저장' });
    expect(calls.map((call) => call.slice(1))).toEqual([
      ['selected', '--bundle', 'com.apple.Notes'],
      ['activate', '--bundle', 'com.apple.Notes'],
      ['press', '--bundle', 'com.apple.Notes', '--target', '[{"role":"AXSheet"},{"role":"AXButton","title":"저장"}]'],
      ['set', '--bundle', 'com.apple.Notes', '--target', '[{"role":"AXTextField","title":"제목"}]', '--value', '회의록'],
      ['menu', '--bundle', 'com.apple.Notes', '--items', '["파일","새로운 메모"]'],
    ]);
  });

  it('reads the selected text', async () => {
    const { client } = fake([{ ok: true, app: APP, role: 'AXTextArea', text: '고른 글' }]);
    expect(await client.selected()).toEqual({ app: APP, text: '고른 글' });
  });

  it.each([
    ['accessibility', '손쉬운 사용'],
    ['ambiguous', '여러 개'],
    ['secure', '비밀번호 칸'],
    ['not-running', '켜져 있지 않아요'],
  ])('turns helper error %s into a clear message', async (code, words) => {
    const { client } = fake([{ ok: false, error: code }]);
    const error = await client.press('x', [{ role: 'AXButton' }]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MacAppsError);
    expect((error as MacAppsError).code).toBe(code);
    expect((error as Error).message).toContain(words);
  });

  it('reports unknown errors, bad documents, exits and timeouts as helper failures', async () => {
    expect(await fake([{ ok: false, error: 'action-failed' }]).client.trusted().catch((e: MacAppsError) => e.code)).toBe('helper');
    expect(await fake([{ ok: true, nope: 1 }]).client.apps().catch((e: MacAppsError) => e.code)).toBe('helper');
    const results: RunResult[] = [
      { code: 1, stdout: '', stderr: '', timedOut: false },
      { code: 0, stdout: '', stderr: '', timedOut: true },
      { code: 0, stdout: 'not json', stderr: '', timedOut: false },
    ];
    const run: ProcessRunner = async () => results.shift() ?? { code: 0, stdout: '', stderr: '', timedOut: false };
    const client = new HelperMacAppsClient({ run, helperPath: async () => '/bin/ax-control' });
    expect(await client.apps().catch((e: MacAppsError) => e.code)).toBe('helper');
    expect(await client.apps().catch((e: MacAppsError) => e.code)).toBe('timeout');
    expect(await client.apps().catch((e: MacAppsError) => e.code)).toBe('helper');
  });
});
