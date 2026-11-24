import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import type { BrowserSkillDeps } from './deps.js';
import { liveInApp } from './deps.js';
import { LIVE_VIEW } from './output.js';
import { httpUrl } from './schema.js';

const input = z.object({
  url: httpUrl.describe('Page address, http or https only.'),
  on: z
    .enum(['app', 'mac'])
    .optional()
    .describe("'app': the owner's phone app browser screen (the default when it exists); 'mac': a window on this Mac's screen."),
});

export type BrowserOpenInput = z.infer<typeof input>;

export type BrowserOpenOutput =
  | { status: 'opened'; url?: string; message: string; guide: string; liveView?: 'browser-live' }
  | { status: 'failed'; message: string };

export function browserOpenTool(deps: BrowserSkillDeps): Tool<BrowserOpenInput, BrowserOpenOutput> {
  return {
    name: 'browser.open_for_me',
    description:
      "Open a page for the owner to sign in, pay or accept terms themselves: in the phone app's browser screen, or in a " +
      'visible window on this Mac. It returns at once; the assistant never drives that page.',
    input,
    effects: ['write'],
    describe(value) {
      return deps.texts.openDescription(value.url);
    },
    async run(value, runCtx) {
      if (value.on !== 'mac' && liveInApp(deps)) {
        deps.live?.offer(value.url, 'other', runCtx.call.conversation);
        return {
          status: 'opened',
          url: value.url,
          message: deps.texts.openedInApp(value.url),
          guide: deps.texts.guide('other', value.url, true),
          liveView: LIVE_VIEW,
        };
      }
      const open = deps.agent.openForHuman;
      if (open === undefined) return { status: 'failed', message: deps.texts.openUnavailable };
      void open.call(deps.agent, value.url).catch((error: unknown) => {
        deps.ctx.log.warn('browser: could not open the page for the owner', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return {
        status: 'opened',
        message: deps.texts.opened(value.url),
        guide: deps.texts.guide('other', value.url),
      };
    },
  };
}
