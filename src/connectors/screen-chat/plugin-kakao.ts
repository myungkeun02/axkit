import type { Plugin } from '../../core/plugin/types.js';
import type { AxSnapshot } from './ax-tree.js';
import { ScreenReadError } from './ax-tree.js';
import { parseKakaoList } from './kakao/parse.js';
import type { ScreenChatOptions } from './options.js';
import { screenChatConfig, screenChatDeps } from './options.js';
import { kakaoSendTool } from './send-kakao.js';
import { PreviewTracker } from './tracker.js';

export type { ScreenChatOptions } from './options.js';

const JOB = 'kakao-desktop.poll';
const BUNDLES = ['com.kakao.KakaoTalkMac'] as const;

/** KakaoTalk for Mac, read-only through the Accessibility API; sending uses kmsg by chat id only. */
export function kakaoDesktopConnector(options: ScreenChatOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.kakao-desktop',
      kind: 'connector',
      title: 'KakaoTalk for Mac (screen reading)',
    },
    setup(ctx) {
      const deps = screenChatDeps(options);
      const config = screenChatConfig(ctx.config);
      ctx.registerTool(
        kakaoSendTool({
          run: deps.run,
          reader: deps.reader,
          home: deps.home,
          exists: deps.fs.exists,
          listDir: deps.fs.listDir,
        }),
      );

      const tracker = new PreviewTracker(ctx.kv, 'kakao');
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
                ctx.log.warn('kakao-desktop: Accessibility permission is not granted; run ax-kit doctor');
                warned = true;
              }
              return;
            }
            throw error;
          }
          if (snapshot === undefined || !snapshot.running) return;

          const rows = parseKakaoList(snapshot, config.listLimit).map((row) => ({
            room: row.title,
            text: row.preview,
            unread: row.unread,
          }));
          const previews = await tracker.diff(rows, now);
          for (const preview of previews) await ctx.bus.emit('chat.preview', preview);
          if (previews.length > 0) ctx.log.info('kakao-desktop: new chat previews', { count: previews.length });
        },
      });
    },
  };
}
