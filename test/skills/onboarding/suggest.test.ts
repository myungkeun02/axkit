import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { FeatureSetup } from '../../../src/core/contracts/feature-setup.js';
import type { QuestionRequest, QuestionResult } from '../../../src/core/policy/questions.js';
import type { LlmGateway } from '../../../src/core/llm/types.js';
import { fittingSuggestions } from '../../../src/skills/onboarding/suggest-catalog.js';
import type { SuggestFacts } from '../../../src/skills/onboarding/suggest-catalog.js';
import { offerSuggestions } from '../../../src/skills/onboarding/suggest.js';
import { createTestContext } from '../../support/context.js';

const RECRUITER: SuggestFacts = { docTypes: { resume: 340, plan: 12, proposal: 3 }, repos: 0, sessions: 0, driveFiles: 40, mail: 30, calendar: 5 };
const DEVELOPER: SuggestFacts = { docTypes: { other: 20 }, repos: 4, sessions: 60, driveFiles: 0, mail: 2, calendar: 0 };
const nothing = { on: () => false, has: () => false };

function model(answer: unknown): LlmGateway {
  return {
    async complete() {
      return { text: JSON.stringify(answer), providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  } as LlmGateway;
}

describe('feature suggestions after the first look', () => {
  it('offers what the evidence supports, not a fixed persona', () => {
    expect(fittingSuggestions(RECRUITER, nothing).map((item) => item.id)).toEqual(['talent', 'google-docs', 'gmail-organize', 'company']);
    expect(fittingSuggestions(RECRUITER, nothing)[0]?.reason).toBe('다른 사람의 이력서가 340건 있어요');
    expect(fittingSuggestions(DEVELOPER, nothing).map((item) => item.id)).toEqual(['dev-assist']);
    // Already on or connected: not offered again.
    expect(fittingSuggestions(RECRUITER, { on: (id) => id === 'skill.talent' || id === 'skill.company', has: () => true }).map((item) => item.id)).toEqual([]);
  });

  it('says who it understood, offers fitting features one card each and keeps ideas as improvement requests', async () => {
    const asked: QuestionRequest[] = [];
    const notices: string[] = [];
    const turnedOn: string[][] = [];
    const docs = new Map<string, { entries: string[] }>();
    const setup: FeatureSetup = {
      isOn: () => false,
      async turnOn(ids) {
        turnedOn.push([...ids]);
        return { restart: 'soon' };
      },
    };
    const context = createTestContext({
      llm: model({
        intro: '사람을 회사에 소개하는 일을 하시는 분이군요.',
        picks: [
          { id: 'talent', why: '이력서가 많아서 후보를 바로 찾을 수 있어요' },
          { id: 'gmail-organize', why: '채용 문의 메일이 많아요' },
          { id: 'made-up', why: '없는 기능' },
        ],
        ideas: [{ title: '회사·후보 매칭', why: '채용 요청에 맞는 사람을 골라 소개 메일 초안까지' }],
      }),
      capabilities: {
        [Contracts.featureSetup.id]: setup,
        [Contracts.knowledgeProfile.id]: { summary: async () => '인재 소개 일을 함', reviewLines: async () => [] },
        [Contracts.notifier.id]: { notify: async (notice: { text: string }) => void notices.push(notice.text) },
        [Contracts.questions.id]: {
          async ask(request: QuestionRequest): Promise<QuestionResult> {
            asked.push(request);
            return { status: 'answered', choice: 'yes', means: 'approved', reused: false };
          },
        },
        [Contracts.docs.id]: {
          get: async (id: string) => docs.get(id),
          upsert: async (input: { id: string }) => void docs.set(input.id, { entries: [] }),
          append: async (id: string, entry: { text: string }) => void docs.get(id)?.entries.push(entry.text),
        },
      },
    });

    const plan = await offerSuggestions(context.ctx, RECRUITER, true);

    expect(plan.picks.map((pick) => pick.id)).toEqual(['talent', 'gmail-organize']);
    expect(notices[0]).toContain('사람을 회사에 소개하는 일을 하시는 분이군요.');
    expect(notices[0]).toContain('• 인재 소개 팩: 이력서가 많아서 후보를 바로 찾을 수 있어요');
    expect(asked.map((request) => request.topic)).toEqual(['onboarding:suggest:talent', 'onboarding:suggest:gmail-organize', 'onboarding:ideas']);
    // A switch is turned on from chat; one needing an account gets the command instead.
    expect(turnedOn).toEqual([['skill.talent']]);
    expect(notices.some((text) => text.includes('잠깐 다시 켜진 뒤부터'))).toBe(true);
    expect(notices.some((text) => text.includes('`ax-kit connect google`'))).toBe(true);
    expect(docs.get('onboarding:ideas')?.entries).toEqual(['회사·후보 매칭: 채용 요청에 맞는 사람을 골라 소개 메일 초안까지']);
  });

  it('still offers the rule-based features when no model or profile is available', async () => {
    const asked: string[] = [];
    const context = createTestContext({
      capabilities: {
        [Contracts.questions.id]: {
          async ask(request: QuestionRequest): Promise<QuestionResult> {
            asked.push(request.topic);
            return { status: 'skipped', reason: 'later' };
          },
        },
      },
    });
    const plan = await offerSuggestions(context.ctx, DEVELOPER, true);
    expect(plan.picks.map((pick) => [pick.id, pick.why])).toEqual([['dev-assist', '코드 저장소 4개와 코딩 대화 60개가 있어요']]);
    expect(asked).toEqual(['onboarding:suggest:dev-assist']);
  });
});
