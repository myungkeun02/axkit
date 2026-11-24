import { describe, expect, it } from 'vitest';
import { AsideWebAgent, parseAside, promptFor } from '../../../src/connectors/aside/agent.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { WebAgent, WebRunInput } from '../../../src/core/contracts/web-agent.js';
import type { LlmProvider } from '../../../src/core/llm/types.js';
import type { Plugin } from '../../../src/core/plugin/types.js';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { assistantSkill } from '../../../src/skills/assistant/plugin.js';
import { waysSkill } from '../../../src/skills/ways/plugin.js';
import { api, events, pairApp, startApp, until } from '../../channels/app/harness.js';

function fakeWeb(runs: WebRunInput[], answer = '관리 툴 대시보드에서 이번 주 가입자 1,234명을 봤어요.'): Plugin {
  const agent: WebAgent = { label: 'fake', run: async (input) => (runs.push(input), { ok: true, answer, session: 's1' }) };
  return { manifest: { id: 'test.web', kind: 'connector', title: 'web' }, setup: (ctx) => ctx.provide(Contracts.webAgent, agent) };
}

function scripted(steps: ((system: string) => string)[]): LlmProvider & { systems: string[] } {
  const systems: string[] = [];
  let i = 0;
  return {
    id: 'fake',
    systems,
    async complete(_model, request) {
      const system = String(request.messages[0]?.content ?? '');
      if (request.purpose === 'assistant.turn') systems.push(system);
      const step = request.purpose === 'assistant.turn' ? steps[Math.min(i++, steps.length - 1)] : undefined;
      const text = step !== undefined ? step(system) : JSON.stringify({ reply: '', tool_calls: [], question: null });
      return { text, providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  };
}

const plan = (reply: string, calls: { name: string; args: object; why?: string }[] = []) => JSON.stringify({ reply, tool_calls: calls.map((c) => ({ why: null, ...c })), question: null });

describe('finding a way: sites, procedures and the web agent', () => {
  it('remembers a company tool, puts it in the prompt, looks things up there and keeps what worked', async () => {
    const runs: WebRunInput[] = [];
    const model = scripted([
      () => plan('', [{ name: 'ways.remember_site', args: { site: 'https://admin.example.co.kr', label: 'admin', what: '회사 내부 관리 툴(회원·매출 지표)' } }]),
      () => plan('기억했어요.'),
      () => plan('', [{ name: 'web.look', args: { task: '관리 툴에서 이번 주 가입자 수 보기', site: 'admin.example.co.kr' } }]),
      () => plan('이번 주 가입자는 1,234명이에요.'),
    ]);
    const h = await startApp({ llm: model, plugins: [assistantSkill({ loadSystemPrompt: async () => 'You are {{persona}}. {{tools}}' }), waysSkill(), fakeWeb(runs)] });
    try {
      const { token } = await pairApp(h);
      await api(h, token, 'messages', { text: 'admin.example.co.kr은 회사 관리 툴이야' });
      await until(async () => (await events(h, token)).some((e) => e.type === 'message' && e.text === '기억했어요.'));
      await api(h, token, 'messages', { text: '이번 주 가입자 몇 명이야?' });
      await until(async () => (await events(h, token)).some((e) => e.type === 'message' && e.text.includes('1,234명')));
      expect(runs).toEqual([{ task: '관리 툴에서 이번 주 가입자 수 보기', mode: 'look', site: 'admin.example.co.kr' }]);
      expect(model.systems.at(-2)).toContain('admin.example.co.kr (admin): 회사 내부 관리 툴');
      expect(model.systems.at(-2)).toContain('Finding a way');
      const ways = (await (await api(h, token, 'views/ways')).json()) as { data: { blocks: { kind: string; rows?: { title: string }[] }[] } };
      expect(ways.data.blocks.find((b) => b.kind === 'list' && b.rows?.[0]?.title === 'admin')).toBeDefined();
      expect(JSON.stringify(ways.data)).toContain('가입자');
    } finally {
      await h.stop();
    }
  });

  it('asks the owner on a card before acting on a site, and counts an order as paying', async () => {
    const runs: WebRunInput[] = [];
    const model = scripted([() => plan('', [{ name: 'web.do', args: { task: '쿠팡에서 A4 용지 2박스 주문', site: 'coupang.com' }, why: '사장님이 방금 A4 용지가 떨어졌다고 했어요.' }]), () => plan('장바구니에 담고 결제 직전에서 멈췄어요.')]);
    const h = await startApp({ llm: model, plugins: [assistantSkill({ loadSystemPrompt: async () => 'You are {{persona}}. {{tools}}' }), waysSkill(), fakeWeb(runs, 'PAYMENT_STEP A4 2박스 24,000원')] });
    try {
      const { token } = await pairApp(h);
      await api(h, token, 'messages', { text: 'A4 용지 2박스 주문해 줘' });
      await until(async () => (await events(h, token)).some((e) => e.type === 'card'));
      const card = (await events(h, token)).find((e) => e.type === 'card');
      expect(card?.type === 'card' && card.effects).toEqual(expect.arrayContaining(['send', 'pay']));
      expect(card?.type === 'card' && card.note).toContain('A4 용지가 떨어졌다');
      expect(runs).toEqual([]);
      await api(h, token, `cards/${card?.type === 'card' ? card.cardId : ''}`, { option: 'approve' });
      await until(() => runs.length === 1);
      expect(runs[0]).toMatchObject({ mode: 'do', site: 'coupang.com' });
    } finally {
      await h.stop();
    }
  });
});

describe('Aside CLI adapter', () => {
  it('runs aside --json with the rules in the prompt and reads its answer', async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: 'log line\n{"session":{"id":"S1"},"outcome":"completed","answer":"Example Domain","error":null}\n', stderr: '', timedOut: false });
    const agent = new AsideWebAgent({ command: '/x/aside', run, defaultTimeoutMinutes: 5 });
    expect(await agent.run({ task: '제목 보기', mode: 'look', site: 'example.com' })).toEqual({ ok: true, answer: 'Example Domain', session: 'S1' });
    expect(calls[0]?.slice(0, 4)).toEqual(['/x/aside', '--json', '--timeout', '5m']);
    expect(calls[0]?.at(-1)).toContain('LOOK ONLY');
    expect(calls[0]?.at(-1)).toContain('https://example.com');
    expect(promptFor({ task: 't', mode: 'do' })).toContain('PAYMENT_STEP');
    const login = new AsideWebAgent({ command: 'a', run: async () => ({ code: 0, stdout: '{"outcome":"completed","answer":"LOGIN_NEEDED"}', stderr: '', timedOut: false }), defaultTimeoutMinutes: 5 });
    expect(await login.run({ task: 't', mode: 'look' })).toMatchObject({ ok: false, stopped: 'login' });
    expect(parseAside('nothing')).toBeUndefined();
  });
});
