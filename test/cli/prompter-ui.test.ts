import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { chooseMany, chooseOrType, step, summary } from '../../src/cli/prompt-kit.js';
import { parseMany } from '../../src/cli/prompt-parse.js';
import type { Prompter } from '../../src/cli/prompter.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import type { KeyPress, SelectSpec } from '../../src/cli/select-state.js';
import { caret, initialState, press, render } from '../../src/cli/select-state.js';
import { PromptCancelled, runSelect } from '../../src/cli/select-tty.js';
import { COLOR, PLAIN, displayWidth, formatStep, truncate, wrapText } from '../../src/cli/style.js';

const OPTIONS = [
  { value: 'a', label: '사과' },
  { value: 'b', label: '바나나', hint: '노란 거' },
  { value: 'c', label: '체리' },
];

const k = (name: string, extra: Partial<KeyPress> = {}): [string | undefined, KeyPress] => [undefined, { name, ...extra }];
const ch = (text: string): [string, KeyPress] => [text, { sequence: text }];

/** Feeds keys to the pure state machine and returns the final outcome. */
function feed(spec: SelectSpec, keys: readonly [string | undefined, KeyPress][]) {
  let state = initialState(spec);
  for (const [str, key] of keys) {
    const outcome = press(state, str, key);
    if (outcome.kind !== 'continue') return outcome;
    state = outcome.state;
  }
  return { kind: 'continue' as const, state };
}

class FakeInput extends EventEmitter {
  isRaw = false;
  rawCalls: boolean[] = [];
  paused = 0;
  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawCalls.push(mode);
  }
  resume(): void {}
  pause(): void {
    this.paused += 1;
  }
  keys(list: readonly [string | undefined, KeyPress][]): void {
    for (const [str, key] of list) this.emit('keypress', str, key);
  }
}

function fakeOutput(columns = 40, rows = 20) {
  const chunks: string[] = [];
  return { chunks, columns, rows, write: (chunk: string) => void chunks.push(chunk) };
}

describe('arrow-key select', () => {
  it('moves with ↑↓ (wrapping), picks with Enter and starts on the default', () => {
    expect(feed({ question: 'q', options: OPTIONS, multi: false, defaultIndex: 1 }, [k('return')])).toMatchObject({ kind: 'done', values: ['b'] });
    expect(feed({ question: 'q', options: OPTIONS, multi: false }, [k('down'), k('down'), k('return')])).toMatchObject({ values: ['c'] });
    expect(feed({ question: 'q', options: OPTIONS, multi: false }, [k('up'), k('return')])).toMatchObject({ values: ['c'] });
    expect(feed({ question: 'q', options: OPTIONS, multi: false }, [ch('2'), k('return')])).toMatchObject({ values: ['b'] });
  });

  it('toggles with Space in multi-select and confirms with Enter', () => {
    const spec: SelectSpec = { question: 'q', options: OPTIONS, multi: true, checked: [0] };
    expect(feed(spec, [k('space'), k('down'), k('space'), k('down'), k('space'), k('return')])).toMatchObject({ kind: 'done', values: ['b', 'c'] });
    expect(feed(spec, [k('return')])).toMatchObject({ values: ['a'] });
  });

  it('switches the "직접 입력" row to a text field, with Backspace, validation and Esc back to the list', () => {
    const spec: SelectSpec = { question: 'q', options: OPTIONS, multi: false, type: { validate: (v) => (/^\d+$/.test(v) ? undefined : '숫자만') } };
    const typed = feed(spec, [k('end'), k('return'), ch('1'), ch('x'), k('backspace'), ch('2'), k('return')]);
    expect(typed).toMatchObject({ kind: 'done', values: ['12'], typed: true });

    const invalid = feed(spec, [k('end'), k('return'), ch('x'), k('return')]);
    expect(invalid.kind).toBe('continue');
    if (invalid.kind === 'continue') expect(invalid.state.error).toBe('숫자만');

    const back = feed(spec, [k('end'), k('return'), ch('9'), k('escape'), k('home'), k('return')]);
    expect(back).toMatchObject({ kind: 'done', values: ['a'] });
  });

  it('adds a typed entry to a multi-select as a checked item', () => {
    const spec: SelectSpec = { question: 'q', options: OPTIONS, multi: true, type: {} };
    const outcome = feed(spec, [k('end'), k('space'), ...Array.from('~/일').map(ch), k('return'), k('return')]);
    expect(outcome).toMatchObject({ kind: 'done', values: ['~/일'] });
  });

  it('goes back on Esc, ← or Backspace in the list and cancels on Ctrl+C anywhere', () => {
    expect(feed({ question: 'q', options: OPTIONS, multi: false }, [k('escape')]).kind).toBe('back');
    expect(feed({ question: 'q', options: OPTIONS, multi: false }, [k('left')]).kind).toBe('back');
    expect(feed({ question: 'q', options: OPTIONS, multi: false }, [k('backspace')]).kind).toBe('back');
    expect(feed({ question: 'q', options: OPTIONS, multi: false, type: {} }, [k('end'), k('return'), k('c', { ctrl: true })]).kind).toBe('cancel');
  });

  it('renders a hint line, keeps every line inside a narrow terminal and scrolls long lists', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ value: String(i), label: `아주 긴 이름의 항목 번호 ${i} 입니다 정말로 깁니다` }));
    const state = initialState({ question: '어느 폴더를 훑어볼까요? 설명이 꽤 길어서 줄이 넘어가요', options: long, multi: true });
    const lines = render(state, 24, 12, PLAIN);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(23);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.some((line) => line.includes('↓') && line.includes('개 더'))).toBe(true);
    expect(lines.at(-1)).toContain('Space');

    const hinted = render(initialState({ question: 'q', options: OPTIONS, multi: false, defaultIndex: 1 }), 40, 20, PLAIN);
    expect(hinted).toContain('    노란 거');
    expect(hinted.at(-1)).toBe('↑↓ 이동 · Enter 선택 · ← 이전');
  });

  it('puts the real cursor in the text field so Korean input composes there', () => {
    const spec: SelectSpec = { question: 'q', options: OPTIONS, multi: false, type: { label: '직접' } };
    const outcome = feed(spec, [k('end'), k('return'), ch('가')]);
    if (outcome.kind !== 'continue') throw new Error('still typing');
    expect(caret(outcome.state, 40)).toEqual({ row: 1, col: displayWidth('  ✎ 직접: 가') });
  });
});

describe('runSelect on a fake terminal', () => {
  it('turns raw mode on, redraws only its block, answers and restores the terminal', async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const answer = runSelect({ question: '과일', options: OPTIONS, multi: false }, input, output, PLAIN);
    input.keys([k('down'), k('return')]);
    await expect(answer).resolves.toEqual({ values: ['b'], labels: ['바나나'], typed: false });
    expect(input.rawCalls).toEqual([true, false]);
    expect(input.listenerCount('keypress')).toBe(0);
    expect(input.paused).toBe(1);
    const screen = output.chunks.join('');
    expect(screen).toContain('\u001b[0J');
    expect(screen).not.toContain('\u001b[2J');
    expect(screen).toContain('✔ 과일 · 바나나');
    expect(screen.endsWith('\u001b[?25h')).toBe(true);
  });

  it('restores the terminal and throws PromptCancelled on Ctrl+C', async () => {
    const input = new FakeInput();
    input.isRaw = false;
    const answer = runSelect({ question: '과일', options: OPTIONS, multi: true }, input, fakeOutput(), COLOR);
    input.keys([k('c', { ctrl: true })]);
    await expect(answer).rejects.toBeInstanceOf(PromptCancelled);
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount('keypress')).toBe(0);
  });
});

describe('answer parsing and fallbacks', () => {
  const many = [{ value: 'x', label: 'X', checked: true }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }];

  it('parses numbers, ranges, all/none, labels and +typed entries', () => {
    expect(parseMany('', many)).toEqual({ ok: true, values: ['x'] });
    expect(parseMany('1,3', many)).toEqual({ ok: true, values: ['x', 'z'] });
    expect(parseMany('2-3', many)).toEqual({ ok: true, values: ['y', 'z'] });
    expect(parseMany('1 2', many)).toEqual({ ok: true, values: ['x', 'y'] });
    expect(parseMany('all', many)).toEqual({ ok: true, values: ['x', 'y', 'z'] });
    expect(parseMany('none', many)).toEqual({ ok: true, values: [] });
    expect(parseMany('Z, +새것', many, {})).toEqual({ ok: true, values: ['z', '새것'] });
    expect(parseMany('4', many).ok).toBe(false);
    expect(parseMany('+새것', many).ok).toBe(false);
  });

  it('the scripted prompter answers chooseOrType by number, label or typed text', async () => {
    const prompter = createScriptedPrompter(['', '2', '체리', '42']);
    const ask = () => chooseOrType(prompter, 'q', OPTIONS, { type: {} });
    expect(await ask()).toBe('a');
    expect(await ask()).toBe('b');
    expect(await ask()).toBe('c');
    expect(await ask()).toBe('42');
    await expect(chooseOrType(createScriptedPrompter(['딴거']), 'q', OPTIONS)).rejects.toThrow('not one of the options');
  });

  it('an old prompter without the new methods gets numbered fallbacks', async () => {
    const said: string[] = [];
    const answers = ['1,+직접', '4', '내 답'];
    const old: Prompter = {
      choose: async (_q, options) => options[Number(answers.shift()) - 1]?.value ?? '',
      text: async () => answers.shift() ?? '',
      secret: async () => '',
      say: (line) => void said.push(line),
    };
    expect(await chooseMany(old, '여러 개', many, { type: {} })).toEqual(['x', '직접']);
    expect(said).toContain('  1) [✓] X');
    expect(await chooseOrType(old, '하나', OPTIONS, { type: {} })).toBe('내 답');
    step(old, 3, 7, 'AI 연결', '짧은 설명');
    summary(old, '이렇게 설정했어요', [{ label: 'AI', value: 'Claude', on: true }], ['ax-kit doctor']);
    expect(said.some((line) => line.includes('3/7 · AI 연결'))).toBe(true);
    expect(said.some((line) => /✔ AI\s+Claude/.test(line))).toBe(true);
  });
});

describe('style', () => {
  it('counts Korean as two columns and truncates and wraps by width', () => {
    expect(displayWidth('가나a')).toBe(5);
    expect(truncate('가나다라마', 6)).toBe('가나…');
    expect(wrapText('하나 둘 셋 넷', 5)).toEqual(['하나', '둘 셋', '넷']);
    const header = formatStep(3, 7, 'AI 연결', undefined, 40, PLAIN);
    expect(header[1]).toMatch(/^━+─+ 3\/7 · AI 연결$/);
  });
});
