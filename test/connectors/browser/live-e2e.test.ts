import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightAgent } from '../../../src/connectors/browser/playwright-agent.js';
import type { PlaywrightLike } from '../../../src/connectors/browser/playwright-agent.js';
import type { LlmGateway, LlmRequest } from '../../../src/core/llm/types.js';

/** The pixel size in a JPEG's start-of-frame segment. */
function jpegSize(jpeg: Buffer): { width: number; height: number } | undefined {
  for (let at = 2; at + 9 < jpeg.length; ) {
    const marker = jpeg[at + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xc2) return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    at += 2 + jpeg.readUInt16BE(at + 2);
  }
  return undefined;
}

/** Fills the id box, then stops for the owner at the login, like a model would. */
function fillThenHandOff(): LlmGateway {
  let turn = 0;
  return {
    async complete(request: LlmRequest) {
      const prompt = request.messages.at(-1)?.content ?? '';
      const ref = Number(/\[(\d+)\] textbox "아이디"/.exec(prompt)?.[1] ?? -1);
      const step =
        turn++ === 0
          ? { action: { kind: 'fill', ref, text: 'owner-id' }, done: null, handoff: null }
          : { action: null, done: null, handoff: { reason: 'login', note: '비밀번호는 오너가 넣어요' } };
      return { text: JSON.stringify({ thought: 'step', ...step }), providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  } as unknown as LlmGateway;
}

/** A login box across the top of the page; submitting shows what was typed, so the test can see it arrived. */
const PAGE = `<!doctype html><html><head><title>로그인</title>
<meta name="viewport" content="width=device-width"><style>body{margin:0}input{position:absolute;left:0;top:0;width:400px;height:80px}</style></head>
<body><form onsubmit="document.title='ok:'+document.getElementById('id').value;return false"><input id="id" aria-label="아이디"></form>
<div style="height:4000px"></div></body></html>`;

let playwright: PlaywrightLike | undefined;
let server: ReturnType<typeof createServer>;
let base = '';
let dir = '';

beforeAll(async () => {
  try {
    playwright = (await import('playwright')) as unknown as PlaywrightLike;
  } catch {
    playwright = undefined;
  }
  dir = await mkdtemp(join(tmpdir(), 'ax-kit-live-'));
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(process.env.AX_KIT_SKIP_BROWSER === '1')('live page in real Chromium', () => {
  it('draws a JPEG, takes a tap, typed text and Enter, then frees the profile', async (ctx) => {
    const loaded = playwright;
    if (loaded === undefined) return ctx.skip();
    const agent = new PlaywrightAgent({ profileDir: join(dir, 'profile'), load: async () => loaded });
    const live = await agent.openLive(base);
    try {
      const first = await live.frame();
      expect(first.jpeg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
      expect(first.width).toBe(824);
      await live.tap(100, 60);
      await live.type('owner-id');
      await live.key('Enter');
      await live.scroll(800);
      const after = await live.frame();
      expect(after.title).toBe('ok:owner-id');
    } finally {
      await live.close();
    }
    const read = await agent.read(base);
    expect(read.status).not.toBe('failed');
  }, 30_000);

  it('takes over the page a handoff kept, with what the run already filled in', async (ctx) => {
    const loaded = playwright;
    if (loaded === undefined) return ctx.skip();
    const agent = new PlaywrightAgent({ profileDir: join(dir, 'profile-kept'), load: async () => loaded, llm: fillThenHandOff() });
    const result = await agent.run({ goal: '로그인', startUrl: base, keepPage: true });
    expect(result.status).toBe('needs_human');
    const live = await agent.openLive(result.handoff?.url ?? base);
    try {
      const first = await live.frame();
      // fitted to the phone screen at twice the pixels, like a fresh live page
      expect(first.width).toBe(824);
      expect(jpegSize(first.jpeg)).toEqual({ width: 824, height: 1720 });
      await live.key('Enter');
      expect((await live.frame()).title).toBe('ok:owner-id');
    } finally {
      await live.close();
    }
    expect((await agent.read(base)).status).not.toBe('failed');
  }, 60_000);

  it('a read that needs the profile, or the keep window running out, closes the kept page; the live view then reloads', async (ctx) => {
    const loaded = playwright;
    if (loaded === undefined) return ctx.skip();
    const agent = new PlaywrightAgent({ profileDir: join(dir, 'profile-evict'), load: async () => loaded, llm: fillThenHandOff(), keepMs: 200 });
    expect((await agent.run({ goal: '로그인', startUrl: base, keepPage: true })).status).toBe('needs_human');
    // the profile is taken back from a page nobody opened: the read goes through
    expect((await agent.read(base)).status).not.toBe('failed');
    const fresh = await agent.openLive(base);
    try {
      await fresh.key('Tab');
      await fresh.key('Enter');
      // a reloaded page: the box is empty again
      expect((await fresh.frame()).title).toBe('ok:');
    } finally {
      await fresh.close();
    }

    const timed = new PlaywrightAgent({ profileDir: join(dir, 'profile-timed'), load: async () => loaded, llm: fillThenHandOff(), keepMs: 200 });
    expect((await timed.run({ goal: '로그인', startUrl: base, keepPage: true })).status).toBe('needs_human');
    await new Promise((resolve) => setTimeout(resolve, 600));
    const reloaded = await timed.openLive(base);
    try {
      await reloaded.key('Tab');
      await reloaded.key('Enter');
      expect((await reloaded.frame()).title).toBe('ok:');
    } finally {
      await reloaded.close();
    }
  }, 60_000);
});
