import { describe, expect, it } from 'vitest';
import type { PlaywrightLike, PlaywrightPage } from '../../../src/connectors/browser/playwright-agent.js';
import { PlaywrightAgent } from '../../../src/connectors/browser/playwright-agent.js';
import type { BrowserAuthHelper, MailMessage, MailReader, MailSummary, OneTimeCode } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { Caps } from '../../../src/core/plugin/types.js';
import { decideAutoAuth, extractMailStep, registrableDomain } from '../../../src/skills/browser/auth-rules.js';
import { authHelperFor, autoAuthSchema } from '../../../src/skills/browser/auto-auth.js';
import { settler } from '../work/settle.js';
import { browserSkill } from '../../../src/skills/browser/plugin.js';
import { browserTexts } from '../../../src/skills/browser/locale.js';
import { createTestContext, FakeConfirmer } from '../../support/context.js';
import { FakeBrowserAgent } from './helpers.js';

const NOW = new Date('2026-11-17T09:00:00+09:00');
const texts = browserTexts('ko');

class Vault {
  constructor(public code: OneTimeCode | undefined) {}
  latest(): OneTimeCode | undefined {
    return this.code;
  }
}

function settings(overrides: Record<string, unknown> = {}) {
  return autoAuthSchema.parse({ enabled: true, sites: ['example.com'], ...overrides });
}

function context(capabilities: Record<string, unknown> = {}, confirmer = new FakeConfirmer('approved')) {
  return createTestContext({ now: NOW, confirmer, capabilities: { [Caps.confirmer.id]: confirmer, ...capabilities } });
}

describe('auth rules', () => {
  it('matches registrable domains and fails closed', () => {
    expect(registrableDomain('www.mail.example.co.kr')).toBe('example.co.kr');
    expect(registrableDomain('login.example.com')).toBe('example.com');
    const base = { pageText: '', goal: '예약 확인', financialSites: [] as string[] };
    expect(decideAutoAuth({ ...base, pageUrl: 'https://login.example.com/otp', sites: ['example.com'] })).toBe('ok');
    expect(decideAutoAuth({ ...base, pageUrl: 'https://other.test/otp', sites: ['example.com'] })).toBe('not_allowed');
    expect(decideAutoAuth({ ...base, pageUrl: 'https://www.kbstar.com/', sites: ['kbstar.com'] })).toBe('confirm');
    expect(
      decideAutoAuth({ ...base, goal: '계좌 이체', pageUrl: 'https://example.com/', sites: ['example.com'] }),
    ).toBe('confirm');
  });

  it('takes only links on the site domain from mail', () => {
    expect(extractMailStep('Click https://evil.test/verify?x=1 now', 'example.com')).toBeUndefined();
    expect(extractMailStep('Click https://example.com/verify?x=1 now', 'example.com')).toEqual({
      kind: 'link',
      url: 'https://example.com/verify?x=1',
    });
    expect(extractMailStep('인증번호는 [123456] 입니다', 'example.com')).toEqual({ kind: 'code', code: '123456' });
  });
});

describe('task auth helper', () => {
  it('is not built when auto-auth is off or the start site is not allowed', () => {
    const { ctx } = context();
    expect(authHelperFor(ctx, autoAuthSchema.parse({}), texts, 'x', 'https://example.com/')).toBeUndefined();
    expect(authHelperFor(ctx, settings(), texts, 'x', 'https://other.test/')).toBeUndefined();
  });

  it('hands out a phone code that arrived after the task started, once', async () => {
    const vault = new Vault({ code: '482913', at: new Date(NOW.getTime() + 30_000) });
    const { ctx } = context({ [Contracts.phoneOtp.id]: vault });
    const helper = authHelperFor(ctx, settings(), texts, '예약 확인', 'https://example.com/')!;
    expect(await helper.stepFor('https://example.com/otp', '인증번호 입력')).toEqual({ kind: 'code', code: '482913' });
    expect(await helper.stepFor('https://example.com/otp', '인증번호 입력')).toBeUndefined();
  });

  it('ignores an old code and pages off the list', async () => {
    const vault = new Vault({ code: '111111', at: new Date(NOW.getTime() - 5 * 60_000) });
    const { ctx } = context({ [Contracts.phoneOtp.id]: vault });
    const helper = authHelperFor(ctx, settings(), texts, 'x', 'https://example.com/')!;
    expect(await helper.stepFor('https://example.com/otp', '')).toBeUndefined();
    vault.code = { code: '222222', at: NOW };
    expect(await helper.stepFor('https://redirect.test/otp', '')).toBeUndefined();
  });

  it('asks the owner first on a money-grade site and stops on a denial', async () => {
    const vault = new Vault({ code: '333333', at: NOW });
    const confirmer = new FakeConfirmer('denied');
    const { ctx } = context({ [Contracts.phoneOtp.id]: vault }, confirmer);
    const helper = authHelperFor(ctx, settings({ sites: ['example.com', 'kbstar.com'] }), texts, '잔액 조회', 'https://www.kbstar.com/')!;
    expect(await helper.stepFor('https://www.kbstar.com/otp', '인증번호')).toBeUndefined();
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]?.summary).toContain('kbstar.com');
    expect(JSON.stringify(confirmer.requests)).not.toContain('333333');
  });

  it('reads only the site’s own mail', async () => {
    const summaries: MailSummary[] = [
      { id: 'a', threadId: 'a', from: 'Phish <x@evil.test>', subject: 'code', snippet: '', receivedAt: NOW, unread: true, important: false },
      { id: 'b', threadId: 'b', from: 'Shop <no-reply@mail.example.com>', subject: 'code', snippet: '', receivedAt: NOW, unread: true, important: false },
    ];
    const mail: MailReader = {
      search: async () => summaries,
      read: async (id) =>
        ({ ...summaries.find((entry) => entry.id === id)!, to: [], cc: [], body: id === 'a' ? '인증번호 999999' : '인증번호 654321' }) as MailMessage,
    };
    const { ctx } = context({ [Contracts.mailRead.id]: mail });
    const helper = authHelperFor(ctx, settings({ email: true }), texts, 'x', 'https://example.com/')!;
    expect(await helper.stepFor('https://example.com/otp', '')).toEqual({ kind: 'code', code: '654321' });
  });
});

describe('browser.task wiring', () => {
  it('passes a helper only when enabled for the start site', async () => {
    const agent = new FakeBrowserAgent();
    const test = createTestContext({
      now: NOW,
      config: { autoAuth: { enabled: true, sites: ['example.com'] } },
      capabilities: { [Contracts.browser.id]: agent },
    });
    const settled = settler();
    await browserSkill({ onSettled: settled.onSettled }).setup(test.ctx);
    await test.ctx.tools.execute('browser.task', { goal: '예약', startUrl: 'https://example.com/a' });
    await test.ctx.tools.execute('browser.task', { goal: '예약', startUrl: 'https://other.test/a' });
    await settled.next();
    await settled.next();
    expect(agent.tasks[0]?.auth).toBeDefined();
    expect(agent.tasks[1]?.auth).toBeUndefined();
  });

  it('stays off by default', async () => {
    const agent = new FakeBrowserAgent();
    const test = createTestContext({ now: NOW, capabilities: { [Contracts.browser.id]: agent } });
    const settled = settler();
    await browserSkill({ onSettled: settled.onSettled }).setup(test.ctx);
    await test.ctx.tools.execute('browser.task', { goal: '예약', startUrl: 'https://example.com/a' });
    await settled.next();
    expect(agent.tasks[0]?.auth).toBeUndefined();
  });
});

describe('playwright code step', () => {
  function page(state: { url: string; text: string; filled: string[] }): PlaywrightPage {
    return {
      goto: async (url) => {
        state.url = url;
      },
      title: async () => 'Verify',
      innerText: async () => state.text,
      url: () => state.url,
      close: async () => undefined,
      waitForEvent: async () => undefined,
      $: async (selector) => (selector.includes('one-time-code') ? {} : null),
      fill: async (_selector, value) => {
        state.filled.push(value);
      },
      press: async () => {
        state.text = `Welcome back. Your code 777777 was accepted.`;
      },
    };
  }

  it('types the code, masks it and finishes', async () => {
    const state = { url: '', text: '인증번호를 입력하세요', filled: [] as string[] };
    const load = async (): Promise<PlaywrightLike> => ({
      chromium: {
        launchPersistentContext: async () => ({
          newPage: async () => page(state),
          close: async () => undefined,
          on: () => undefined,
        }),
      },
    });
    const auth: BrowserAuthHelper = { stepFor: async () => ({ kind: 'code', code: '777777' }) };
    const agent = new PlaywrightAgent({ profileDir: '/tmp/none', load, prepareProfile: async () => undefined });
    const result = await agent.run({ goal: '예약', startUrl: 'https://example.com/otp', auth });
    expect(state.filled).toEqual(['777777']);
    expect(result.status).toBe('done');
    expect(result.summary).not.toContain('777777');
  });

  it('never asks for a code on a payment page', async () => {
    const state = { url: '', text: '카드 번호 입력 / 인증번호', filled: [] as string[] };
    let asked = 0;
    const load = async (): Promise<PlaywrightLike> => ({
      chromium: {
        launchPersistentContext: async () => ({ newPage: async () => page(state), close: async () => undefined, on: () => undefined }),
      },
    });
    const auth: BrowserAuthHelper = {
      stepFor: async () => {
        asked += 1;
        return { kind: 'code', code: '1' };
      },
    };
    const agent = new PlaywrightAgent({ profileDir: '/tmp/none', load, prepareProfile: async () => undefined });
    const result = await agent.run({ goal: '예약', startUrl: 'https://example.com/pay', auth });
    expect(asked).toBe(0);
    expect(result.status).toBe('needs_human');
    expect(result.handoff?.reason).toBe('payment');
  });
});
