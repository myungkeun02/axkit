import type { AssistantRunner, RunnerInput, RunnerResult, TurnStatus } from '../../core/contracts/assistant.js';
import type { Bot, BotDirectory } from '../../core/contracts/bots.js';
import { botAddress } from '../../core/contracts/bots.js';
import type { IncomingMessage } from '../../core/conversation/types.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { AssistantTexts } from './locale.js';

/** What a server-started turn said and how it ended. */
export interface RunnerTurn {
  text: string;
  status: TurnStatus;
}

export interface RunnerDeps {
  clock: Clock;
  texts: AssistantTexts;
  bots(): BotDirectory | undefined;
  /** One main-chat turn. */
  turn(message: IncomingMessage): Promise<RunnerTurn>;
  /** One bot turn (its team, when it is a lead). */
  work(message: IncomingMessage, bot: Bot): Promise<RunnerTurn>;
}

/** Only a turn that answered counts as done; a partial one (tools ran, then it stopped) is not, so follow-ups stay. */
function outcome(status: TurnStatus): Pick<RunnerResult, 'ok' | 'reason' | 'status'> {
  return status.state === 'completed' ? { ok: true, status: 'completed' } : { ok: false, reason: status.reason, status: status.state };
}

/**
 * Turns the server starts itself (routines, follow-ups), built the way `bots.delegate` builds them: the text is the
 * owner's own standing request, so it counts as from the owner and every tool still goes through the policy.
 */
export function assistantRunner(deps: RunnerDeps): AssistantRunner {
  const message = (input: RunnerInput, address: string): IncomingMessage => ({
    id: `${input.source}:${deps.clock.now().getTime()}`,
    conversation: { channelId: 'core.routines', address },
    authorId: 'assistant',
    // the owner set this up in their own words; it runs as if they had just asked
    fromOwner: true,
    text: input.text,
    receivedAt: deps.clock.now(),
  });
  return {
    async run(input): Promise<RunnerResult> {
      if (input.bot === undefined) {
        const { text, status } = await deps.turn(message(input, input.source));
        return { text, ...outcome(status) };
      }
      const directory = deps.bots();
      const bot = await directory?.get(input.bot);
      if (directory === undefined || bot === undefined || bot.status === 'off') throw new Error(`No active bot "${input.bot}"`);
      await directory.setStatus(bot.id, 'working', input.text.slice(0, 80)).catch(() => undefined);
      try {
        const { text, status } = await deps.work(message(input, botAddress(bot.id)), bot);
        return { text, ...outcome(status), bot: { id: bot.id, name: bot.name } };
      } finally {
        await directory.setStatus(bot.id, 'idle').catch(() => undefined);
      }
    },
  };
}
