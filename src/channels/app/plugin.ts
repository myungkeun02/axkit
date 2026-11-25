import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Contracts } from '../../core/contracts/index.js';
import type { OutgoingMessage } from '../../core/conversation/types.js';
import type { Plugin } from '../../core/plugin/types.js';
import { Caps } from '../../core/plugin/types.js';
import { AppConfirmer } from './confirm.js';
import { appTexts } from './locale.js';
import { AppEventLog } from './log.js';
import { Presence } from './presence.js';
import type { ChoiceView } from './protocol.js';
import { CHANNEL_ID, registerAppRoutes } from './routes.js';
import { AppActivity } from './activity.js';
import { AppViews } from './views.js';
import { autonomyView } from './views/autonomy.js';
import { calendarView } from './views/calendar.js';
import { botsView } from './views/bots.js';
import { botOfAddress } from '../../core/contracts/bots.js';
import { todayView } from './today-view.js';
import type { UsageBudget } from './builtin-views.js';
import { approvalsView, healthView, improvementsView, usageView } from './builtin-views.js';
import { spendingView } from './views/spending.js';
import type { ApnsTransport } from './apns.js';
import { setupDelivery } from './delivery.js';
import { APNS_SECRETS } from './push.js';
import { modelTiersView, providersView, registerProviderRoutes } from './views/ai.js';
import { jobsView } from './views/jobs.js';
import { hardwareView } from './views/hardware.js';
import { featuresBlocksView, workBlocksView } from './views/blocks.js';
import { GeoCache, routesView } from './views/routes.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import { BotAvatars, avatarRef } from './avatars.js';
import { composer } from '../../core/bots/composition.js';
import { describeTeam } from '../../core/bots/describe-team.js';
import { refineInstructions } from '../../core/bots/teams.js';
import { modelsView } from './views/models.js';
import { browserLiveView, registerBrowserLiveRoutes } from './browser-live.js';

export interface AppChannelOptions {
  expiresMinutes: number;
  /** Shown next to AI usage; the gateway enforces it, the view only reports it. */
  budget?: UsageBudget;
  /** ~/.ax-kit/files/inbox; without it shared files are refused. */
  inboxDir?: string;
  /** ~/.ax-kit/files/app: pictures sent to the app (§7.5); without it only https pictures go through. */
  filesDir?: string;
  /** Tests answer APNs without a network request. */
  apnsTransport?: ApnsTransport;
  newId?: () => string;
}

function choices(message: OutgoingMessage): { choices?: ChoiceView[] } {
  const list = (message.choices ?? []).slice(0, 10).map((choice) => ({ id: choice.id, label: choice.label }));
  return list.length > 0 ? { choices: list } : {};
}

/**
 * The phone (and later desktop) app as a channel: chat, confirmation cards and notices over the phone bridge's
 * authenticated routes. Delivery to a sleeping phone is the app's job (a live stream or a periodic sync); quiet hours
 * and the daily notice budget stay in the core notifier, before anything reaches this channel.
 */
export function appChannel(opts: AppChannelOptions): Plugin {
  return {
    manifest: {
      id: CHANNEL_ID,
      kind: 'channel',
      title: 'Phone app',
      needs: [Contracts.deviceApi],
      secrets: [APNS_SECRETS.key, APNS_SECRETS.keyId, APNS_SECRETS.teamId],
    },
    setup(ctx) {
      const texts = appTexts(ctx.assistant.language);
      const log = new AppEventLog(ctx.kv, ctx.clock);
      const presence = new Presence(ctx.kv, ctx.clock);
      const api = ctx.use(Contracts.deviceApi);
      const views = new AppViews(ctx.log);
      // R13: bot pictures next to the app's files, never pruned with them
      const avatars = opts.filesDir !== undefined ? new BotAvatars(join(dirname(opts.filesDir), 'avatars'), ctx) : undefined;
      const delivery = setupDelivery({
        ctx,
        ...(avatars !== undefined ? { extraFiles: async (id: string) => await avatars.read(id) } : {}),
        api,
        log,
        presence,
        texts,
        ...(opts.filesDir !== undefined ? { filesDir: opts.filesDir } : {}),
        ...(opts.apnsTransport !== undefined ? { apnsTransport: opts.apnsTransport } : {}),
        onPushReady: () => {
          views.addFeature('push');
        },
      });
      const confirmer = new AppConfirmer({
        log,
        clock: ctx.clock,
        expiresMs: opts.expiresMinutes * 60_000,
        texts,
        media: delivery.media,
        ...(opts.newId !== undefined ? { newId: opts.newId } : {}),
      });
      const activity = new AppActivity(CHANNEL_ID, ctx.clock, ctx.assistant.language !== 'en');
      activity.attach(ctx.bus);
      registerAppRoutes(api, {
        ctx,
        log,
        confirmer,
        presence,
        texts,
        activity,
        ...(opts.inboxDir !== undefined ? { inboxDir: opts.inboxDir } : {}),
      });
      views.mount(api);
      // D7: place coordinates for events, once Kakao Local is connected (ko-life)
      const geo = new GeoCache(ctx, () => ctx.tryUse(Contracts.places));
      views.register(todayView(ctx, log, geo));
      views.register(approvalsView(log, ctx));
      const autonomy = ctx.tryUse(Contracts.autonomy);
      if (autonomy !== undefined) {
        views.register(autonomyView(autonomy, ctx.assistant.language, ctx.tryUse(Contracts.autonomyPromotion)));
        views.addFeature('remember');
      }
      if (ctx.scheduler.list !== undefined) views.register(jobsView(ctx));
      views.register(
        hardwareView(ctx, {
          run: nodeProcessRunner,
          version: async () => ((JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0'),
        }),
      );
      const llm = ctx.llm;
      if (llm.describe !== undefined) views.register(modelsView(ctx, () => llm.describe?.() ?? { routes: [], activeProviders: [], circuits: [] }));
      registerProviderRoutes(api, () => ctx.tryUse(Contracts.llmControl));
      const llmControl = ctx.tryUse(Contracts.llmControl);
      if (llmControl !== undefined) {
        views.register(providersView(llmControl));
        views.register(modelTiersView(ctx, llmControl));
        views.addFeature('ai-connect');
        views.addFeature('model-tiers');
      }
      // Capabilities from plugins set up after this one exist only once the app has started.
      ctx.bus.on('app.started', () => {
        // after start, so a calendar connector set up later is seen (and its write enables "add")
        views.register(calendarView(ctx, ctx.tryUse(Contracts.places) !== undefined ? geo : undefined));
        if (ctx.tryUse(Contracts.routes) !== undefined && ctx.tryUse(Contracts.places) !== undefined) {
          views.register(routesView(ctx, geo));
          views.addFeature('routes');
        }
        // R9: server-drawn screens (after start, so connectors set up later count)
        views.register(featuresBlocksView(ctx, () => views.features()));
        if (ctx.tryUse(Contracts.workLog) !== undefined) views.register(workBlocksView(ctx));
        views.addFeature('blocks');
        if (ctx.tryUse(Contracts.usage) !== undefined) views.register(usageView(ctx, opts.budget));
        if (ctx.tryUse(Contracts.docs) !== undefined) views.register(improvementsView(ctx));
        if (ctx.tryUse(Contracts.health) !== undefined) views.register(healthView(ctx));
        if (ctx.tryUse(Contracts.spendRead) !== undefined) views.register(spendingView(ctx));
        // §22: only when the browser adapter can draw a page the owner drives from here
        const hub = ctx.tryUse(Contracts.browserLive);
        if (hub !== undefined) {
          views.register(browserLiveView({ ctx, api, log, hub }));
          registerBrowserLiveRoutes({ ctx, api, log, hub });
          views.addFeature('browser-live');
        }
      });
      ctx.provide(Contracts.appViews, views);
      if (delivery.share !== undefined) ctx.provide(Contracts.appShare, delivery.share);

      const roomOf = async (address: string): Promise<{ channel?: string; author?: { id: string; name: string } }> => {
        const id = botOfAddress(address);
        if (id === undefined) return {};
        const bots = ctx.tryUse(Contracts.bots);
        const team = id.startsWith('team-') ? (await bots?.teams())?.find((item) => item.id === id) : undefined;
        if (team !== undefined) {
          const lead = await bots?.get(team.lead);
          return { channel: id, author: { id: team.lead, name: lead?.name ?? team.name } };
        }
        if (id.startsWith('meet-')) return { channel: id, author: { id: 'assistant', name: ctx.assistant.name } };
        const bot = await bots?.get(id);
        return { channel: id, author: { id, name: bot?.name ?? id } };
      };
      const directory = ctx.tryUse(Contracts.bots);
      if (directory !== undefined) {
        views.register(
          botsView({
            directory,
            assistant: ctx.assistant,
            avatarOf: async (id) => ((await avatars?.has(id)) === true ? avatarRef(id) : undefined),
            control: () => ctx.tryUse(Contracts.llmControl),
            requestMeeting: async (group, topic) => {
              await ctx.bus.emit('bots.meeting_requested', { group, topic });
            },
            refine: (team) => void refineInstructions(ctx.llm, directory, team, ctx.assistant.language !== 'en').catch(() => 0),
            compose: composer(ctx.llm, async () => (await ctx.tryUse(Contracts.llmControl)?.overBudget()) ?? false, ctx.assistant.language !== 'en'),
            describe: (text) => describeTeam(ctx.llm, text, ctx.assistant.language !== 'en'),
            now: () => ctx.clock.now(),
          }),
        );
        views.addFeature('bot-teams');
        if (avatars !== undefined) {
          const fill = async (): Promise<void> => {
            await avatars.fill(directory);
          };
          ctx.scheduler.add({ name: 'app.bots.avatars', label: ctx.assistant.language === 'en' ? 'Bot pictures' : '봇 캐릭터 그림', schedule: { kind: 'every', seconds: 600 }, run: fill });
        }
        views.addFeature('bots');
        views.addFeature('delegation');
        // POST share takes x-channel: a file shared in a team or bot room lands there
        if (opts.inboxDir !== undefined) views.addFeature('share-rooms');
      }
      ctx.bus.on('bots.message', async ({ bot, text, channel, to }) => {
        await log.append({ type: 'message', role: 'assistant', text, channel: channel ?? bot.id, author: bot, ...(to !== undefined ? { to } : {}) });
      });
      ctx.bus.on('bots.delegation', async (event) => {
        await log.append({
          type: 'delegation',
          bot: event.bot,
          botChannel: event.bot.id,
          task: event.task,
          state: event.state,
          ...(event.summary !== undefined ? { summary: event.summary } : {}),
        });
      });

      ctx.use(Caps.channels).register({
        id: CHANNEL_ID,
        replier: {
          async reply(to, message) {
            const media = await delivery.media(message.images);
            const room = await roomOf(to.address);
            // §22: the app shows its "open the browser screen" button from this field, not from the wording
            const live = message.live !== undefined ? { live: message.live } : {};
            await log.append({ type: 'message', role: 'assistant', text: message.text, ...choices(message), ...live, ...media, ...room });
          },
        },
        owner: {
          async send(message, options) {
            const media = await delivery.media(message.images);
            // §4: the kind lets the app group notices; `live` shows the "open the browser screen" button (§22)
            const kind = options?.kind !== undefined ? { kind: options.kind } : {};
            const live = message.live !== undefined ? { live: message.live } : {};
            await log.append({ type: 'notice', text: message.text, ...choices(message), ...kind, ...live, ...media });
          },
        },
        confirmer,
        present: () => presence.anyStream(),
      });

      return {
        async start() {
          await presence.reset();
          await confirmer.expireStale();
          await delivery.start();
        },
        async stop() {
          await delivery.stop();
        },
      };
    },
  };
}
