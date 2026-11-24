import type { OutgoingMessage } from '../../core/conversation/types.js';
import type { DiscordOutbound } from './port.js';

export const DISCORD_MESSAGE_LIMIT = 2000;
const MAX_BUTTONS = 25;
const CUSTOM_ID_LIMIT = 100;
const LABEL_LIMIT = 80;

/**
 * Discord rejects messages over 2000 characters. Prefer cutting after a newline so a chunk rarely
 * ends mid-sentence; fall back to a hard cut when one line is longer than the limit.
 */
export function splitForDiscord(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  if (text.length === 0) return [''];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const newline = rest.lastIndexOf('\n', limit - 1);
    const cut = newline >= 0 ? newline + 1 : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function clamp(value: string, limit: number): string {
  return value.slice(0, limit);
}

function toButton(choice: { id: string; label: string }, idPrefix: string): { customId: string; label: string } {
  return {
    customId: clamp(`${idPrefix}:${choice.id}`, CUSTOM_ID_LIMIT),
    label: clamp(choice.label, LABEL_LIMIT),
  };
}

/** Buttons ride on the last chunk so the reader reaches them after the text. */
export function toOutbound(message: OutgoingMessage, idPrefix: string): DiscordOutbound[] {
  const chunks = splitForDiscord(message.text);
  const outbound: DiscordOutbound[] = chunks.map((content) => ({ content }));
  const choices = (message.choices ?? []).slice(0, MAX_BUTTONS);
  if (choices.length === 0) return outbound;

  const last = outbound.at(-1);
  if (last !== undefined) {
    last.buttons = choices.map((choice) => toButton(choice, idPrefix));
  }
  return outbound;
}
