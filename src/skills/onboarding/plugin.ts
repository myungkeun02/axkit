import { Contracts } from '../../core/contracts/index.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import { SummaryCache } from './cache.js';
import { readOnboardingConfig } from './config.js';
import { onboardingControlsHandler } from './handlers.js';
import { onboardingTexts } from './locale.js';
import { OnboardingRunner } from './runner.js';
import type { ProgressEvent } from './runner.js';
import { defaultSignalCollectors, readRoomBuffer, ROOMS_KEY } from './signals.js';
import { RunStateStore } from './state.js';
import type { RunReason } from './state.js';
import { onboardingStatusTool } from './tools.js';
import { ProjectFinder, readPicked, savePicked } from './discover.js';
import { projectsView } from './projects-view.js';
import { ProgressTracker } from './progress.js';

const JOB_NAME = 'onboarding.daily';
const RESUME_JOB = 'onboarding.resume';
/** A big Drive is read over several runs: an hour after one ends with files left, the next picks up from the cache. */
const RESUME_SECONDS = 3_600;
const ROOM_LIMIT = 200;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

async function recordRoom(ctx: PluginContext, room: string, at: Date): Promise<void> {
  const title = room.trim();
  if (title === '') return;
  const rooms = readRoomBuffer(await ctx.kv.get<unknown>(ROOMS_KEY));
  const existing = rooms[title];
  // Only the room title and a count are kept; the preview text never reaches storage.
  if (existing === undefined && Object.keys(rooms).length >= ROOM_LIMIT) return;
  rooms[title] = { count: (existing?.count ?? 0) + 1, lastAt: at.toISOString() };
  await ctx.kv.set(ROOMS_KEY, rooms);
}

/** First look: learns who the owner is from folders, Drive and connected signals, then asks them to check it. */
export function onboardingSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.onboarding',
      kind: 'skill',
      title: 'First look',
    },
    async setup(ctx) {
      const config = readOnboardingConfig(ctx);
      const texts = onboardingTexts(ctx.assistant.language);
      const state = new RunStateStore(ctx.kv);
      await state.load();
      const cache = new SummaryCache(ctx.kv);
      await cache.load();
      // Picks saved in the app replace the ones from setup; the runner reads this same config object.
      const saved = await readPicked(ctx);
      if (saved !== undefined) config.projects = saved;

      let running: AbortController | undefined;
      let currentReason: RunReason | undefined;

      const notifyFailure = async (): Promise<void> => {
        const notifier = ctx.tryUse(Contracts.notifier);
        if (notifier === undefined) return;
        try {
          await notifier.notify({
            kind: 'onboarding.failed',
            text: texts.failed(state.current.error ?? 'unknown'),
            dedupeKey: `onboarding:${state.current.startedAt ?? ''}:failed`,
          });
        } catch (error) {
          ctx.log.warn('onboarding: the failure notice could not be sent', { error: errorName(error) });
        }
      };

      const sendProgress = async (event: ProgressEvent): Promise<void> => {
        const notifier = ctx.tryUse(Contracts.notifier);
        if (notifier === undefined) return;
        const run = state.current.startedAt ?? '';
        try {
          if ('failed' in event) {
            await notifier.notify({ kind: 'onboarding.failed', text: texts.noModel, dedupeKey: `onboarding:${run}:no-model` });
            return;
          }
          if ('finished' in event) {
            await notifier.notify({
              kind: 'onboarding.done',
              text: texts.finished(event.finished),
              dedupeKey: `onboarding:${run}:finished`,
            });
            return;
          }
          // The notifier caps a kind at a few an hour: one line per phase, and the finish has its own kind.
          if (event.done !== 0 || event.total === 0) return;
          await notifier.notify({
            kind: 'onboarding.progress',
            text: texts.progress(event.phase, event.done, event.total),
            dedupeKey: `onboarding:${run}:${event.phase}:${event.done}`,
          });
        } catch (error) {
          ctx.log.warn('onboarding: a progress notice could not be sent', { error: errorName(error) });
        }
      };

      const tracker = new ProgressTracker({ state: () => state.current, running: () => running !== undefined, korean: ctx.assistant.language !== 'en' });
      const onProgress = (event: ProgressEvent): void => {
        tracker.record(event);
        if (currentReason === 'daily') return;
        void sendProgress(event);
      };

      const runner = new OnboardingRunner({
        ctx,
        config,
        state,
        cache,
        texts,
        collectors: defaultSignalCollectors,
        onProgress,
      });

      const start = (reason: RunReason): 'started' | 'running' => {
        if (running !== undefined) return 'running';
        const controller = new AbortController();
        running = controller;
        currentReason = reason;
        tracker.reset();
        void (async () => {
          try {
            await runner.run(reason, controller.signal);
            if (reason === 'daily' && state.current.status === 'failed') await notifyFailure();
          } catch (error) {
            // Outside the runner's own catch (saving the start state, a store error): record it and say so.
            ctx.log.error('onboarding: the run stopped unexpectedly', { error: errorName(error) });
            await state.fail(errorName(error), ctx.clock.now().toISOString()).catch(() => undefined);
            await notifyFailure();
          } finally {
            if (running === controller) {
              running = undefined;
              currentReason = undefined;
            }
          }
        })().catch(() => undefined);
        return 'started';
      };

      const stop = (): 'stopped' | 'idle' => {
        if (running === undefined) return 'idle';
        running.abort();
        return 'stopped';
      };

      ctx.registerHandler(onboardingControlsHandler({ ctx, texts, state, cache, start, stop }));
      ctx.registerTool(onboardingStatusTool({ state, cache }));
      ctx.provide(Contracts.firstLook, { progress: () => tracker.snapshot(), start: () => start('manual') });

      let roomWrites: Promise<void> = Promise.resolve();
      ctx.bus.on('chat.preview', (preview) => {
        roomWrites = roomWrites
          .then(() => recordRoom(ctx, preview.room, preview.at))
          .catch((error: unknown) => {
            ctx.log.warn('onboarding: a chat preview could not be recorded', { error: errorName(error) });
          });
        return roomWrites;
      });

      ctx.bus.on('app.started', () => {
        const views = ctx.tryUse(Contracts.appViews);
        if (views !== undefined) {
          views.register(
            projectsView({
              finder: new ProjectFinder(ctx, () => config.folders),
              picked: () => config.projects,
              save: async (picked) => {
                config.projects = picked;
                await savePicked(ctx, picked);
              },
              state: () => state.current,
              running: () => running !== undefined,
              start: () => start('manual'),
              korean: ctx.assistant.language !== 'en',
            }),
          );
          views.addFeature?.('projects');
        }
        if (!config.autoStart) return;
        const snapshot = state.current;
        if (snapshot.firstDoneAt !== undefined || snapshot.status === 'paused') return;
        start('first');
      });

      ctx.scheduler.add({
        name: JOB_NAME,
        schedule: { kind: 'daily', at: config.dailyAt as `${number}:${number}` },
        async run() {
          if (state.current.firstDoneAt === undefined) return;
          if (running !== undefined) return;
          start('daily');
        },
      });

      ctx.scheduler.add({
        name: RESUME_JOB,
        schedule: { kind: 'every', seconds: RESUME_SECONDS },
        async run() {
          const current = state.current;
          if (running !== undefined || current.status !== 'done' || (current.pending ?? 0) === 0) return;
          start('daily');
        },
      });

      return {
        async stop() {
          running?.abort();
        },
      };
    },
  };
}
