import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { ManyOpts, OrTypeOpts } from './prompt-kit.js';
import { nonEmpty, numberedMany, numberedOrType } from './prompt-kit.js';
import type { ChoiceOption, ManyOption } from './prompt-parse.js';
import { PICK_ERROR, matchOption, parseChoice, parseMany } from './prompt-parse.js';
import { PromptBack, PromptCancelled, isBackAnswer, runSelect } from './select-tty.js';
import type { SummaryRow } from './style.js';
import { PLAIN, formatStep, formatSummary, paintFor } from './style.js';

export type { ChoiceOption, ManyOption, TypeSpec } from './prompt-parse.js';
export { PromptBack, PromptCancelled } from './select-tty.js';

export interface Prompter {
  choose(question: string, options: readonly ChoiceOption[], defaultIndex?: number): Promise<string>;
  text(question: string, opts?: { default?: string; validate?: (v: string) => string | undefined }): Promise<string>;
  secret(question: string): Promise<string>;
  say(line: string): void;
  /** Several answers: Space toggles, Enter confirms. Use `chooseMany` from prompt-kit, which falls back for old prompters. */
  chooseMany?(question: string, options: readonly ManyOption[], opts?: ManyOpts): Promise<string[]>;
  /** One option, or text typed into the "직접 입력" row. */
  chooseOrType?(question: string, options: readonly ChoiceOption[], opts?: OrTypeOpts): Promise<string>;
  /** "3/7 · AI 연결" with a progress bar and a short explanation. */
  step?(index: number, total: number, title: string, note?: string): void;
  /** The end screen. */
  summary?(title: string, rows: readonly SummaryRow[], next: readonly string[]): void;
}

class MuteStream extends Writable {
  muted = false;

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) process.stdout.write(chunk);
    callback();
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR');
}

/**
 * The real terminal. On a TTY, lists move with ↑↓ and Enter (Space for several); when stdin is a pipe it falls back to
 * numbered answers so scripts keep working.
 */
/** `allowBack`: ← / Esc / "<" throw PromptBack (setup's numbered steps handle it); otherwise the question is asked again. */
export function createTtyPrompter(opts: { allowBack?: boolean } = {}): Prompter {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && typeof process.stdin.setRawMode === 'function';
  const paint = paintFor(process.stdout.isTTY === true);
  const output = new MuteStream();
  let shared: Interface | undefined;
  const width = (): number => (process.stdout.columns > 0 ? process.stdout.columns : 80);
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  // Piped answers can arrive all at once, before the question is asked: keep them in order instead of dropping them.
  const queued: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;
  const readPiped = async (query: string): Promise<string> => {
    if (shared === undefined) {
      shared = createInterface({ input: process.stdin, terminal: false });
      shared.on('line', (line) => (waiting.shift() ?? ((value: string | undefined) => void queued.push(value ?? '')))(line));
      shared.on('close', () => {
        ended = true;
        for (const resolve of waiting.splice(0)) resolve(undefined);
      });
    }
    if (!output.muted) process.stdout.write(query);
    const line = queued.shift() ?? (ended ? undefined : await new Promise<string | undefined>((resolve) => waiting.push(resolve)));
    if (line === undefined) throw new PromptCancelled();
    return line;
  };

  /** On a TTY each question gets its own readline (closed after), so it never fights the raw-mode list for keys. */
  const ask = async (query: string): Promise<string> => {
    const line = await askLine(query);
    if (isBackAnswer(line)) throw new PromptBack();
    return line;
  };
  const askLine = async (query: string): Promise<string> => {
    if (!interactive && process.stdin.isTTY !== true) return await readPiped(query);
    if (!interactive) {
      shared ??= createInterface({ input: process.stdin, output, terminal: true });
      return await shared.question(query);
    }
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    const controller = new AbortController();
    rl.on('SIGINT', () => controller.abort());
    try {
      return await rl.question(query, { signal: controller.signal });
    } catch (error) {
      if (isAbort(error)) {
        process.stdout.write('\n');
        throw new PromptCancelled();
      }
      throw error;
    } finally {
      rl.close();
    }
  };
  const select = (spec: Parameters<typeof runSelect>[0]): ReturnType<typeof runSelect> => {
    emitKeypressEvents(process.stdin);
    return runSelect(spec, process.stdin, process.stdout, paint);
  };

  const prompter: Prompter = {
    async choose(question, options, defaultIndex = 0): Promise<string> {
      if (interactive) return (await select({ question, options, multi: false, defaultIndex })).values[0] ?? '';
      say(question);
      options.forEach((option, index) => say(`  ${index + 1}) ${option.label}${index === defaultIndex ? ' *' : ''}`));
      for (;;) {
        const value = parseChoice(await ask('번호: '), options, defaultIndex);
        if (value !== undefined) return value;
        say(PICK_ERROR);
      }
    },

    async chooseMany(question, options, opts = {}): Promise<string[]> {
      if (!interactive) return await numberedMany(prompter, question, options, opts);
      const checked = options.flatMap((option, index) => (option.checked === true ? [index] : []));
      return (await select({ question, options, multi: true, checked, ...(opts.type !== undefined ? { type: opts.type } : {}) })).values;
    },

    async chooseOrType(question, options, opts = {}): Promise<string> {
      if (!interactive) return await numberedOrType(prompter, question, options, opts);
      const spec = { question, options, multi: false, defaultIndex: opts.defaultIndex ?? 0, ...(opts.type !== undefined ? { type: opts.type } : {}) };
      return (await select(spec)).values[0] ?? '';
    },

    async text(question, opts): Promise<string> {
      const suffix = opts?.default !== undefined && opts.default !== '' ? ` ${paint.dim(`[${opts.default}]`)}` : '';
      const query = interactive ? `${paint.accent('?')} ${paint.bold(question)}${suffix} › ` : `${question}${suffix}: `;
      for (;;) {
        const raw = (await ask(query)).trim();
        const value = raw.length > 0 ? raw : (opts?.default ?? '');
        const error = opts?.validate?.(value);
        if (error === undefined) return value;
        say(paint.error(error));
      }
    },

    async secret(question): Promise<string> {
      process.stdout.write(interactive ? `${paint.accent('?')} ${paint.bold(question.trim())} ${paint.dim('(입력은 화면에 안 보여요)')} › ` : question);
      output.muted = true;
      try {
        return (await ask('')).trim();
      } finally {
        output.muted = false;
        process.stdout.write('\n');
      }
    },

    step(index, total, title, note): void {
      for (const line of formatStep(index, total, title, note, width(), paint)) say(line);
    },

    summary(title, rows, next): void {
      for (const line of formatSummary(title, rows, next, width(), paint)) say(line);
    },

    say,
  };
  return opts.allowBack === true ? prompter : stayOnBack(prompter);
}

export interface ScriptedPrompter extends Prompter {
  readonly said: readonly string[];
  remaining(): number;
}

/**
 * Test double: answers are consumed in prompt order and every shown line is recorded. `choose` takes a number, value or
 * label ('' = default); `chooseMany` takes "1,3", "2-4", "all", "none", "+typed" ('' = the checked ones);
 * `chooseOrType` takes what `choose` does, and anything else is the typed answer.
 */
export function createScriptedPrompter(answers: readonly string[]): ScriptedPrompter {
  const queue = [...answers];
  const said: string[] = [];
  const next = (): string => {
    const value = queue.shift();
    if (value === undefined) throw new Error('Scripted prompter ran out of answers');
    if (value === '<') throw new PromptBack();
    return value;
  };

  return {
    said,
    remaining: () => queue.length,

    async choose(question, options, defaultIndex = 0): Promise<string> {
      void question;
      const answer = next().trim();
      const value = parseChoice(answer, options, defaultIndex);
      if (value === undefined) throw new Error(`Scripted answer is not one of the options: ${answer}`);
      return value;
    },

    async chooseMany(question, options, opts = {}): Promise<string[]> {
      said.push(question);
      const parsed = parseMany(next(), options, opts.type);
      if (!parsed.ok) throw new Error(`Invalid scripted answer: ${parsed.error}`);
      return parsed.values;
    },

    async chooseOrType(question, options, opts = {}): Promise<string> {
      void question;
      const answer = next().trim();
      const picked = answer === '' ? parseChoice('', options, opts.defaultIndex ?? 0) : matchOption(answer, options);
      if (picked !== undefined) return picked;
      if (opts.type === undefined) throw new Error(`Scripted answer is not one of the options: ${answer}`);
      const error = nonEmpty(opts.type.validate)(answer);
      if (error !== undefined) throw new Error(`Invalid scripted answer: ${error}`);
      return answer;
    },

    async text(question, opts): Promise<string> {
      void question;
      const raw = next().trim();
      const value = raw.length > 0 ? raw : (opts?.default ?? '');
      const error = opts?.validate?.(value);
      if (error !== undefined) throw new Error(`Invalid scripted answer: ${error}`);
      return value;
    },

    async secret(question): Promise<string> {
      void question;
      return next();
    },

    step(index, total, title, note): void {
      said.push(`${index}/${total} · ${title}`);
      if (note !== undefined) said.push(note);
    },

    summary(title, rows, nextLines): void {
      for (const line of formatSummary(title, rows, nextLines, 200, PLAIN)) said.push(line);
    },

    say(line: string): void {
      said.push(line);
    },
  };
}

/** Outside the numbered steps there is nowhere to go back to: "back" asks the same question again. */
export function stayOnBack(prompter: Prompter): Prompter {
  const wrapped: Prompter = { ...prompter };
  for (const name of ['choose', 'chooseMany', 'chooseOrType', 'text', 'secret'] as const) {
    const original = prompter[name] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (original === undefined) continue;
    (wrapped as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      for (;;) {
        try {
          return await original.apply(prompter, args);
        } catch (error) {
          if (!(error instanceof PromptBack)) throw error;
          prompter.say('여기서는 이전으로 갈 수 없어요.');
        }
      }
    };
  }
  return wrapped;
}
