import { describe, expect, it } from 'vitest';
import { LlmError } from '../../../src/core/llm/types.js';
import { assistantTexts } from '../../../src/skills/assistant/locale.js';
import { FakeConfirmer } from '../../support/context.js';
import { makeHarness, noteTool, plan, run, sendTool } from './helpers.js';

const KO = assistantTexts('ko');

describe('assistant handler', () => {
  it('registers one fallback handler with the lowest priority', async () => {
    const harness = await makeHarness({ script: [plan('네')] });
    expect(harness.handler.id).toBe('assistant');
    expect(harness.handler.priority).toBe(0);
    expect(harness.test.handlers).toHaveLength(1);
  });

  it('passes on non-owner messages without calling the model', async () => {
    const harness = await makeHarness({ script: [] });
    const { result, replies } = await run(harness.handler, '안녕', { fromOwner: false });
    expect(result).toBe('pass');
    expect(replies).toHaveLength(0);
    expect(harness.llm.requests).toHaveLength(0);
  });

  it('answers a plain plan with the model text', async () => {
    const harness = await makeHarness({ script: [plan('오늘은 맑아요.')] });
    const { result, replies } = await run(harness.handler, '오늘 날씨 어때?');

    expect(result).toBe('handled');
    expect(replies).toEqual([{ text: '오늘은 맑아요.' }]);
    expect(harness.llm.requests[0]?.purpose).toBe('assistant.turn');
    expect(harness.llm.requests[0]?.tier).toBe('standard');
    expect(harness.llm.requests[0]?.sensitivity).toBe('sensitive');
    expect(harness.llm.requests[0]?.jsonSchema).toBeDefined();
    expect(harness.llm.requests[0]?.messages[0]?.role).toBe('system');
  });

  it('runs a tool, feeds the result back and answers', async () => {
    const note = noteTool();
    const harness = await makeHarness({
      script: [
        plan('', [{ name: 'notes.add', args: { text: '우유 사기' } }]),
        plan('메모를 저장했어요.'),
      ],
    });
    harness.ctx.registerTool(note.tool);

    const { replies } = await run(harness.handler, '우유 사기 메모해줘');

    expect(replies).toEqual([{ text: '메모를 저장했어요.' }]);
    expect(note.seen).toHaveLength(1);
    expect(note.seen[0]).toContain('우유 사기 메모해줘');

    const fedBack = harness.llm.requests[1]?.messages ?? [];
    const toolResults = fedBack.filter((message) => message.content.includes('<data kind="tool_results">'));
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.content).toContain('notes.add');
    expect(toolResults[0]?.content).toContain('우유 사기');
    expect(toolResults[0]?.content).toContain('"status":"done"');
    expect(fedBack.some((message) => message.role === 'assistant' && message.content.includes('notes.add'))).toBe(true);
  });

  it('routes a send tool through the confirmer and reports a denial', async () => {
    const send = sendTool();
    const confirmer = new FakeConfirmer('denied');
    const harness = await makeHarness({
      script: [
        plan('', [{ name: 'mail.send', args: { body: '내일 봐요' } }]),
        plan('승인을 거절하셔서 보내지 않았어요.'),
      ],
      confirmer,
    });
    harness.ctx.registerTool(send.tool);

    const { replies } = await run(harness.handler, '이 메일 보내줘');

    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]?.effects).toContain('send');
    expect(confirmer.requests[0]?.summary).toContain('내일 봐요');
    expect(send.sent).toHaveLength(0);
    expect(replies).toEqual([{ text: '승인을 거절하셔서 보내지 않았어요.' }]);

    const fedBack = harness.llm.requests[1]?.messages ?? [];
    expect(fedBack.some((message) => message.content.includes('the owner declined'))).toBe(true);
  });

  it('runs an approved send tool only after the card is approved', async () => {
    const send = sendTool();
    const confirmer = new FakeConfirmer('approved');
    const harness = await makeHarness({
      script: [
        plan('', [{ name: 'mail.send', args: { body: '내일 봐요' } }]),
        plan('승인 카드에서 보내기로 하셔서 보냈어요.'),
      ],
      confirmer,
    });
    harness.ctx.registerTool(send.tool);

    await run(harness.handler, '이 메일 보내줘');

    expect(confirmer.requests).toHaveLength(1);
    expect(send.sent).toEqual(['내일 봐요']);
    const fedBack = harness.llm.requests[1]?.messages ?? [];
    expect(fedBack.some((message) => message.content.includes('"status":"done"'))).toBe(true);
  });

  it('reports an unknown tool as a failure without throwing', async () => {
    const harness = await makeHarness({
      script: [plan('', [{ name: 'nope.tool', args: {} }]), plan('그런 도구는 없어요.')],
    });

    const { replies } = await run(harness.handler, '아무거나 해줘');

    expect(replies).toEqual([{ text: '그런 도구는 없어요.' }]);
    const fedBack = harness.llm.requests[1]?.messages ?? [];
    expect(fedBack.some((message) => message.content.includes('Unknown tool: nope.tool'))).toBe(true);
  });

  it('retries once with the parse error when the plan is not valid JSON', async () => {
    const harness = await makeHarness({ script: ['not json at all', plan('다시 정리했어요.')] });

    const { replies } = await run(harness.handler, '안녕');

    expect(harness.llm.requests).toHaveLength(2);
    const retry = harness.llm.requests[1]?.messages.at(-1)?.content ?? '';
    expect(retry).toContain('could not be used');
    expect(replies).toEqual([{ text: '다시 정리했어요.' }]);
  });

  it('uses a localized reply when the retry is still invalid', async () => {
    const harness = await makeHarness({ script: ['nope', 'still nope'] });
    const { replies } = await run(harness.handler, '안녕');

    expect(harness.llm.requests).toHaveLength(2);
    expect(replies).toEqual([{ text: KO.invalidPlan }]);
  });

  it('falls back when the plan has no reply and no question', async () => {
    const harness = await makeHarness({ script: [plan('')] });
    const { replies } = await run(harness.handler, '안녕');
    expect(replies).toEqual([{ text: KO.emptyReply }]);
  });

  it('turns a question into choices whose id equals the label', async () => {
    const harness = await makeHarness({
      script: [plan('두 가지가 있어요.', [], { text: '어느 쪽으로 할까요?', choices: ['오전', '오후', '다른 때'] })],
    });

    const { replies } = await run(harness.handler, '내일 미팅 잡아줘');

    expect(replies[0]?.text).toBe('두 가지가 있어요.\n어느 쪽으로 할까요?');
    expect(replies[0]?.choices).toEqual([
      { id: '오전', label: '오전' },
      { id: '오후', label: '오후' },
      { id: '다른 때', label: '다른 때' },
    ]);
  });

  it('stops after maxSteps and asks for an answer without tools', async () => {
    const note = noteTool();
    const harness = await makeHarness({
      script: [
        plan('', [{ name: 'notes.add', args: { text: '하나' } }]),
        plan('', [{ name: 'notes.add', args: { text: '둘' } }]),
        plan('지금까지 확인한 것만으로 답할게요.'),
      ],
      config: { maxSteps: 1 },
    });
    harness.ctx.registerTool(note.tool);

    const { replies } = await run(harness.handler, '메모 두 개 추가해줘');

    expect(note.seen).toHaveLength(1);
    expect(replies).toEqual([{ text: '지금까지 확인한 것만으로 답할게요.' }]);
    expect(harness.llm.requests).toHaveLength(3);
    expect(harness.llm.requests[2]?.messages.at(-1)?.content).toContain('tool step limit');
  });
});

describe('assistant llm errors', () => {
  const cases = [
    ['over_budget', KO.overBudget],
    ['no_route', KO.noRoute],
    ['provider_failed', KO.providerFailed],
  ] as const;

  it.each(cases)('replies a localized message for %s', async (code, expected) => {
    const harness = await makeHarness({
      script: [
        () => {
          throw new LlmError(code, 'boom');
        },
      ],
    });

    const { result, replies } = await run(harness.handler, '안녕');

    expect(result).toBe('handled');
    expect(replies).toEqual([{ text: expected }]);
  });
});
