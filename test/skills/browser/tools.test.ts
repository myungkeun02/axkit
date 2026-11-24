import { describe, expect, it } from 'vitest';
import type { BrowserOpenOutput } from '../../../src/skills/browser/tool-open.js';
import type { BrowserRunOutput } from '../../../src/skills/browser/output.js';
import { FakeConfirmer } from '../../support/context.js';
import { flush } from '../../core/helpers.js';
import { FakeBrowserAgent, ReadOnlyBrowserAgent, setup } from './helpers.js';

describe('browser skill', () => {
  it('reads without asking, even when writes would be denied', async () => {
    const agent = new FakeBrowserAgent();
    const confirmer = new FakeConfirmer('denied');
    const context = await setup({ agent, confirmer });

    const outcome = await context.ctx.tools.execute('browser.read', { url: 'https://example.com/' });

    expect(outcome.status).toBe('done');
    expect(agent.reads).toEqual(['https://example.com/']);
    expect(confirmer.requests).toHaveLength(0);
  });

  it('sends the task through the confirmer and never runs after a denial', async () => {
    const agent = new FakeBrowserAgent();
    const confirmer = new FakeConfirmer('denied');
    const context = await setup({ agent, confirmer });

    const outcome = await context.ctx.tools.execute('browser.task', {
      goal: '가격 알아보기',
      startUrl: 'https://example.com/item',
    });

    expect(outcome.status).toBe('denied');
    expect(agent.tasks).toHaveLength(0);
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]?.effects).toContain('send');
  });

  it('describes a task with the goal, start address and the stop rule', async () => {
    const agent = new FakeBrowserAgent();
    const confirmer = new FakeConfirmer('approved');
    const context = await setup({ agent, confirmer });

    await context.task({ goal: '가격 알아보기', startUrl: 'https://example.com/item' });

    expect(agent.tasks).toEqual([{ goal: '가격 알아보기', startUrl: 'https://example.com/item' }]);
    const summary = confirmer.requests[0]?.summary ?? '';
    expect(summary).toContain('가격 알아보기');
    expect(summary).toContain('시작 주소: https://example.com/item');
    expect(summary).toContain('로그인·결제·약관 동의는 하지 않고 그 화면에서 멈춰요.');
  });

  it('continues after a final-button stop only with that button on a card the owner must answer', async () => {
    const agent = new FakeBrowserAgent();
    agent.result = {
      status: 'needs_human',
      summary: '예약 정보 확인',
      url: 'https://example.com/book',
      handoff: { reason: 'other', url: 'https://example.com/book', button: '예약 확정' },
    };
    const confirmer = new FakeConfirmer('approved');
    const context = await setup({ agent, confirmer });

    const output = await context.task({ goal: '금요일 7시 예약', startUrl: 'https://example.com/' });
    expect(output.handoff).toMatchObject({ reason: 'other', button: '예약 확정' });
    expect(output.handoff?.guide).toContain("'눌러도 돼'");

    agent.result = { status: 'done', summary: '예약됨', url: 'https://example.com/done' };
    const again = await context.task({ goal: '금요일 7시 예약', startUrl: 'https://example.com/book', approvedButton: '예약 확정' });
    expect(again.status).toBe('done');
    expect(agent.tasks.at(-1)).toMatchObject({ startUrl: 'https://example.com/book', approvedCommit: '예약 확정' });
    const card = confirmer.requests.at(-1);
    expect(card?.summary).toContain("이번에는 '예약 확정' 버튼까지 눌러요.");
    // a final button is never covered by "from now on, just do it"
    expect(card?.note).toContain('직접 허락');
    expect(card?.remember).toBeUndefined();
  });

  it('returns the Korean handoff guide', async () => {
    const agent = new FakeBrowserAgent();
    agent.result = {
      status: 'needs_human',
      summary: '로그인 후 이용해 주세요',
      url: 'https://example.com/login',
      handoff: { reason: 'login', url: 'https://example.com/login' },
    };
    const context = await setup({ agent });

    const outcome = await context.ctx.tools.execute('browser.read', { url: 'https://example.com/login' });

    if (outcome.status !== 'done') throw new Error(`read failed: ${outcome.status}`);
    const output = outcome.output as BrowserRunOutput;
    expect(output.status).toBe('needs_human');
    expect(output.handoff?.reason).toBe('login');
    expect(output.handoff?.guide).toContain('맥 화면에서 직접 로그인해 주세요');
    expect(output.handoff?.guide).toContain('vnc://<이 맥 주소>');
    expect(output.handoff?.guide).toContain("'계속'");
  });

  it('returns the English handoff guide', async () => {
    const agent = new FakeBrowserAgent();
    agent.result = {
      status: 'needs_human',
      summary: 'Payment method',
      url: 'https://example.com/checkout',
      handoff: { reason: 'payment', url: 'https://example.com/checkout' },
    };
    const context = await setup({ agent, language: 'en' });

    const outcome = await context.ctx.tools.execute('browser.read', { url: 'https://example.com/checkout' });

    if (outcome.status !== 'done') throw new Error(`read failed: ${outcome.status}`);
    const output = outcome.output as BrowserRunOutput;
    expect(output.handoff?.guide).toContain('Please pay yourself');
    expect(output.handoff?.guide).toContain('Screen Sharing');
    expect(output.handoff?.guide).toContain('continue');
  });

  it('caps the returned text at 8000 characters', async () => {
    const agent = new FakeBrowserAgent();
    agent.result = { status: 'done', summary: '가'.repeat(10_000), url: 'https://example.com/' };
    const context = await setup({ agent });

    const outcome = await context.ctx.tools.execute('browser.read', { url: 'https://example.com/' });

    if (outcome.status !== 'done') throw new Error(`read failed: ${outcome.status}`);
    expect((outcome.output as BrowserRunOutput).text).toHaveLength(8000);
  });

  it('passes a failed run through with its text', async () => {
    const agent = new FakeBrowserAgent();
    agent.result = { status: 'failed', summary: 'Playwright is not installed' };
    const context = await setup({ agent });

    const outcome = await context.ctx.tools.execute('browser.read', { url: 'https://example.com/' });

    if (outcome.status !== 'done') throw new Error(`read failed: ${outcome.status}`);
    expect(outcome.output).toMatchObject({ status: 'failed', text: 'Playwright is not installed' });
  });

  it('rejects file: and javascript: addresses before the agent is called', async () => {
    const agent = new FakeBrowserAgent();
    const context = await setup({ agent });

    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      const read = await context.ctx.tools.execute('browser.read', { url });
      expect(read.status).toBe('invalid_input');
    }
    const task = await context.ctx.tools.execute('browser.task', {
      goal: 'read something',
      startUrl: 'file:///etc/passwd',
    });
    expect(task.status).toBe('invalid_input');
    const open = await context.ctx.tools.execute('browser.open_for_me', { url: 'javascript:alert(1)' });
    expect(open.status).toBe('invalid_input');

    expect(agent.reads).toHaveLength(0);
    expect(agent.tasks).toHaveLength(0);
    expect(agent.opened).toHaveLength(0);
  });

  it('rejects an empty or overlong goal', async () => {
    const context = await setup();

    expect((await context.ctx.tools.execute('browser.task', { goal: '' })).status).toBe('invalid_input');
    expect((await context.ctx.tools.execute('browser.task', { goal: 'a'.repeat(501) })).status).toBe('invalid_input');
  });

  it('opens the page for the owner and returns the guide without waiting', async () => {
    const agent = new FakeBrowserAgent();
    agent.deferOpen = true;
    const context = await setup({ agent });

    const outcome = await context.ctx.tools.execute('browser.open_for_me', {
      url: 'https://example.com/login',
    });

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    const output = outcome.output as BrowserOpenOutput;
    expect(output.status).toBe('opened');
    expect(agent.opened).toEqual(['https://example.com/login']);
    if (output.status === 'opened') expect(output.guide).toContain("'계속'");
    agent.releaseOpen();
    await flush();
  });

  it('says it cannot open the page when the adapter has no openForHuman', async () => {
    const context = await setup({ agent: new ReadOnlyBrowserAgent() });

    const outcome = await context.ctx.tools.execute('browser.open_for_me', { url: 'https://example.com/' });

    if (outcome.status !== 'done') throw new Error(`open failed: ${outcome.status}`);
    const output = outcome.output as BrowserOpenOutput;
    expect(output.status).toBe('failed');
    expect(output.message).toContain('직접 열어 주세요');
  });

  it('still answers when opening the window fails, and swallows the error', async () => {
    const agent = new FakeBrowserAgent();
    agent.openError = new Error('browser did not start');
    const context = await setup({ agent });

    const outcome = await context.ctx.tools.execute('browser.open_for_me', { url: 'https://example.com/' });

    expect(outcome.status).toBe('done');
    if (outcome.status === 'done') expect((outcome.output as BrowserOpenOutput).status).toBe('opened');
    await flush();
  });
});
