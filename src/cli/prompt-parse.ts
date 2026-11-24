/** Answer parsing shared by the numbered fallback (no TTY) and the scripted test prompter. */

export interface ChoiceOption {
  value: string;
  label: string;
  /** One short line shown under the list while this option is highlighted. */
  hint?: string;
}

export interface ManyOption extends ChoiceOption {
  checked?: boolean;
}

/** The "직접 입력" row: picking it switches to a text field. */
export interface TypeSpec {
  label?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}

export const TYPE_LABEL = '직접 입력';
export const PICK_ERROR = '목록에 있는 번호로 답해 주세요.';

/** By 1-based number, value or label; undefined when nothing matches. */
export function matchOption(answer: string, options: readonly ChoiceOption[]): string | undefined {
  if (/^\d+$/.test(answer)) {
    const option = options[Number.parseInt(answer, 10) - 1];
    if (option !== undefined) return option.value;
  }
  return options.find((option) => option.value === answer || option.label === answer)?.value;
}

/** Empty = the default option. */
export function parseChoice(answer: string, options: readonly ChoiceOption[], defaultIndex: number): string | undefined {
  const trimmed = answer.trim();
  if (trimmed === '') return (options[defaultIndex] ?? options[0])?.value;
  return matchOption(trimmed, options);
}

export type ManyResult = { ok: true; values: string[] } | { ok: false; error: string };

function tokens(answer: string): string[] {
  return answer
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .flatMap((part) => (/^[\d\s-]+$/.test(part) ? part.split(/\s+/) : [part]));
}

/**
 * "1,3", "2-4", "all"/"전부", "none"/"없음", option values or labels, and "+text" for a typed entry (when `type` is
 * given). Empty keeps the checked defaults. Values come back in list order, typed ones last.
 */
export function parseMany(answer: string, options: readonly ManyOption[], type?: TypeSpec): ManyResult {
  const trimmed = answer.trim();
  if (trimmed === '') return { ok: true, values: options.filter((option) => option.checked === true).map((option) => option.value) };
  const lower = trimmed.toLowerCase();
  if (lower === 'none' || trimmed === '없음') return { ok: true, values: [] };
  if (lower === 'all' || trimmed === '전부') return { ok: true, values: options.map((option) => option.value) };

  const picked = new Set<number>();
  const typed: string[] = [];
  for (const token of tokens(trimmed)) {
    if (token.startsWith('+') && type !== undefined) {
      const value = token.slice(1).trim();
      const error = value === '' ? '내용을 적어 주세요.' : type.validate?.(value);
      if (error !== undefined) return { ok: false, error };
      if (!typed.includes(value)) typed.push(value);
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range !== null) {
      const from = Number.parseInt(range[1] ?? '', 10);
      const to = Number.parseInt(range[2] ?? '', 10);
      if (from < 1 || to > options.length || from > to) return { ok: false, error: PICK_ERROR };
      for (let n = from; n <= to; n += 1) picked.add(n - 1);
      continue;
    }
    const value = matchOption(token, options);
    const index = options.findIndex((option) => option.value === value);
    if (value === undefined || index < 0) return { ok: false, error: PICK_ERROR };
    picked.add(index);
  }
  const values = options.filter((_, index) => picked.has(index)).map((option) => option.value);
  return { ok: true, values: [...values, ...typed.filter((value) => !values.includes(value))] };
}
