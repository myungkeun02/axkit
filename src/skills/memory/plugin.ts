import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import { registerCalendarSweep } from './calendar-job.js';
import { registerCheckin } from './checkin.js';
import type { CheckinSettings } from './checkin.js';
import { registerExpiry } from './expiry.js';
import { registerReconcile } from './reconcile.js';
import { FactStore } from './facts.js';
import { memoryTexts } from './locale.js';
import { registerMailScan } from './mail-job.js';
import type { MailScanConfig } from './mail-job.js';
import { PeopleStore } from './people-store.js';
import { memoryEventTool } from './tool-event.js';
import { memoryForgetTool, memoryRecallTool, memoryRememberTool } from './tools-facts.js';
import { peopleDoneTool, peopleNoteTool, peopleRecallTool } from './tools-people.js';
import { peopleListTool, peopleProfileTool, peopleView } from './tools-people-card.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const ConfigSchema = z.object({
  mailScan: z.boolean().default(true),
  mailScanLimit: z.number().int().min(1).max(50).default(10),
  checkin: z.boolean().default(true),
  checkinAt: z.string().regex(TIME).default('10:00'),
  checkinWeekday: z.number().int().min(0).max(6).default(0),
});

const DEFAULTS = ConfigSchema.parse({});

interface MemoryConfig {
  mail: MailScanConfig;
  checkin?: CheckinSettings;
}

function readConfig(ctx: PluginContext): MemoryConfig {
  const parsed = ConfigSchema.safeParse(ctx.config);
  if (!parsed.success) {
    ctx.log.warn('memory: invalid config, using defaults', { issues: parsed.error.issues.length });
  }
  const data = parsed.success ? parsed.data : DEFAULTS;
  return {
    mail: { enabled: data.mailScan, limit: data.mailScanLimit },
    ...(data.checkin ? { checkin: { at: data.checkinAt, weekday: data.checkinWeekday } } : {}),
  };
}

/** Memory skill: the owner's facts, and who they talk to across mail, calendar and chat. */
export function memorySkill(): Plugin {
  return {
    manifest: {
      id: 'skill.memory',
      kind: 'skill',
      title: 'Memory',
    },
    async setup(ctx) {
      const texts = memoryTexts(ctx.assistant.language);
      const language = texts.language;
      const store = new FactStore(ctx.kv, () => ctx.clock.now());
      const people = new PeopleStore(ctx.kv, ctx.clock, language);
      await store.load();
      await people.load();

      const deps = {
        store,
        people,
        texts,
        timeZone: ctx.assistant.timezone,
        language,
      };
      ctx.registerTool(memoryRememberTool(deps));
      ctx.registerTool(memoryRecallTool(deps));
      ctx.registerTool(memoryForgetTool(deps));
      ctx.registerTool(
        memoryEventTool({
          texts,
          expire: (event) => ctx.use(Contracts.memoryExpiry).eventHappened(event),
        }),
      );
      ctx.registerTool(peopleNoteTool(deps));
      ctx.registerTool(peopleDoneTool(deps));
      ctx.registerTool(peopleRecallTool(deps));
      ctx.registerTool(peopleProfileTool(people));
      ctx.registerTool(peopleListTool(people));
      ctx.bus.on('app.started', () => {
        ctx.tryUse(Contracts.appViews)?.register(peopleView(people, language === 'en' ? 'People' : '사람'));
      });

      ctx.provide(Contracts.memoryRead, {
        recall: (query) => store.recall(query),
      });
      ctx.provide(Contracts.memoryWrite, {
        remember: (input) => store.remember(input),
      });
      ctx.provide(Contracts.peopleWrite, {
        noteInteraction: async (identity, interaction) => {
          await people.noteInteraction(identity, interaction);
        },
        setProfile: async (identity, profile) => {
          await people.setProfile(identity, profile);
        },
      });
      ctx.provide(Contracts.peopleRead, {
        find: (nameOrEmail) => people.find(nameOrEmail),
        openCommitments: () => people.openCommitments(),
        cards: () => people.cards(),
      });

      registerExpiry(ctx, store, texts);
      registerReconcile(ctx, store);

      const config = readConfig(ctx);
      registerMailScan(ctx, people, config.mail);
      registerCalendarSweep(ctx, people, texts);
      if (config.checkin !== undefined) registerCheckin(ctx, store, texts, config.checkin);
    },
  };
}
