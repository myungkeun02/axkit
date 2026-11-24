import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { newestClientJson, nodeAsideRunner, prepareGoogleWithAside } from '../../src/cli/setup-google-aside.js';

const SURVEY = JSON.stringify({
  projects: [
    { id: 'old-one', name: 'Old', desktopClient: false, apis: [] },
    { id: 'ax-hq-1', name: 'ax-hq', desktopClient: true, apis: ['Gmail API', 'Google Calendar API'] },
  ],
  recommended: 'ax-hq-1',
});

describe('prepareGoogleWithAside', () => {
  it('surveys read-only, lists the recommended project first, prepares it and reads the downloaded file', async () => {
    const prompter = createScriptedPrompter(['1']);
    const prompts: string[] = [];
    const json = await prepareGoogleWithAside({
      prompter,
      aside: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? { ok: true, answer: `here: ${SURVEY}` } : { ok: true, answer: '{"projectId":"ax-hq-1","apisEnabled":true,"consentReady":true,"downloaded":"client_secret_x.json","problem":""}' };
      },
      readFile: async (path) => `file:${path}`,
      findClientJson: async () => '/Downloads/client_secret_x.json',
    });
    expect(json).toBe('file:/Downloads/client_secret_x.json');
    expect(prompts[0]).toContain('Read-only');
    expect(prompts[1]).toContain('"ax-hq-1"');
    expect(prompts[1]).toContain('Never type, show, copy or repeat the client secret');
  });

  it('falls back to the manual checklist when no client file arrives', async () => {
    const prompter = createScriptedPrompter(['1']);
    const json = await prepareGoogleWithAside({
      prompter,
      aside: async () => ({ ok: false, answer: 'timeout' }),
      readFile: async () => 'never',
      findClientJson: async () => undefined,
    });
    expect(json).toBeUndefined();
    expect(prompter.said.join('\n')).toContain('직접 해 주세요');
  });

  it('lets the owner pick the manual way without touching their cloud', async () => {
    let calls = 0;
    const json = await prepareGoogleWithAside({
      prompter: createScriptedPrompter(['4']),
      aside: async () => {
        calls += 1;
        return { ok: true, answer: SURVEY };
      },
      readFile: async () => 'never',
    });
    expect(json).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe('newestClientJson', () => {
  it('picks the newest client file written after the start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axk-dl-'));
    await writeFile(join(dir, 'client_secret_old.json'), '{}');
    await utimes(join(dir, 'client_secret_old.json'), new Date(1_000), new Date(1_000));
    await writeFile(join(dir, 'client_secret_new.json'), '{}');
    await writeFile(join(dir, 'other.json'), '{}');
    expect(await newestClientJson(10_000, dir)).toBe(join(dir, 'client_secret_new.json'));
  });
});

describe('nodeAsideRunner', () => {
  it('is undefined without the CLI and reads the JSON answer with it', async () => {
    expect(nodeAsideRunner(() => undefined, async () => ({ code: 0, stdout: '' }))).toBeUndefined();
    const args: string[][] = [];
    const runner = nodeAsideRunner(() => '/bin/aside', async (_cmd, a) => {
      args.push(a);
      return { code: 0, stdout: '{"outcome":"completed","answer":"done"}' };
    });
    expect(await runner?.('task', 5)).toEqual({ ok: true, answer: 'done' });
    expect(args[0]).toEqual(['exec', '--json', '--timeout', '5m', 'task']);
  });
});
