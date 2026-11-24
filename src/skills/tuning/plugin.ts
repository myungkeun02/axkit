import type { Plugin } from '../../core/plugin/types.js';
import { registerButtons } from './buttons.js';
import { readTuningConfig } from './config.js';
import { tuningTexts } from './locale.js';
import { ImprovementRecord } from './record.js';
import { TuningStore } from './store.js';
import { tuningListTool } from './tool-list.js';
import { tuningUndoTool } from './tool-undo.js';
import { registerWeekly } from './weekly.js';

/**
 * Collects card rejections and corrections and proposes at most three weekly adjustments.
 * Nothing is applied without the owner pressing a button.
 */
export function tuningSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.tuning',
      kind: 'skill',
      title: 'Self-tuning (weekly suggestions from your corrections)',
    },
    setup(ctx) {
      const config = readTuningConfig(ctx);
      const texts = tuningTexts(ctx.assistant.language);
      const store = new TuningStore(ctx.kv, () => ctx.clock.now());
      const record = new ImprovementRecord(ctx, texts);

      const unsubscribe = ctx.bus.on('feedback.card', async (feedback) => {
        await store.append(feedback);
      });

      registerButtons(ctx, store, texts, record);
      ctx.registerTool(tuningListTool({ store, texts }));
      ctx.registerTool(tuningUndoTool({ ctx, store, texts }));
      registerWeekly(ctx, {
        store,
        config,
        texts,
        timeZone: ctx.assistant.timezone,
        log: ctx.log,
        record,
      });

      return {
        async stop() {
          unsubscribe();
        },
      };
    },
  };
}
