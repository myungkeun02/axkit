import { step as showStep } from './prompt-kit.js';
import type { Prompter } from './prompter.js';
import { PromptBack } from './select-tty.js';

export interface SetupStep {
  title: string;
  note: string;
  /** Asks this step's questions and keeps the answers (it may run again when the owner goes back). */
  run: (prompter: Prompter) => Promise<void>;
  /** A step that does not apply right now is skipped, also when going back. */
  when?: () => boolean;
}

const QUESTIONS = ['choose', 'chooseMany', 'chooseOrType', 'text', 'secret'] as const;

/** The same prompter, counting the questions asked since the last reset. */
function counting(prompter: Prompter): { prompter: Prompter; asked: () => number; reset: () => void } {
  let asked = 0;
  const wrapped: Prompter = { ...prompter };
  for (const name of QUESTIONS) {
    const original = prompter[name] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (original === undefined) continue;
    (wrapped as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      asked += 1;
      return original.apply(prompter, args);
    };
  }
  return { prompter: wrapped, asked: () => asked, reset: () => (asked = 0) };
}

function previous(steps: readonly SetupStep[], from: number): number {
  for (let index = from - 1; index >= 0; index -= 1) if (steps[index]?.when?.() !== false) return index;
  return from;
}

/**
 * Runs the steps in order. Going back (← / Esc, or "<" typed) on a step's first question opens the step before; later
 * in a step it starts that step again. Before saving, the owner can open any step once more to change it.
 */
export async function runSteps(base: Prompter, steps: readonly SetupStep[], finish: { title: string; note: string }): Promise<void> {
  const { prompter, asked, reset } = counting(base);
  const active = (): SetupStep[] => steps.filter((item) => item.when?.() !== false);
  const runOne = async (index: number, numbered: boolean): Promise<'done' | 'back'> => {
    const current = steps[index];
    if (current === undefined) return 'done';
    const shown = active();
    if (numbered) showStep(prompter, shown.indexOf(current) + 1, shown.length + 1, current.title, current.note);
    reset();
    try {
      await current.run(prompter);
      return 'done';
    } catch (error) {
      if (!(error instanceof PromptBack)) throw error;
      if (asked() <= 1) return 'back';
      prompter.say('이 단계를 처음부터 다시 할게요.');
      return await runOne(index, false);
    }
  };

  let index = 0;
  while (index < steps.length) {
    if (steps[index]?.when?.() === false) {
      index += 1;
      continue;
    }
    if ((await runOne(index, true)) === 'back') {
      const before = previous(steps, index);
      if (before === index) prompter.say('첫 단계예요.');
      index = before;
      continue;
    }
    index += 1;
  }

  const total = active().length + 1;
  showStep(base, total, total, finish.title, finish.note);
  for (;;) {
    const shown = active();
    const pick = await base
      .choose(
        '저장하기 전에 고칠 단계가 있나요?',
        [{ value: 'save', label: '이대로 저장 (추천)' }, ...shown.map((item, at) => ({ value: String(steps.indexOf(item)), label: `${at + 1}. ${item.title} 다시 하기` }))],
        0,
      )
      .catch((error: unknown) => {
        if (error instanceof PromptBack) return String(steps.indexOf(shown[shown.length - 1] as SetupStep));
        throw error;
      });
    if (pick === 'save') return;
    await runOne(Number(pick), true);
  }
}

