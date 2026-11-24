import type { ChoiceOption, ManyOption, TypeSpec } from './prompt-parse.js';
import { TYPE_LABEL, parseMany } from './prompt-parse.js';
import type { Prompter } from './prompter.js';
import type { SummaryRow } from './style.js';
import { PLAIN, formatStep, formatSummary } from './style.js';

/**
 * The newer prompt kinds for any Prompter. A prompter that has the optional method (the terminal and the scripted test
 * prompter) answers it itself; an older one gets a plain numbered version built from choose/text/say.
 */

export interface ManyOpts {
  type?: TypeSpec;
}

export interface OrTypeOpts {
  defaultIndex?: number;
  type?: TypeSpec;
}

const TYPE_VALUE = '\u0000type';

export function nonEmpty(validate: TypeSpec['validate']): (value: string) => string | undefined {
  return (value) => (value.trim() === '' ? '내용을 적어 주세요.' : validate?.(value));
}

/** Numbered multi-select for prompters without arrow keys: "1,3", "2-4", "all", "none", "+직접 입력". */
export async function numberedMany(prompter: Prompter, question: string, options: readonly ManyOption[], opts: ManyOpts = {}): Promise<string[]> {
  prompter.say(question);
  options.forEach((option, index) => prompter.say(`  ${index + 1}) [${option.checked === true ? '✓' : ' '}] ${option.label}`));
  if (opts.type !== undefined) prompter.say(`  ${opts.type.label ?? TYPE_LABEL}: 앞에 +를 붙여 적어 주세요 (예: +${opts.type.placeholder ?? '내용'})`);
  const answer = await prompter.text('고를 번호 (쉼표로 · 엔터 = ✓ 그대로 · none = 하나도 안 고름)', {
    default: '',
    validate: (value) => {
      const parsed = parseMany(value, options, opts.type);
      return parsed.ok ? undefined : parsed.error;
    },
  });
  const parsed = parseMany(answer, options, opts.type);
  return parsed.ok ? parsed.values : [];
}

/** Numbered choose with a last "직접 입력" row that asks for text. */
export async function numberedOrType(prompter: Prompter, question: string, options: readonly ChoiceOption[], opts: OrTypeOpts = {}): Promise<string> {
  if (opts.type === undefined) return await prompter.choose(question, options, opts.defaultIndex);
  const label = opts.type.label ?? TYPE_LABEL;
  const choice = await prompter.choose(question, [...options, { value: TYPE_VALUE, label }], opts.defaultIndex);
  if (choice !== TYPE_VALUE) return choice;
  return await prompter.text(opts.type.placeholder !== undefined ? `${label} (예: ${opts.type.placeholder})` : label, { validate: nonEmpty(opts.type.validate) });
}

export async function chooseMany(prompter: Prompter, question: string, options: readonly ManyOption[], opts: ManyOpts = {}): Promise<string[]> {
  return prompter.chooseMany !== undefined ? await prompter.chooseMany(question, options, opts) : await numberedMany(prompter, question, options, opts);
}

/** One of the options' values, or what the owner typed into "직접 입력". */
export async function chooseOrType(prompter: Prompter, question: string, options: readonly ChoiceOption[], opts: OrTypeOpts = {}): Promise<string> {
  return prompter.chooseOrType !== undefined ? await prompter.chooseOrType(question, options, opts) : await numberedOrType(prompter, question, options, opts);
}

export function step(prompter: Prompter, index: number, total: number, title: string, note?: string): void {
  if (prompter.step !== undefined) {
    prompter.step(index, total, title, note);
    return;
  }
  for (const line of formatStep(index, total, title, note, 80, PLAIN)) prompter.say(line);
}

export function summary(prompter: Prompter, title: string, rows: readonly SummaryRow[], next: readonly string[]): void {
  if (prompter.summary !== undefined) {
    prompter.summary(title, rows, next);
    return;
  }
  for (const line of formatSummary(title, rows, next, 200, PLAIN)) prompter.say(line);
}

/** Yes/no with yes first. */
export async function confirm(prompter: Prompter, question: string, yes: boolean, labels: readonly [string, string] = ['네', '아니요']): Promise<boolean> {
  const answer = await prompter.choose(question, [{ value: 'yes', label: labels[0] }, { value: 'no', label: labels[1] }], yes ? 0 : 1);
  return answer === 'yes';
}
