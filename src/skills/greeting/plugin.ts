import type { MessageHandler } from '../../core/conversation/types.js';
import type { Plugin } from '../../core/plugin/types.js';
import { hasBatchim } from './korean.js';

/** Longest alternatives first so the regex engine settles on one match. */
const GREETING = /^(?:안녕하세요|안녕|안뇽|하이|hello|hey|hi)[!?.\s~ㅎㅋ]*$/i;

const HANDLER_ID = 'greeting';
const PRIORITY = 100;

export function greetingSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.greeting',
      kind: 'skill',
      title: 'Greeting',
    },
    setup(ctx) {
      const name = ctx.assistant.name;
      const reply =
        ctx.assistant.language === 'en'
          ? `Hi! I'm ${name}. How can I help?`
          : `안녕하세요! ${name}${hasBatchim(name) === false ? '예요' : '이에요'}. 무엇을 도와드릴까요?`;

      const handler: MessageHandler = {
        id: HANDLER_ID,
        priority: PRIORITY,
        async handle(message, replier) {
          if (!message.fromOwner) return 'pass';
          if (!GREETING.test(message.text.trim())) return 'pass';
          await replier.reply(message.conversation, { text: reply });
          return 'handled';
        },
      };
      ctx.registerHandler(handler);
    },
  };
}
