import { Contracts } from '../../core/contracts/index.js';
import type { ChatAwaiting } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { APPOINTMENTS_JOB, runAppointments } from './appointments.js';
import { registerButtons } from './buttons.js';
import { readChatInboxConfig } from './config.js';
import type { ChatInboxDeps } from './deps.js';
import { handlePreview, handleSms } from './intake.js';
import { chatTexts } from './locale.js';
import { registerReplies } from './replies.js';
import { ChatInboxStore } from './store.js';
import { chatPendingTool } from './tools-pending.js';

/**
 * What to do with screen-read chat previews: card alerts to the spending skill, contact memory, unanswered-room
 * digests and appointment suggestions. Every external capability is optional and resolved at run time.
 */
export interface ChatInboxOptions {
  /** False when skill.sms-reader owns text messages: it checks for smishing before any reservation card. */
  smsAppointments?: boolean;
}

export function chatInboxSkill(options: ChatInboxOptions = {}): Plugin {
  return {
    manifest: {
      id: 'skill.chat-inbox',
      kind: 'skill',
      title: 'Chat inbox (screen-read chat previews)',
    },
    async setup(ctx) {
      const config = readChatInboxConfig(ctx);
      const texts = chatTexts(ctx.assistant.language);
      const store = new ChatInboxStore(ctx.kv, ctx.log);
      await store.load();
      const deps: ChatInboxDeps = { ctx, store, texts, config };

      ctx.bus.on('chat.preview', (preview) => handlePreview(deps, preview));
      if (config.sms && options.smsAppointments !== false) ctx.bus.on('phone.sms', (sms) => handleSms(deps, sms));
      ctx.bus.on('tuning.apply', async (change) => {
        if (change.domain !== 'chat.appointment') return;
        if (change.action === 'mute') await store.muteRoom(change.subject);
        else if (change.action === 'unmute') await store.unmuteRoom(change.subject);
      });

      ctx.provide(Contracts.chatAwaiting, {
        async awaiting(limit) {
          return store
            .pendingEntries()
            .flatMap((entry): ChatAwaiting[] =>
              entry.app === 'kakao' || entry.app === 'discord'
                ? [{ app: entry.app, room: entry.room, text: entry.lastText, at: entry.firstAt, unread: entry.unread }]
                : [],
            )
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, Math.max(0, limit));
        },
      });
      ctx.registerTool(chatPendingTool(store));
      registerButtons(deps);
      registerReplies(deps);

      if (config.appointments) {
        ctx.scheduler.add({
          name: APPOINTMENTS_JOB,
          schedule: { kind: 'every', seconds: config.appointmentSeconds },
          run: () => runAppointments(deps),
        });
      }
    },
  };
}
