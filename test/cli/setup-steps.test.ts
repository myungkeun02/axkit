import { describe, expect, it } from 'vitest';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import type { SetupStep } from '../../src/cli/setup-steps.js';
import { runSteps } from '../../src/cli/setup-steps.js';

const FINISH = { title: '마무리', note: '' };

function steps(answers: Record<string, string>, skipSecond = false): SetupStep[] {
  return [
    { title: 'A', note: '', run: async (p) => void (answers['a'] = await p.text('a')) },
    {
      title: 'B',
      note: '',
      when: () => !skipSecond,
      run: async (p) => {
        answers['b1'] = await p.text('b1');
        answers['b2'] = await p.text('b2');
      },
    },
    { title: 'C', note: '', run: async (p) => void (answers['c'] = await p.choose('c', [{ value: 'x', label: 'x' }, { value: 'y', label: 'y' }])) },
  ];
}

describe('runSteps', () => {
  it('goes back to the step before from its first question and changes the answer', async () => {
    const answers: Record<string, string> = {};
    const prompter = createScriptedPrompter(['a1', 'b', 'bb', '<', '<', 'a2', 'b', 'bb', '2', '']);
    await runSteps(prompter, steps(answers), FINISH);
    expect(answers).toEqual({ a: 'a2', b1: 'b', b2: 'bb', c: 'y' });
    expect(prompter.remaining()).toBe(0);
  });

  it('starts the same step again when going back from a later question in it', async () => {
    const answers: Record<string, string> = {};
    const prompter = createScriptedPrompter(['a', 'b-old', '<', 'b-new', 'bb', '1', '']);
    await runSteps(prompter, steps(answers), FINISH);
    expect(answers['b1']).toBe('b-new');
    expect(prompter.said).toContain('이 단계를 처음부터 다시 할게요.');
  });

  it('skips steps that do not apply, also going back, and numbers the rest', async () => {
    const answers: Record<string, string> = {};
    const prompter = createScriptedPrompter(['a', '<', 'a2', '1', '']);
    await runSteps(prompter, steps(answers, true), FINISH);
    expect(answers).toEqual({ a: 'a2', c: 'x' });
    expect(prompter.said.filter((line) => /^\d\/\d · /.test(line))).toEqual(['1/3 · A', '2/3 · C', '1/3 · A', '2/3 · C', '3/3 · 마무리']);
  });

  it('opens any step again from the review before saving', async () => {
    const answers: Record<string, string> = {};
    // review: option 2 = "1. A 다시 하기", then save
    const prompter = createScriptedPrompter(['a', 'b', 'bb', '1', '2', 'a-fixed', '']);
    await runSteps(prompter, steps(answers), FINISH);
    expect(answers['a']).toBe('a-fixed');
    expect(answers['c']).toBe('x');
  });
});
