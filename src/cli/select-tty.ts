import type { KeyPress, SelectSpec, SelectState } from './select-state.js';
import { answeredLine, caret, initialState, press, render } from './select-state.js';
import type { Paint } from './style.js';

/** Esc or Ctrl+C on a question: the terminal is restored first, then this is thrown. */
export class PromptCancelled extends Error {
  constructor() {
    super('설정을 그만뒀어요.');
    this.name = 'PromptCancelled';
  }
}

/** Esc / ← on a question (or "<" typed as an answer): go back to the question before. */
export class PromptBack extends Error {
  constructor() {
    super('이전으로');
    this.name = 'PromptBack';
  }
}

/** "<" or "뒤로" typed as an answer means "go back". */
export function isBackAnswer(value: string): boolean {
  const text = value.trim();
  return text === '<' || text === '뒤로' || text.toLowerCase() === 'back';
}

type KeyListener = (str: string | undefined, key: KeyPress | undefined) => void;

/** The part of process.stdin the list needs; a fake in tests. Call readline.emitKeypressEvents on it first. */
export interface KeyInput {
  on(event: 'keypress', listener: KeyListener): unknown;
  removeListener(event: 'keypress', listener: KeyListener): unknown;
  setRawMode?(mode: boolean): unknown;
  isRaw?: boolean;
  resume(): unknown;
  pause(): unknown;
}

export interface ScreenOutput {
  write(chunk: string): unknown;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): unknown;
  removeListener?(event: 'resize', listener: () => void): unknown;
}

export interface SelectAnswer {
  values: string[];
  labels: string[];
  typed: boolean;
}

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

/**
 * Runs one arrow-key question in raw mode. Only the question block is redrawn (cursor up + clear below), so the rest
 * of the screen does not flicker. Leaves one "✔ question · answer" line behind.
 */
export function runSelect(spec: SelectSpec, input: KeyInput, output: ScreenOutput, paint: Paint): Promise<SelectAnswer> {
  return new Promise((resolve, reject) => {
    let state: SelectState = initialState(spec);
    let drawn = 0;
    let row = 0;
    const wasRaw = input.isRaw === true;
    const width = (): number => (output.columns !== undefined && output.columns > 0 ? output.columns : 80);
    const height = (): number => (output.rows !== undefined && output.rows > 0 ? output.rows : 24);

    const clear = (): void => {
      if (drawn === 0) return;
      output.write(`\r${row > 0 ? `\u001b[${row}A` : ''}\u001b[0J`);
      drawn = 0;
      row = 0;
    };
    const draw = (): void => {
      const lines = render(state, width(), height(), paint);
      clear();
      output.write(`${lines.join('\n')}\n`);
      drawn = lines.length;
      row = lines.length;
      const at = caret(state, width());
      if (at === undefined) {
        output.write(HIDE_CURSOR);
        return;
      }
      const up = drawn - at.row;
      output.write(`\u001b[${up}A\r${at.col > 0 ? `\u001b[${at.col}C` : ''}${SHOW_CURSOR}`);
      row = at.row;
    };
    const cleanup = (): void => {
      input.removeListener('keypress', onKey);
      output.removeListener?.('resize', draw);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write(SHOW_CURSOR);
    };
    const onKey: KeyListener = (str, key) => {
      try {
        const outcome = press(state, str, key);
        if (outcome.kind === 'continue') {
          state = outcome.state;
          draw();
          return;
        }
        clear();
        if (outcome.kind === 'back') {
          output.write(`${paint.dim(`↩ ${spec.question}`)}\n`);
          cleanup();
          reject(new PromptBack());
          return;
        }
        if (outcome.kind === 'cancel') {
          output.write(`${paint.dim(`✖ ${spec.question}`)}\n`);
          cleanup();
          reject(new PromptCancelled());
          return;
        }
        const answer = outcome.labels.length > 0 ? outcome.labels.join(', ') : '없음';
        output.write(`${answeredLine(spec.question, answer, width(), paint)}\n`);
        cleanup();
        resolve({ values: outcome.values, labels: outcome.labels, typed: outcome.typed });
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    input.setRawMode?.(true);
    input.on('keypress', onKey);
    output.on?.('resize', draw);
    input.resume();
    draw();
  });
}
