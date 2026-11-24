import type { TurnStatus } from '../../core/contracts/assistant.js';
import type { CompletedTool, OutgoingMessage, TurnContext } from '../../core/conversation/types.js';
import type { BotReply } from './team-run.js';

/**
 * The part of the owner's turn a staff member's (or a bot's) own turn works under: its finished tools are kept in the
 * owner's pending entry under `<child>/<tool>`, so a restart in the middle of a team run tells each member what it
 * already did instead of running it again; cards it shows free the owner's conversation the same way.
 */
export function childContext(parent: TurnContext, child: string): TurnContext {
  const prefix = `${child}/`;
  const done = parent.onToolDone;
  const resumed = (parent.resumed ?? []).filter((tool) => tool.name.startsWith(prefix)).map((tool): CompletedTool => ({ ...tool, name: tool.name.slice(prefix.length) }));
  return {
    ...(done !== undefined ? { onToolDone: (tool: CompletedTool) => done({ ...tool, name: `${prefix}${tool.name}` }) } : {}),
    ...(resumed.length > 0 ? { resumed } : {}),
    ...(parent.awaitOwner !== undefined ? { awaitOwner: parent.awaitOwner } : {}),
  };
}

/** A bot's turn as the team code passes it on: its words, the page it left, how it ended. */
export function botReply(reply: OutgoingMessage, status: TurnStatus): BotReply {
  return reply.live !== undefined ? { text: reply.text, live: reply.live, status } : { text: reply.text, status };
}

/** What goes to the channel from a bot's (or team's) reply: never the internal status. */
export function outgoingOf(reply: BotReply): OutgoingMessage {
  return reply.live !== undefined ? { text: reply.text, live: reply.live } : { text: reply.text };
}
