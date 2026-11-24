import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onboardingCommand } from '../../src/cli/onboarding-cmd.js';

describe('ax-kit onboarding', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ax-onb-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('sends the first-look command through the local token and prints the reply', async () => {
    await writeFile(join(home, 'desktop.token'), JSON.stringify({ v: 1, baseUrl: 'http://127.0.0.1:47617', token: 'tok', issuedAt: '' }));
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      const body = url.endsWith('/messages') ? { ok: true, seq: 7 } : { ok: true, events: [{ type: 'message', role: 'assistant', text: '처음 알아보기를 시작할게요.' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const said: string[] = [];
    expect(await onboardingCommand('restart', { home, fetch: fake, say: (line) => void said.push(line), sleep: async () => undefined })).toBe(0);
    expect(calls[0]?.url).toBe('http://127.0.0.1:47617/m/v1/app/messages');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: '처음 알아보기' });
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(calls[1]?.url).toContain('/m/v1/app/events?after=7');
    expect(said).toEqual(['보냈어요: "처음 알아보기"', '처음 알아보기를 시작할게요.']);
  });

  it('explains when the assistant is not running or the action is unknown', async () => {
    const said: string[] = [];
    expect(await onboardingCommand('restart', { home, say: (line) => void said.push(line) })).toBe(1);
    expect(said[0]).toContain('ax-kit service install');
    expect(await onboardingCommand('nope', { home, say: (line) => void said.push(line) })).toBe(2);
  });
});
