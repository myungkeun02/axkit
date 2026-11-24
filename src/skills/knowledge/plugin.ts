import { Contracts } from '../../core/contracts/index.js';
import type { KnowledgeWriter, ProfileReader } from '../../core/contracts/knowledge.js';
import type { Plugin } from '../../core/plugin/types.js';
import { KnowledgeBuilder } from './builder.js';
import { classifyAreas } from './classify.js';
import { readKnowledgeConfig } from './config.js';
import { memoryLines } from './from-memory.js';
import { knowledgeTexts } from './locale.js';
import { profileSummary, reviewLines } from './profile.js';
import { KnowledgeStore } from './store.js';
import { knowledgeReadTool, knowledgeSearchTool } from './tools.js';
import { DocWriter, NODE_DOC_FS } from './writer.js';
import { knowledgeView } from './view.js';
import { docGraphView } from './graph.js';
import type { DocFs } from './writer.js';

export interface KnowledgeSkillOptions {
  /** Folder for the Markdown documents. Without it the skill only answers from memory. */
  dir?: string;
  fs?: DocFs;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** Knowledge skill: the owner's facts and projects as Markdown documents, correctable through review. */
export function knowledgeSkill(opts: KnowledgeSkillOptions = {}): Plugin {
  return {
    manifest: {
      id: 'skill.knowledge',
      kind: 'skill',
      title: 'Knowledge base',
    },
    async setup(ctx) {
      const config = readKnowledgeConfig(ctx);
      const texts = knowledgeTexts(ctx.assistant.language);
      const store = new KnowledgeStore(ctx.kv);
      await store.load();
      const writer = opts.dir === undefined ? undefined : new DocWriter(opts.dir, opts.fs ?? NODE_DOC_FS);
      const builder = new KnowledgeBuilder({
        store,
        kv: ctx.kv,
        writer,
        texts,
        clock: ctx.clock,
        timeZone: ctx.assistant.timezone,
        log: ctx.log,
      });

      // Rebuilds share one ordering: a review answer and the nightly scan must never interleave a store write.
      let queue: Promise<unknown> = Promise.resolve();
      function enqueue<T>(task: () => Promise<T>): Promise<T> {
        const next = queue.then(task);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      }

      async function importMemory(): Promise<void> {
        const reader = ctx.tryUse(Contracts.memoryRead);
        const facts = reader === undefined ? [] : await reader.recall({ limit: 2_000 });
        const areas = await classifyAreas(
          { llm: ctx.llm, kv: ctx.kv, log: ctx.log },
          facts.map((fact) => ({ id: fact.id, text: fact.text })),
        );
        await store.replaceOrigin('memory', memoryLines(facts, areas, config.minStrength, texts.ownerLabel));
        await builder.rebuild();
      }

      async function rebuildMemory(): Promise<void> {
        try {
          await enqueue(importMemory);
        } catch (error) {
          ctx.log.warn('knowledge: rebuild failed', { error: errorName(error) });
        }
      }

      const profileReader: ProfileReader = {
        summary: async (maxChars) => profileSummary(store.visible(), texts, Math.min(maxChars, config.profileChars)),
        reviewLines: async () => reviewLines(store.visible(), texts),
        projectLines: async () => store.visible().filter((line) => line.area === 'project'),
      };
      const knowledgeWriter: KnowledgeWriter = {
        replaceScan: (result) =>
          enqueue(async () => {
            const counts = await store.replaceOrigin('scan', [...result.profile, ...result.projects]);
            await builder.rebuild();
            // R18: what the scan found (companies, projects) becomes the owner's bot groups and teams
            await ctx.bus.emit('knowledge.scanned', { profile: result.profile, projects: result.projects });
            return counts;
          }),
        correct: async (id, text) => {
          await enqueue(async () => {
            await store.correct(id, text, ctx.clock.now().toISOString());
            await builder.rebuild();
          });
        },
      };

      ctx.provide(Contracts.knowledgeProfile, profileReader);
      ctx.provide(Contracts.knowledgeWrite, knowledgeWriter);
      ctx.registerTool(knowledgeSearchTool({ store, texts }));
      ctx.registerTool(knowledgeReadTool({ builder }));

      ctx.bus.on('review.answer', async (answer) => {
        if (answer.reviewId !== 'knowledge.profile' || answer.verdict === 'confirmed') return;
        // A "corrected" answer without words must not turn into a deletion.
        if (answer.verdict === 'corrected' && (answer.text ?? '').trim() === '') return;
        try {
          const text = answer.verdict === 'removed' ? undefined : answer.text;
          await enqueue(async () => {
            await store.correct(answer.itemId, text, ctx.clock.now().toISOString());
            await builder.rebuild();
          });
        } catch (error) {
          ctx.log.warn('knowledge: review answer ignored', { error: errorName(error), itemId: answer.itemId });
        }
      });

      ctx.scheduler.add({
        name: 'knowledge.rebuild',
        schedule: { kind: 'daily', at: config.rebuildAt as `${number}:${number}` },
        run: async () => {
          await rebuildMemory();
        },
      });
      ctx.bus.on('app.started', async () => {
        // The phone/desktop app shows the documents when the app channel is on.
        ctx.tryUse(Contracts.appViews)?.register(
          knowledgeView({
            store,
            builder,
            texts,
            correct: (id, text) => knowledgeWriter.correct(id, text),
            ...(writer !== undefined ? { readChangelog: () => writer.read(texts.files.changelog) } : {}),
          }),
        );
        const docs = ctx.tryUse(Contracts.docs);
        ctx.tryUse(Contracts.appViews)?.register(
          docGraphView({ store, builder, texts, language: ctx.assistant.language, ...(docs !== undefined ? { docs } : {}) }),
        );
        await rebuildMemory();
      });
    },
  };
}
