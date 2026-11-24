import type { MessageHandler } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { SummaryCache } from './cache.js';
import type { OnboardingTexts } from './locale.js';
import type { RunReason, RunStateStore } from './state.js';

const PRIORITY = 86;

const START: readonly RegExp[] = [
  /^(?:처음|다시)?\s*알아보기(?:\s*시작)?[\s!?.~]*$/u,
  /^(?:get\s+to\s+know\s+me|rescan|start\s+(?:the\s+)?(?:first\s+look|scan))[\s!?.]*$/i,
];
const STOP: readonly RegExp[] = [
  /^알아보기\s*(?:멈춰|멈춰\s*줘|중단|그만)[\s!?.~]*$/u,
  /^stop\s+(?:the\s+)?(?:first\s+look|scan)[\s!?.]*$/i,
];
const RESUME: readonly RegExp[] = [
  /^알아보기\s*계속[\s!?.~]*$/u,
  /^resume\s+(?:the\s+)?(?:first\s+look|scan)[\s!?.]*$/i,
];
const STATUS: readonly RegExp[] = [
  /^알아보기\s*상태[\s!?.~]*$/u,
  /^(?:scan|first\s+look)\s+status[\s!?.]*$/i,
];

export interface OnboardingHandlerDeps {
  ctx: PluginContext;
  texts: OnboardingTexts;
  state: RunStateStore;
  cache: SummaryCache;
  start: (reason: RunReason) => 'started' | 'running';
  stop: () => 'stopped' | 'idle';
}

function matches(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Owner-only controls for the first look: start, stop, resume and status. */
export function onboardingControlsHandler(deps: OnboardingHandlerDeps): MessageHandler {
  return {
    id: 'onboarding.controls',
    priority: PRIORITY,
    async handle(message, replier) {
      if (!message.fromOwner) return 'pass';
      const text = message.text.trim();
      if (text === '') return 'pass';

      if (matches(STATUS, text)) {
        await replier.reply(message.conversation, { text: deps.texts.status(deps.state.current, deps.cache.size) });
        return 'handled';
      }

      if (matches(STOP, text)) {
        const result = deps.stop();
        await replier.reply(message.conversation, {
          text: result === 'stopped' ? deps.texts.stopped : deps.texts.notRunning,
        });
        return 'handled';
      }

      if (matches(RESUME, text)) {
        if (deps.state.current.status === 'running') {
          await replier.reply(message.conversation, { text: deps.texts.alreadyRunning });
          return 'handled';
        }
        if (deps.state.current.status !== 'paused') {
          await replier.reply(message.conversation, { text: deps.texts.notPaused });
          return 'handled';
        }
        const result = deps.start('manual');
        await replier.reply(message.conversation, {
          text: result === 'started' ? deps.texts.resumed : deps.texts.alreadyRunning,
        });
        return 'handled';
      }

      if (matches(START, text)) {
        const result = deps.start('manual');
        await replier.reply(message.conversation, {
          text: result === 'started' ? deps.texts.started : deps.texts.alreadyRunning,
        });
        return 'handled';
      }

      return 'pass';
    },
  };
}
