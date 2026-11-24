import { Contracts } from '../../core/contracts/index.js';
import type { ResumeDoc, TalentIntake } from '../../core/contracts/talent.js';
import type { Plugin } from '../../core/plugin/types.js';
import { contactOf, extractResume } from './extract.js';
import { TalentStore } from './store.js';
import { TalentBook } from './requests.js';
import { requestTools } from './tools-requests.js';
import { draftIntroTool } from './draft-intro.js';
import { talentGetTool, talentSearchTool, talentStatsTool } from './tools.js';
import { applicationIntent, hiringIntent } from './mail.js';

export const TALENT_ID = 'skill.talent';

/**
 * The talent pack (인재 소개 팩): résumés the first look finds become a candidate list the assistant can search to
 * answer hiring requests and introductions. Off by default; everything stays on this computer and contact details
 * are read by code, never sent to a model.
 */
export function talentSkill(): Plugin {
  return {
    manifest: { id: TALENT_ID, kind: 'skill', title: 'Talent pack (candidates from résumés)' },
    async setup(ctx) {
      const store = new TalentStore(ctx.kv);
      await store.load();
      const book = new TalentBook(ctx.kv);
      await book.load();
      const korean = ctx.assistant.language !== 'en';
      let stopped = false;
      const intake: TalentIntake = {
        wants: async (sourceId, modifiedAt) => !stopped && store.wants(sourceId, modifiedAt),
        async add(doc: ResumeDoc) {
          if (doc.text.trim().length < 80) {
            await store.markSeen(doc.sourceId, doc.modifiedAt);
            return 'skipped';
          }
          const outcome = await extractResume({ llm: ctx.llm, log: ctx.log }, doc.text, korean);
          if (!outcome.ok) {
            // A model that is out of budget leaves the file unread, so the next run tries again.
            if (outcome.reason === 'model-stopped') stopped = true;
            else await store.markSeen(doc.sourceId, doc.modifiedAt);
            return 'skipped';
          }
          const result = await store.upsert(outcome.value, contactOf(doc.text), { path: doc.path, modifiedAt: doc.modifiedAt });
          await store.markSeen(doc.sourceId, doc.modifiedAt);
          return result;
        },
      };
      ctx.provide(Contracts.talentIntake, intake);
      ctx.provide(Contracts.talent, store);
      ctx.registerTool(talentSearchTool(store));
      ctx.registerTool(talentGetTool(store));
      ctx.registerTool(talentStatsTool(store));
      for (const tool of requestTools(ctx, store, book, korean)) ctx.registerTool(tool);
      ctx.registerTool(draftIntroTool(ctx, store, book, korean));
      // Mail kinds this pack knows; the mail skill may be set up after this one.
      ctx.bus.on('app.started', () => {
        const intents = ctx.tryUse(Contracts.mailIntents);
        intents?.register(applicationIntent(ctx, intake, korean));
        intents?.register(hiringIntent(ctx, store, book, korean));
      });
    },
  };
}
