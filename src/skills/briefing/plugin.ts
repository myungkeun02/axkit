import { z } from 'zod';
import type { OutgoingMessage } from '../../core/conversation/types.js';
import { Contracts } from '../../core/contracts/index.js';
import type { GeoPoint } from '../../core/contracts/index.js';
import type { Logger } from '../../core/log/types.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import { gatherBriefing } from './gather.js';
import type { BriefingSources } from './gather.js';
import { briefingTexts } from './locale.js';
import { renderBriefing } from './render.js';

const PLUGIN_ID = 'skill.briefing';
const KIND = 'briefing.morning';
const JOB_NAME = 'briefing.morning';
const FIRST_SENT_KEY = 'firstSentAt';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_AT = '08:00';
const DEFAULT_MAIL_LIMIT = 5;

const HomeSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().optional(),
});

const ConfigSchema = z.object({
  at: z.string().regex(HHMM).default(DEFAULT_AT),
  mailLimit: z.number().int().min(1).max(50).default(DEFAULT_MAIL_LIMIT),
  weatherHome: HomeSchema.optional(),
});

type BriefingConfig = z.infer<typeof ConfigSchema>;

const DEFAULTS: BriefingConfig = { at: DEFAULT_AT, mailLimit: DEFAULT_MAIL_LIMIT };

function readConfig(ctx: PluginContext): BriefingConfig {
  const parsed = ConfigSchema.safeParse(ctx.config);
  if (parsed.success) return parsed.data;
  ctx.log.warn('briefing: invalid config, using defaults', { issues: parsed.error.issues.length });
  return DEFAULTS;
}

/** Resolved on every run: connectors may be added, disabled or replaced after setup. */
function sourcesOf(ctx: PluginContext): BriefingSources {
  const calendar = ctx.tryUse(Contracts.calendarRead);
  const mail = ctx.tryUse(Contracts.mailRead);
  const todo = ctx.tryUse(Contracts.todoRead);
  return {
    ...(calendar !== undefined ? { calendar } : {}),
    ...(mail !== undefined ? { mail } : {}),
    ...(todo !== undefined ? { todo } : {}),
  };
}

/** Phone location first, then the configured weatherHome; the briefing never asks the owner. */
async function weatherPointOf(
  ctx: PluginContext,
  home: { lat: number; lng: number } | undefined,
  log: Logger,
): Promise<GeoPoint | undefined> {
  const phone = ctx.tryUse(Contracts.phoneSignals);
  if (phone !== undefined) {
    try {
      // overnight the phone may not have reported for hours; where it last was is still the best guess at 8 a.m.
      const location = await phone.latestLocation(24 * 60);
      if (location !== undefined) return { lat: location.lat, lng: location.lng };
    } catch (error) {
      log.warn('briefing: phone location unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (home !== undefined) return { lat: home.lat, lng: home.lng };
  const learned = await ctx.tryUse(Contracts.knownPlaces)?.get().catch(() => undefined);
  if (learned?.home !== undefined) return learned.home;
  // nothing known yet: the zone's capital, so the first briefings still carry the weather
  return CAPITALS[ctx.assistant.timezone];
}

const CAPITALS: Record<string, GeoPoint> = { 'Asia/Seoul': { lat: 37.5665, lng: 126.978 } };

async function buildMessage(
  ctx: PluginContext,
  config: BriefingConfig,
  now: Date,
  log: Logger,
): Promise<{ ymd: string; message: OutgoingMessage }> {
  const weather = ctx.tryUse(Contracts.weather);
  const point =
    weather === undefined ? undefined : await weatherPointOf(ctx, config.weatherHome, log);
  const data = await gatherBriefing(now, {
    sources: sourcesOf(ctx),
    timeZone: ctx.assistant.timezone,
    mailLimit: config.mailLimit,
    ...(weather !== undefined ? { weather: { source: weather, ...(point !== undefined ? { point } : {}) } } : {}),
    log,
  });
  const message = renderBriefing(data, {
    texts: briefingTexts(ctx.assistant.language),
    timeZone: ctx.assistant.timezone,
    ...(ctx.assistant.ownerName !== undefined ? { ownerName: ctx.assistant.ownerName } : {}),
  });
  return { ymd: data.date.ymd, message };
}

/** One briefing, one notice. Returns false when there is nowhere to send it. */
async function sendBriefing(ctx: PluginContext, config: BriefingConfig, now: Date): Promise<boolean> {
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('briefing: no notifier available; briefing skipped');
    return false;
  }
  const { ymd, message } = await buildMessage(ctx, config, now, ctx.log);
  await notifier.notify({ ...message, kind: KIND, dedupeKey: ymd });
  return true;
}

export function briefingSkill(): Plugin {
  return {
    manifest: {
      id: PLUGIN_ID,
      kind: 'skill',
      title: 'Morning briefing',
    },
    setup(ctx) {
      const config = readConfig(ctx);

      ctx.scheduler.add({
        name: JOB_NAME,
        schedule: { kind: 'daily', at: config.at as `${number}:${number}` },
        async run(now) {
          await sendBriefing(ctx, config, now);
        },
      });

      let starting = false;
      ctx.bus.on('app.started', async ({ at }) => {
        if (starting) return;
        starting = true;
        try {
          if ((await ctx.kv.get<string>(FIRST_SENT_KEY)) !== undefined) return;
          const sent = await sendBriefing(ctx, config, at);
          if (sent) await ctx.kv.set(FIRST_SENT_KEY, ctx.clock.now().toISOString());
        } finally {
          starting = false;
        }
      });

      ctx.registerTool({
        name: 'briefing.now',
        description:
          'Build the briefing for today: schedule, important unread mail and open to-dos. Use it when the owner asks for a briefing.',
        input: z.object({}),
        effects: ['read'],
        async run(_input, { log }) {
          const { message } = await buildMessage(ctx, config, ctx.clock.now(), log);
          return message.text;
        },
      });
    },
  };
}
