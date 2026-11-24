import { describe, expect, it } from 'vitest';
import { cleanStoredInstructions, stripPreface } from '../../src/core/bots/instructions.js';
import type { Bot } from '../../src/core/contracts/bots.js';

describe('role prompts without the model’s preface', () => {
  it('drops what the model said about writing the prompt and keeps the prompt', () => {
    expect(stripPreface('역할 프롬프트를 아래에 작성했어요. 3~6문장, 해요체로 맞췄어요.\n\n당신은 clipper 팀의 검수 담당이에요. 결과를 읽고 고칠 점을 짚어요.')).toBe('당신은 clipper 팀의 검수 담당이에요. 결과를 읽고 고칠 점을 짚어요.');
    expect(stripPreface('이 작업은 파일 수정이 없는 텍스트 작성이라 바로 프롬프트를 만들어 드릴게요.  당신은 메일 CRM 개발 팀의 검수 담당이에요.')).toBe('당신은 메일 CRM 개발 팀의 검수 담당이에요.');
    expect(stripPreface('This is a text-only drafting task, so no tools are needed.\n\nYou are the lead of event-processing.')).toBe('You are the lead of event-processing.');
    expect(stripPreface('역할 프롬프트를 적어요.\n\n```\n당신은 직원 2입니다.\n```')).toBe('당신은 직원 2입니다.');
    const plain = 'betalab 개발 봇은 업무보드를 개발하고 고치는 팀의 팀장이에요. 일을 받으면 나눠 맡겨요.';
    expect(stripPreface(plain)).toBe(plain);
  });

  it('cleans prompts the model wrote earlier, leaves the owner’s own', async () => {
    const bots = [
      { id: 'a', instructions: '역할 프롬프트를 아래에 작성했어요.\n\n당신은 QA 팀 직원이에요. 테스트해요.', instructionsBy: 'ai' },
      { id: 'b', instructions: '역할 프롬프트를 아래에 적어요.\n\n당신은 내가 쓴 거예요.', instructionsBy: 'owner' },
    ] as unknown as Bot[];
    const saved: Record<string, string> = {};
    const count = await cleanStoredInstructions({ list: async () => bots, setInstructions: async (id, text) => void (saved[id] = text) });
    expect(count).toBe(1);
    expect(saved).toEqual({ a: '당신은 QA 팀 직원이에요. 테스트해요.' });
  });
});
