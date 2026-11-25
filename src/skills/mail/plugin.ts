import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import type { MailIntent, MailIntentRegistry } from '../../core/contracts/mail-intents.js';
import { mailTexts } from './locale.js';
import { organizeTexts } from './organize-locale.js';
import { mailComposeTool, mailMuteSenderTool } from './tools-compose.js';
import { mailArchiveTool, mailLabelTool, mailLabelsTool } from './tools-organize.js';
import { mailDraftTool, mailReadTool, mailSearchTool, mailSendTool } from './tools.js';
import { readTriageConfig } from './triage-config.js';
import { registerTriage } from './triage-job.js';
import { mailView, rememberTriaged } from './mail-view.js';
import { triageTexts } from './triage-locale.js';
import { qualityTools, registerQuality, registerQualityView } from './quality.js';

/**
 * Mail skill: search, read, draft a reply or a new mail, then send only behind an approval card. New inbox mail is
 * triaged on arrival (`plugins["skill.mail"].triage`). With Gmail 정리 granted, mail can be archived and labelled.
 */
export function mailSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.mail',
      kind: 'skill',
      title: 'Mail',
      needs: [Contracts.mailRead, Contracts.mailDraft, Contracts.mailSend],
    },
    setup(ctx) {
      const texts = mailTexts(ctx.assistant.language);
      const triage = triageTexts(ctx.assistant.language);
      ctx.registerTool(mailSearchTool(ctx.use(Contracts.mailRead)));
      ctx.registerTool(mailReadTool(ctx.use(Contracts.mailRead)));
      ctx.registerTool(mailDraftTool(ctx.use(Contracts.mailDraft), texts));
      ctx.registerTool(
        mailSendTool({ drafter: ctx.use(Contracts.mailDraft), sender: ctx.use(Contracts.mailSend), texts }),
      );
      ctx.registerTool(mailComposeTool(ctx, texts, triage));
      ctx.registerTool(mailMuteSenderTool(ctx, triage));
      // Always registered: without Gmail 정리 they refuse with how to grant it, so the owner hears the way to turn it on.
      const organize = organizeTexts(ctx.assistant.language);
      ctx.registerTool(mailLabelsTool(ctx, organize));
      ctx.registerTool(mailArchiveTool(ctx, organize));
      ctx.registerTool(mailLabelTool(ctx, organize));
      const intents: MailIntent[] = [];
      const registry: MailIntentRegistry = {
        register: (intent) => {
          if (!intents.some((known) => known.id === intent.id)) intents.push(intent);
        },
        list: () => intents,
      };
      ctx.provide(Contracts.mailIntents, registry);
      registerTriage(ctx, readTriageConfig(ctx), registry);
      rememberTriaged(ctx);
      ctx.bus.on('app.started', () => {
        const views = ctx.tryUse(Contracts.appViews);
        if (views === undefined) return;
        views.register(mailView(ctx));
        views.addFeature?.('mail-screen');
      });
      // R: learn from what the owner did with the drafts (style guide, outcomes, local test set)
      registerQuality(ctx);
      registerQualityView(ctx);
      for (const tool of qualityTools(ctx)) ctx.registerTool(tool);
    },
  };
}
