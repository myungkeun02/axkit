import type { Plugin } from '../../core/plugin/types.js';
import type { AxSnapshot } from './ax-tree.js';
import { ScreenReadError } from './ax-tree.js';
import type { DiscordScreen } from './discord/parse.js';
import { parseDiscordScreen } from './discord/parse.js';
import type { ScreenChatOptions } from './options.js';
import { scopedKv, screenChatConfig, screenChatDeps } from './options.js';
import type { PreviewRow } from './tracker.js';
import { PreviewTracker } from './tracker.js';

export type { ScreenChatOptions } from './options.js';

const JOB = 'discord-app.poll';
const BUNDLES = ['com.hnc.Discord', 'com.hnc.Discord.ptb', 'com.hnc.DiscordCanary'] as const;

function messageRowsOf(screen: DiscordScreen): PreviewRow[] {
  const view = screen.view;
  const visible = screen.messages.filter((message) => !message.bot);
  if (view.kind === 'dm') {
    return visible.map((message) => ({
      room: view.name,
      text: `${message.author}: ${message.text}`,
      unread: null,
      direct: true,
    }));
  }
  if (view.kind === 'channel') {
    const room = `#${view.channel} (${view.server})`;
    return visible.map((message) => ({
      room,
      text: `${message.author}: ${message.text}`,
      unread: null,
      direct: false,
    }));
  }
  return [];
}

/** Discord desktop, read only: no bot token, no user token, so the account is never touched. */
export function discordAppConnector(options: ScreenChatOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.discord-app',
      kind: 'connector',
      title: 'Discord app (screen reading, not a bot)',
    },
    setup(ctx) {
      const deps = screenChatDeps(options);
      const config = screenChatConfig(ctx.config);
      const dmTracker = new PreviewTracker(scopedKv(ctx.kv, 'dm'), 'discord');
      const messageTracker = new PreviewTracker(scopedKv(ctx.kv, 'messages'), 'discord');
      let warned = false;

      ctx.scheduler.add({
        name: JOB,
        schedule: { kind: 'every', seconds: config.pollSeconds },
        run: async (now) => {
          let snapshot: AxSnapshot | undefined;
          try {
            snapshot = await deps.reader.dump(BUNDLES);
          } catch (error) {
            if (error instanceof ScreenReadError && error.code === 'accessibility') {
              if (!warned) {
                ctx.log.warn('discord-app: Accessibility permission is not granted; run ax-kit doctor');
                warned = true;
              }
              return;
            }
            throw error;
          }
          if (snapshot === undefined || !snapshot.running) return;

          const screen = parseDiscordScreen(snapshot);
          const dmRows: PreviewRow[] = screen.dms
            .filter((dm) => dm.unread)
            .map((dm) => ({
              room: dm.name,
              text: '',
              unread: dm.mentions > 0 ? dm.mentions : 1,
              direct: true,
            }));
          const previews = [
            ...(await dmTracker.diff(dmRows, now)),
            ...(await messageTracker.diff(messageRowsOf(screen), now)),
          ];
          for (const preview of previews) await ctx.bus.emit('chat.preview', preview);
          if (previews.length > 0) ctx.log.info('discord-app: new chat previews', { count: previews.length });
        },
      });
    },
  };
}
