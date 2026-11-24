import type { ChoiceOption, TypeSpec } from './prompt-parse.js';
import { TYPE_LABEL } from './prompt-parse.js';
import type { Paint } from './style.js';
import { displayWidth, truncate, wrapText } from './style.js';

/**
 * The arrow-key list as a pure state machine: `press` takes one keypress (as node:readline reports it) and returns the
 * next state, the answer, or a cancel; `render` draws the question block. No I/O here, so it is tested with fake keys.
 */

export interface KeyPress {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface SelectSpec {
  question: string;
  options: readonly ChoiceOption[];
  multi: boolean;
  defaultIndex?: number;
  /** Multi-select: the indexes checked at the start. */
  checked?: readonly number[];
  /** Adds a "직접 입력" row that turns into a text field. */
  type?: TypeSpec;
}

export interface SelectState {
  spec: SelectSpec;
  /** The options plus, in multi-select, what was typed in. */
  items: readonly ChoiceOption[];
  cursor: number;
  checked: ReadonlySet<number>;
  typing: boolean;
  buffer: string;
  error?: string | undefined;
}

export type SelectOutcome =
  | { kind: 'continue'; state: SelectState }
  | { kind: 'done'; values: string[]; labels: string[]; typed: boolean }
  | { kind: 'cancel' }
  | { kind: 'back' };

const EMPTY_TYPED = '내용을 적어 주세요.';

export function initialState(spec: SelectSpec): SelectState {
  const rows = spec.options.length + (spec.type !== undefined ? 1 : 0);
  const start = spec.multi ? 0 : (spec.defaultIndex ?? 0);
  return {
    spec,
    items: [...spec.options],
    cursor: Math.min(Math.max(0, start), Math.max(0, rows - 1)),
    checked: new Set((spec.checked ?? []).filter((index) => index >= 0 && index < spec.options.length)),
    typing: false,
    buffer: '',
  };
}

function rowCount(state: SelectState): number {
  return state.items.length + (state.spec.type !== undefined ? 1 : 0);
}

function onTypeRow(state: SelectState): boolean {
  return state.spec.type !== undefined && state.cursor === state.items.length;
}

const next = (state: SelectState): SelectOutcome => ({ kind: 'continue', state });

function isPrintable(str: string | undefined, key: KeyPress | undefined): str is string {
  if (str === undefined || str === '' || key?.ctrl === true || key?.meta === true) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(str);
}

function pressTyping(state: SelectState, str: string | undefined, key: KeyPress | undefined): SelectOutcome {
  const name = key?.name;
  if (name === 'escape') return next({ ...state, typing: false, buffer: '', error: undefined });
  if (name === 'backspace') return next({ ...state, buffer: Array.from(state.buffer).slice(0, -1).join('') });
  if (key?.ctrl === true && name === 'u') return next({ ...state, buffer: '' });
  if (name === 'return' || name === 'enter') {
    const value = state.buffer.trim();
    const error = value === '' ? EMPTY_TYPED : state.spec.type?.validate?.(value);
    if (error !== undefined) return next({ ...state, error });
    if (!state.spec.multi) return { kind: 'done', values: [value], labels: [value], typed: true };
    const existing = state.items.findIndex((item) => item.value === value);
    const index = existing >= 0 ? existing : state.items.length;
    const items = existing >= 0 ? state.items : [...state.items, { value, label: value }];
    const base: SelectState = { spec: state.spec, items, cursor: index, checked: new Set([...state.checked, index]), typing: false, buffer: '' };
    return next(base);
  }
  if (isPrintable(str, key)) {
    const base: SelectState = { spec: state.spec, items: state.items, cursor: state.cursor, checked: state.checked, typing: true, buffer: state.buffer + str };
    return next(base);
  }
  return next(state);
}

function finish(state: SelectState): SelectOutcome {
  if (!state.spec.multi) {
    const item = state.items[state.cursor];
    return item === undefined ? next(state) : { kind: 'done', values: [item.value], labels: [item.label], typed: false };
  }
  const picked = state.items.filter((_, index) => state.checked.has(index));
  return { kind: 'done', values: picked.map((item) => item.value), labels: picked.map((item) => item.label), typed: false };
}

export function press(state: SelectState, str: string | undefined, key: KeyPress | undefined): SelectOutcome {
  if (key?.ctrl === true && (key.name === 'c' || key.name === 'd')) return { kind: 'cancel' };
  if (state.typing) return pressTyping(state, str, key);
  const rows = rowCount(state);
  const name = key?.name ?? str;
  const move = (to: number): SelectOutcome => next({ ...state, cursor: ((to % rows) + rows) % rows });
  if (rows === 0) return name === 'escape' || name === 'left' ? { kind: 'back' } : next(state);
  switch (name) {
    case 'escape':
    case 'left':
    case 'backspace':
      return { kind: 'back' };
    case 'up':
    case 'k':
      return move(state.cursor - 1);
    case 'down':
    case 'j':
    case 'tab':
      return move(state.cursor + 1);
    case 'home':
      return move(0);
    case 'end':
      return move(rows - 1);
    case 'pageup':
      return next({ ...state, cursor: Math.max(0, state.cursor - 5) });
    case 'pagedown':
      return next({ ...state, cursor: Math.min(rows - 1, state.cursor + 5) });
    case 'space':
      if (!state.spec.multi) return next(state);
      if (onTypeRow(state)) return next({ ...state, typing: true });
      return next({ ...state, checked: toggle(state.checked, state.cursor) });
    case 'return':
    case 'enter':
      return onTypeRow(state) ? next({ ...state, typing: true }) : finish(state);
    default:
      if (str !== undefined && /^[1-9]$/.test(str) && Number(str) <= rows) return move(Number(str) - 1);
      return next(state);
  }
}

function toggle(set: ReadonlySet<number>, index: number): Set<number> {
  const copy = new Set(set);
  if (copy.has(index)) copy.delete(index);
  else copy.add(index);
  return copy;
}

/** Keeps the cursor row on screen in a list taller than the terminal. */
function windowOf(cursor: number, rows: number, visible: number): number {
  return Math.min(Math.max(0, cursor - Math.floor(visible / 2)), Math.max(0, rows - visible));
}

export function keyHelp(state: SelectState): string {
  if (state.typing) return '글자를 적고 Enter · Esc 목록으로';
  return state.spec.multi ? '↑↓ 이동 · Space 선택/해제 · Enter 완료 · ← 이전' : '↑↓ 이동 · Enter 선택 · ← 이전';
}

function questionLines(state: SelectState, max: number): string[] {
  return wrapText(state.spec.question, max - 2);
}

/** The tail of the typed text that fits on the line. */
function typingText(state: SelectState, max: number): { shown: string; room: number } {
  const room = Math.max(4, max - displayWidth(state.spec.type?.label ?? TYPE_LABEL) - 7);
  let shown = state.buffer;
  while (displayWidth(shown) > room && shown.length > 0) shown = Array.from(shown).slice(1).join('');
  return { shown, room };
}

/**
 * Where the real terminal cursor goes while typing (row from the top of the block, column), so the Korean input
 * method shows its composing letter in the field and not under the block.
 */
export function caret(state: SelectState, width: number): { row: number; col: number } | undefined {
  if (!state.typing) return undefined;
  const max = Math.max(10, width - 1);
  const { shown } = typingText(state, max);
  return { row: questionLines(state, max).length, col: displayWidth(`  ✎ ${state.spec.type?.label ?? TYPE_LABEL}: ${shown}`) };
}

/** The question block; every line fits in `width - 1` columns so redraws can count lines exactly. */
export function render(state: SelectState, width: number, height: number, paint: Paint): string[] {
  const max = Math.max(10, width - 1);
  const lines = questionLines(state, max).map((line, index) => (index === 0 ? `${paint.accent('?')} ${paint.bold(line)}` : `  ${paint.bold(line)}`));
  const typeLabel = state.spec.type?.label ?? TYPE_LABEL;

  if (state.typing) {
    const { shown, room } = typingText(state, max);
    const placeholder = state.buffer === '' && state.spec.type?.placeholder !== undefined ? paint.dim(truncate(state.spec.type.placeholder, room)) : '';
    lines.push(`  ${paint.accent('✎')} ${typeLabel}: ${shown}${placeholder}`);
    if (state.error !== undefined) lines.push(`  ${paint.error(truncate(state.error, max - 2))}`);
    lines.push(paint.dim(truncate(keyHelp(state), max)));
    return lines;
  }

  const rows = rowCount(state);
  const visible = Math.min(rows, Math.max(3, height - lines.length - 4));
  const top = windowOf(state.cursor, rows, visible);
  if (top > 0) lines.push(paint.dim(`    ↑ ${top}개 더`));
  for (let index = top; index < top + visible; index += 1) {
    const here = index === state.cursor;
    const pointer = here ? paint.accent('❯') : ' ';
    const isType = index === state.items.length;
    const box = state.spec.multi && !isType ? (state.checked.has(index) ? `${paint.ok('◉')} ` : `${paint.dim('○')} `) : '';
    const prefixWidth = 3 + (box === '' ? 0 : 2);
    const label = truncate(isType ? `✎ ${typeLabel}` : (state.items[index]?.label ?? ''), max - prefixWidth);
    const styled = here ? paint.accent(paint.bold(label)) : isType ? paint.dim(label) : label;
    lines.push(` ${pointer} ${box}${styled}`);
  }
  const below = rows - top - visible;
  if (below > 0) lines.push(paint.dim(`    ↓ ${below}개 더`));
  const hint = state.items[state.cursor]?.hint;
  if (hint !== undefined && hint !== '') lines.push(`    ${paint.dim(truncate(hint, max - 4))}`);
  lines.push(paint.dim(truncate(keyHelp(state), max)));
  return lines;
}

/** The one line left in the scrollback after an answer. */
export function answeredLine(question: string, answer: string, width: number, paint: Paint): string {
  const max = Math.max(10, width - 1);
  const q = truncate(question, Math.max(6, Math.floor(max * 0.6)));
  return `${paint.ok('✔')} ${q} ${paint.dim('·')} ${paint.accent(truncate(answer, Math.max(4, max - displayWidth(q) - 5)))}`;
}
