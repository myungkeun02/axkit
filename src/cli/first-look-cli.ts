import type { FirstLookResult } from '../skills/assistant/first-look.js';
import type { FirstLookView, LocalApi } from './first-look-api.js';
import { localApi } from './first-look-api.js';
import { progressLine, progressLines, remainingMs, resultLines, treeLines } from './first-look-render.js';
import type { Prompter } from './prompter.js';
import { PromptCancelled } from './prompter.js';
import type { Paint } from './style.js';
import { PLAIN, paintFor } from './style.js';

export interface FirstLookCliDeps {
  prompter: Prompter;
  api: LocalApi;
  /** Where the live bar is drawn; on a TTY it redraws in place, otherwise it prints a plain line when something moved. */
  out: { tty: boolean; write(text: string): void; columns(): number };
  paint?: Paint;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Ctrl+C while the bar runs: registers the handler and returns how to remove it. */
  onInterrupt(handler: () => void): () => void;
  pollMs?: number;
  /** How long to wait for a just-started assistant to answer. */
  waitServerMs?: number;
}

export type WatchEnd = 'done' | 'background' | 'failed' | 'paused' | 'idle' | 'unreachable';

const POLL_MS = 1_000;
const WAIT_SERVER_MS = 60_000;
/** Longer than this still to go and the owner may leave it to run in the background. */
const LONG_MS = 5 * 60_000;
const ASK_AFTER_MS = 10_000;
const LINES = 3;
const BACKGROUND = '백그라운드에서 계속 알아볼게요. 진행은 `ax-kit onboarding status`, 결과 확인·고치기는 `ax-kit onboarding review`로 볼 수 있어요.';
const EXAMPLE = '예: "에이컴퍼니랑 베타랩은 따로야. 쇼핑몰 앱은 베타랩 아래"';

async function reach(deps: FirstLookCliDeps): Promise<FirstLookView | undefined> {
  const deadline = deps.now() + (deps.waitServerMs ?? WAIT_SERVER_MS);
  let told = false;
  for (;;) {
    const view = await deps.api.view();
    if (view !== undefined || deps.now() >= deadline) return view;
    if (!told) deps.prompter.say('비서가 켜지기를 기다리는 중이에요…');
    told = true;
    await deps.sleep(POLL_MS);
  }
}

/** Draws the bar in place on a terminal; on a pipe prints one line per phase or 10% step. */
function drawer(deps: FirstLookCliDeps): { draw(view: FirstLookView): void; end(): void } {
  let drawn = false;
  let last = '';
  return {
    draw(view) {
      if (!deps.out.tty) {
        const key = `${view.status}:${view.phase}:${Math.floor(view.percent / 10)}`;
        if (key !== last) deps.out.write(`${progressLine(view, deps.now())}\n`);
        last = key;
        return;
      }
      const lines = progressLines(view, { width: Math.max(30, deps.out.columns() - 1), paint: deps.paint ?? PLAIN, nowMs: deps.now() });
      deps.out.write(`${drawn ? `\u001b[${LINES}A` : ''}${lines.map((line) => `\u001b[2K\r${line}`).join('\n')}\n`);
      drawn = true;
    },
    end() {
      drawn = false;
    },
  };
}

/**
 * The live first-look bar, polled through the local token until it finishes. Ctrl+C (or "백그라운드로 두고 끝내기"
 * when it will take long) leaves it running in the assistant and says where to look later.
 */
export async function watchFirstLook(deps: FirstLookCliDeps, opts: { start: boolean }): Promise<{ end: WatchEnd; view?: FirstLookView }> {
  const { prompter } = deps;
  let view = await reach(deps);
  if (view === undefined) {
    prompter.say('비서에 연결하지 못했어요. 비서가 켜진 뒤 `ax-kit onboarding status`로 진행을 볼 수 있어요.');
    return { end: 'unreachable' };
  }
  if (view.status === 'idle') {
    if (!opts.start) {
      prompter.say('처음 알아보기를 아직 시작하지 않았어요. 대화창에서 "처음 알아보기"라고 하거나 `ax-kit onboarding restart`로 시작해요.');
      return { end: 'idle', view };
    }
    const started = await deps.api.act('first-look', 'start');
    if (!started.ok) {
      prompter.say(started.message ?? '처음 알아보기를 시작하지 못했어요. 대화창에서 "처음 알아보기"라고 하면 시작해요.');
      return { end: 'idle', view };
    }
    view = (await deps.api.view()) ?? view;
  }
  if (view.status === 'done') {
    drawer(deps).draw(view);
    return { end: 'done', view };
  }

  let interrupted = false;
  const release = deps.onInterrupt(() => {
    interrupted = true;
  });
  const bar = drawer(deps);
  let asked = false;
  if (view.status === 'running') prompter.say('Ctrl+C를 누르면 백그라운드로 두고 끝내요 (알아보기는 계속돼요).');
  try {
    for (;;) {
      bar.draw(view);
      if (view.status !== 'running' || interrupted) break;
      const left = remainingMs(view, deps.now());
      const spent = view.startedAt === null ? 0 : deps.now() - Date.parse(view.startedAt);
      if (!asked && left !== undefined && left > LONG_MS && spent > ASK_AFTER_MS) {
        asked = true;
        bar.end();
        const minutes = Math.ceil(left / 60_000);
        const choice = await prompter
          .choose(`꽤 오래 걸릴 것 같아요 (약 ${minutes}분 남음). 어떻게 할까요?`, [
            { value: 'wait', label: '여기서 기다리기' },
            { value: 'background', label: '백그라운드로 두고 끝내기', hint: '끝나면 대화창으로 알려 드려요.' },
          ], 0)
          .catch((error: unknown) => {
            if (error instanceof PromptCancelled) return 'background';
            throw error;
          });
        if (choice === 'background') interrupted = true;
        continue;
      }
      await deps.sleep(deps.pollMs ?? POLL_MS);
      view = (await deps.api.view()) ?? view;
    }
  } finally {
    release();
  }
  if (interrupted && view.status === 'running') {
    prompter.say(BACKGROUND);
    return { end: 'background', view };
  }
  if (view.status === 'failed') {
    prompter.say(`알아보기가 멈췄어요${view.error !== undefined ? ` (${view.error})` : ''}. 대화창에서 "알아보기 계속"이라고 하면 이어서 해요.`);
    return { end: 'failed', view };
  }
  if (view.status === 'paused') {
    prompter.say('알아보기가 멈춰 있어요. 대화창에서 "알아보기 계속"이라고 하면 이어서 해요.');
    return { end: 'paused', view };
  }
  return { end: view.status === 'done' ? 'done' : 'idle', view };
}

function say(prompter: Prompter, lines: readonly string[]): void {
  for (const line of lines) prompter.say(line);
}

/**
 * "당신은 이런 사람이군요" and the proposed company → project → team tree, then 이대로 만들기 / 말로 고치기 / 앱에서
 * 나중에. "말로 고치기" sends the owner's sentence to `first-look/revise` and shows the new tree, as often as needed.
 */
export async function reviewFirstLook(deps: FirstLookCliDeps, given?: FirstLookResult): Promise<'built' | 'later' | 'none'> {
  const { prompter, api } = deps;
  const result = given ?? (await api.view())?.result;
  if (result === undefined) {
    prompter.say('아직 보여 드릴 결과가 없어요. 처음 알아보기가 끝나면 다시 해 주세요.');
    return 'none';
  }
  say(prompter, resultLines(result));
  if (result.plan?.status !== 'proposed') {
    prompter.say(result.plan?.status === 'applied' ? '이 구조로 팀을 이미 만들었어요. 봇 목록에서 고칠 수 있어요.' : '지금 고칠 팀 구조 제안이 없어요.');
    return 'none';
  }
  for (;;) {
    prompter.say('');
    const choice = await prompter.choose('이 구조로 일을 나눠 맡을 봇 팀을 만들까요? (나중에 바꿀 수 있어요)', [
      { value: 'build', label: '이대로 만들기' },
      { value: 'revise', label: '말로 고치기', hint: EXAMPLE },
      { value: 'later', label: '앱에서 나중에', hint: '앱의 "팀 구조" 화면이나 대화창에서 고칠 수 있어요.' },
    ], 0);
    if (choice === 'later') {
      prompter.say('나중에 앱의 "팀 구조"나 `ax-kit onboarding review`에서 이어서 해요.');
      return 'later';
    }
    if (choice === 'build') {
      const built = await api.act('team-plan', 'apply');
      if (!built.ok) {
        prompter.say('팀을 만들지 못했어요. 비서가 켜져 있는지 확인하고 `ax-kit onboarding review`로 다시 해 주세요.');
        return 'later';
      }
      const teams = Number(built.data?.['teams'] ?? 0);
      const routines = Number(built.data?.['routines'] ?? 0);
      prompter.say(`팀 ${teams}개${routines > 0 ? `와 루틴 ${routines}개` : ''}를 만들었어요. 봇 목록에서 볼 수 있어요.`);
      return 'built';
    }
    const words = await prompter.text(`어떻게 고칠까요? (${EXAMPLE})`, { validate: (value) => (value.trim() === '' ? '고칠 내용을 적어 주세요.' : undefined) });
    prompter.say('고치는 중이에요…');
    const revised = await api.act('first-look', 'revise', { text: words });
    if (!revised.ok) {
      prompter.say(revised.message ?? '고치지 못했어요. 잠시 뒤 다시 해 주세요.');
      continue;
    }
    const text = revised.data?.['text'];
    if (typeof text === 'string') prompter.say(text);
    const next = revised.data?.['result'] as FirstLookResult | undefined;
    if (next !== undefined) say(prompter, ['', ...treeLines(next)]);
  }
}

/** Setup's last step and `ax-kit onboarding review`: the bar until it finishes, then the result and the correction loop. */
export async function followFirstLook(deps: FirstLookCliDeps, opts: { start: boolean }): Promise<WatchEnd | 'built' | 'later' | 'none'> {
  try {
    const watched = await watchFirstLook(deps, opts);
    if (watched.end !== 'done') return watched.end;
    return await reviewFirstLook(deps, watched.view?.result);
  } catch (error) {
    if (!(error instanceof PromptCancelled)) throw error;
    deps.prompter.say('');
    deps.prompter.say(BACKGROUND);
    return 'background';
  }
}

/** The real terminal, the real local API. */
export function nodeFirstLookDeps(home: string, prompter: Prompter): FirstLookCliDeps {
  const tty = process.stdout.isTTY === true;
  return {
    prompter,
    api: localApi(home),
    out: { tty, write: (text) => void process.stdout.write(text), columns: () => (process.stdout.columns > 0 ? process.stdout.columns : 80) },
    paint: paintFor(tty),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    onInterrupt: (handler) => {
      process.on('SIGINT', handler);
      return () => void process.off('SIGINT', handler);
    },
  };
}
