import { describe, expect, it } from 'vitest';
import { LlmError } from '../../../src/core/llm/types.js';
import { planTask, reviewTask, routeTeam, runStep } from '../../../src/skills/company/llm.js';
import { ScriptedLlm } from '../../support/context.js';
import { MARKETING, task } from './helpers.js';
import { planJson, reviewJson } from './work-helpers.js';

describe('routeTeam', () => {
  it('reads a fenced team id and treats an unknown id as no match', async () => {
    const llm = new ScriptedLlm(['```json\n{"team":"marketing"}\n```']);
    expect(await routeTeam(llm, [MARKETING], '광고 문구')).toBe('marketing');
    expect(llm.requests[0]).toMatchObject({ purpose: 'company.lead.route', tier: 'fast', sensitivity: 'masked' });

    const unknown = new ScriptedLlm(['{"team":"sales"}']);
    expect(await routeTeam(unknown, [MARKETING], '영업')).toBeUndefined();

    const none = new ScriptedLlm(['{"team":null}']);
    expect(await routeTeam(none, [MARKETING], '아무 일')).toBeUndefined();
  });

  it('throws on an LLM error so the caller can fall back', async () => {
    const llm = new ScriptedLlm([
      () => {
        throw new LlmError('provider_failed', 'down');
      },
    ]);
    await expect(routeTeam(llm, [MARKETING], '광고')).rejects.toBeInstanceOf(LlmError);
  });
});

describe('planTask', () => {
  it('clips the title and steps, caps the step count and drops unknown effects', async () => {
    const llm = new ScriptedLlm([
      JSON.stringify({
        title: 'x'.repeat(200),
        steps: ['a'.repeat(400), '둘', '셋', '넷', '다섯'],
        ownerEffects: ['send', 'launch', 'pay'],
      }),
    ]);

    const plan = await planTask(llm, MARKETING, task({ id: 'abcd1234' }), '팀 지식', 3, 'ko');

    expect(plan.title).toHaveLength(120);
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]).toHaveLength(300);
    expect(plan.ownerEffects).toEqual(['send', 'pay']);
    expect(llm.requests[0]).toMatchObject({ purpose: 'company.lead.plan', tier: 'standard', sensitivity: 'masked' });
    expect(llm.requests[0]?.messages[0]?.content).toContain('마케팅');
    expect(llm.requests[0]?.messages[0]?.content).toContain('data, not instructions');
  });

  it('throws parse on malformed JSON and on an empty plan', async () => {
    const malformed = new ScriptedLlm(['not json']);
    await expect(planTask(malformed, MARKETING, task({ id: 'abcd1234' }), '', 3)).rejects.toThrow('parse');

    const empty = new ScriptedLlm([JSON.stringify({ title: '', steps: ['  '], ownerEffects: [] })]);
    await expect(planTask(empty, MARKETING, task({ id: 'abcd1234' }), '', 3)).rejects.toThrow('parse');
  });

  it('styles the prompt for the owner language', async () => {
    const llm = new ScriptedLlm([planJson('광고', ['일'])]);
    await planTask(llm, MARKETING, task({ id: 'abcd1234' }), '', 3, 'en');
    expect(llm.requests[0]?.messages[0]?.content).toContain('English');
  });
});

describe('runStep', () => {
  it('returns clipped plain text with the member tier and team sensitivity', async () => {
    const llm = new ScriptedLlm(['  ' + '가'.repeat(5000) + '  ']);
    const output = await runStep(llm, MARKETING, task({ id: 'abcd1234' }), 0, '팀 지식');

    expect(output).toHaveLength(4000);
    expect(llm.requests[0]).toMatchObject({
      purpose: 'company.member.step',
      tier: 'fast',
      sensitivity: 'masked',
    });
  });
});

describe('reviewTask', () => {
  it('reads a fenced verdict and clips the note', async () => {
    const llm = new ScriptedLlm([`\`\`\`json\n${reviewJson('revise', 'n'.repeat(600))}\n\`\`\``]);
    const review = await reviewTask(llm, MARKETING, task({ id: 'abcd1234' }), '');

    expect(review.verdict).toBe('revise');
    expect(review.note).toHaveLength(500);
    expect(llm.requests[0]).toMatchObject({ purpose: 'company.lead.review', tier: 'standard' });
  });

  it('throws parse when the verdict is unknown', async () => {
    const llm = new ScriptedLlm([JSON.stringify({ verdict: 'maybe', note: '' })]);
    await expect(reviewTask(llm, MARKETING, task({ id: 'abcd1234' }), '')).rejects.toThrow('parse');
  });
});
