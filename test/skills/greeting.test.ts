import { describe, expect, it } from 'vitest';
import type { IncomingMessage, MessageHandler, Replier } from '../../src/core/conversation/types.js';
import type { Plugin, PluginContext } from '../../src/core/plugin/types.js';
import { greetingSkill } from '../../src/skills/greeting/plugin.js';
import { hasBatchim } from '../../src/skills/greeting/korean.js';
import { createTestContext } from '../support/context.js';

async function captureHandler(plugin: Plugin, name: string, language: 'ko' | 'en'): Promise<MessageHandler> {
  let captured: MessageHandler | undefined;
  const { ctx } = createTestContext({ assistant: { name, language } });
  const context: PluginContext = {
    ...ctx,
    registerHandler: (handler) => {
      captured = handler;
    },
  };

  await plugin.setup(context);
  if (captured === undefined) throw new Error('handler was not registered');
  return captured;
}

function message(text: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'c1', address: 'a1' },
    authorId: 'owner',
    fromOwner: true,
    text,
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

async function reply(
  handler: MessageHandler,
  text: string,
  overrides: Partial<IncomingMessage> = {},
): Promise<{ result: string; replies: string[] }> {
  const replies: string[] = [];
  const replier: Replier = {
    reply: async (_to, outgoing) => {
      replies.push(outgoing.text);
    },
  };
  const result = await handler.handle(message(text, overrides), replier);
  return { result, replies };
}

describe('hasBatchim', () => {
  it('detects final consonants', () => {
    expect(hasBatchim('하늘')).toBe(true);
    expect(hasBatchim('나비')).toBe(false);
  });

  it('returns undefined for non-Hangul or empty words', () => {
    expect(hasBatchim('Max')).toBeUndefined();
    expect(hasBatchim('')).toBeUndefined();
  });
});

describe('greeting skill', () => {
  it('uses 이에요 after a final consonant', async () => {
    const handler = await captureHandler(greetingSkill(), '하늘', 'ko');
    const { result, replies } = await reply(handler, '안녕');
    expect(result).toBe('handled');
    expect(replies).toEqual(['안녕하세요! 하늘이에요. 무엇을 도와드릴까요?']);
  });

  it('uses 예요 without a final consonant', async () => {
    const handler = await captureHandler(greetingSkill(), '나비', 'ko');
    expect((await reply(handler, '안녕!!')).replies).toEqual(['안녕하세요! 나비예요. 무엇을 도와드릴까요?']);
  });

  it('falls back to 이에요 for a non-Hangul name', async () => {
    const handler = await captureHandler(greetingSkill(), 'Max', 'ko');
    expect((await reply(handler, '안녕하세요~~ㅎㅎ')).replies).toEqual(['안녕하세요! Max이에요. 무엇을 도와드릴까요?']);
  });

  it('replies in English when configured', async () => {
    const handler = await captureHandler(greetingSkill(), 'Max', 'en');
    expect((await reply(handler, 'hello!')).replies).toEqual(["Hi! I'm Max. How can I help?"]);
  });

  it('passes on non-greetings and non-owner messages', async () => {
    const handler = await captureHandler(greetingSkill(), '비서', 'ko');
    expect((await reply(handler, '오늘 날씨 어때?')).result).toBe('pass');
    expect((await reply(handler, '안녕', { fromOwner: false })).result).toBe('pass');
  });
});
