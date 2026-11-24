import type { SpendReader } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { Classifier, ModelLabeler } from './classify/classifier.js';
import { isSpendCategory, LabelStore } from './classify/labels.js';
import { readSpendingConfig } from './config.js';
import type { FxConfig } from './fx.js';
import type { IntakeDeps } from './intake.js';
import { registerMoneyIntake, registerSpendingJobs } from './intake.js';
import { LedgerStore } from './ledger.js';
import { spendingTexts } from './locale.js';
import { registerMonthEnd } from './monthend.js';
import { registerRenewals } from './renewals.js';
import { registerReport } from './report.js';
import type { ToolDeps } from './tools.js';
import { spendingListTool, spendingSummaryTool } from './tools.js';
import { spendingAddTool, spendingExcludeTool, spendingSetCategoryTool } from './tools-edit.js';
import { spendingPatternsTool, subscriptionsListTool } from './tools-insights.js';

/**
 * Spending skill: card notices, receipt mail and manual entries become a read-only ledger.
 * Everything external (mail) is optional and resolved at run time; nothing here pays or cancels.
 */
export function spendingSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.spending',
      kind: 'skill',
      title: 'Spending',
    },
    setup(ctx) {
      const config = readSpendingConfig(ctx);
      const texts = spendingTexts(ctx.assistant.language);
      const timeZone = ctx.assistant.timezone;
      const ledger = new LedgerStore(ctx.kv, timeZone);
      const labels = new LabelStore(ctx.kv, () => ctx.clock.now());
      const classifier = new Classifier(labels);
      ctx.bus.on('tuning.apply', async (change) => {
        if (change.domain !== 'spend.category') return;
        if (change.action === 'set' && change.value !== undefined && isSpendCategory(change.value)) {
          await labels.setKeyword(change.subject, change.value);
        } else if (change.action === 'unmute') {
          await labels.removeKeyword(change.subject);
        }
      });
      const fx: FxConfig = {
        homeCurrency: config.homeCurrency,
        fxRates: config.fxRates,
        warn: (currency) => ctx.log.warn('spending: no fx rate, amount left unconverted', { currency }),
      };

      const tools: ToolDeps = {
        ledger,
        classifier,
        labels,
        config,
        fx,
        texts,
        now: () => ctx.clock.now(),
        timeZone,
        emitFeedback: (feedback) => ctx.bus.emit('feedback.card', feedback),
      };
      ctx.registerTool(spendingListTool(tools));
      ctx.registerTool(spendingSummaryTool(tools));
      ctx.registerTool(spendingAddTool(tools));
      ctx.registerTool(spendingSetCategoryTool(tools));
      ctx.registerTool(spendingExcludeTool(tools));

      const insightDeps = { ledger, config, now: () => ctx.clock.now(), timeZone };
      ctx.registerTool(spendingPatternsTool(insightDeps));
      if (config.subscriptions) {
        ctx.registerTool(subscriptionsListTool(insightDeps));
        registerRenewals(ctx, { config, ledger, texts, timeZone });
      }
      registerReport(ctx, { config, ledger, texts, timeZone });
      registerMonthEnd(ctx, { config, ledger, texts, timeZone });

      const reader: SpendReader = {
        async entries(range) {
          return (await ledger.list(range)).filter((entry) => entry.excluded !== true);
        },
        homeCurrency: () => config.homeCurrency,
      };
      ctx.provide(Contracts.spendRead, reader);

      const intake: IntakeDeps = {
        ledger,
        config,
        fx,
        timeZone,
        log: ctx.log,
        classify: (merchant) => classifier.classify(merchant),
      };
      registerMoneyIntake(ctx, intake);

      const labeler = new ModelLabeler({
        ledger,
        labels,
        llm: ctx.llm,
        kv: ctx.kv,
        log: ctx.log,
        clock: ctx.clock,
        timeZone,
      });
      registerSpendingJobs(ctx, { config, ledger, texts, labeler, intake });
    },
  };
}
