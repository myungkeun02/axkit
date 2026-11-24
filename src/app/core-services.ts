import { fileURLToPath } from 'node:url';
import type { Config } from '../core/config/schema.js';
import type { Notifier } from '../core/contracts/notify.js';
import type { EventBus } from '../core/events/types.js';
import type { Logger } from '../core/log/types.js';
import type { PluginHost } from '../core/plugin/host.js';
import type { ProcessRunner } from '../core/process/types.js';
import type { Clock, Scheduler } from '../core/scheduler/types.js';
import type { Store } from '../core/store/types.js';
import { Contracts } from '../core/contracts/index.js';
import { KvDocStore } from '../core/docs/kv-doc-store.js';
import { docChecks, noticeChecks, switchChecks } from '../core/health/builtin.js';
import { uncommittedCodeCheck } from '../core/health/git-check.js';
import { HealthChecks } from '../core/health/registry.js';
import { SqliteUsageReader } from '../core/llm/usage-reader.js';
import type { QuietHoursNotifier } from '../core/notify/quiet-notifier.js';
import { FeatureBreaker } from '../core/switches/breaker.js';
import { pauseExpiryJob } from '../core/switches/expiry-notice.js';
import { SqliteSwitches } from '../core/switches/sqlite-switches.js';
import { pauseCovering } from '../core/switches/covering.js';
import { ymdOf } from '../core/time/local-day.js';
import { coreTexts } from './core-texts.js';

const DAY_MS = 86_400_000;
const FAILURE_KEEP_DAYS = 90;

export interface CoreServicesOptions {
  config: Config;
  store: Store;
  host: PluginHost;
  bus: EventBus;
  scheduler: Scheduler;
  clock: Clock;
  notifier: QuietHoursNotifier;
  log: Logger;
  run?: ProcessRunner;
  /** The checkout ax-kit runs from, for the uncommitted-code check. */
  codeDir?: string;
}

export const CODE_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Pause switches, the breaker, structured docs, usage, notice stats and health checks, as capabilities. */
export function provideCoreServices(opts: CoreServicesOptions): () => void {
  const texts = coreTexts(opts.config.assistant.language);
  const timeZone = opts.config.assistant.timezone;
  const now = (): Date => opts.clock.now();
  const notifier = (): Notifier => opts.notifier;

  const switches = new SqliteSwitches(opts.store.sql, now);
  opts.scheduler.setPauseCheck?.(async (name) => pauseCovering(name, await switches.list()) !== undefined);
  const breaker = new FeatureBreaker({
    sql: opts.store.sql,
    switches,
    now,
    notifier,
    log: opts.log,
    text: {
      paused: (feature, signature, count, until) =>
        texts.breakerPaused(feature, signature, count, ymdOf(new Date(until), timeZone)),
    },
  });
  const docs = new KvDocStore(opts.store.kv('core.docs'), now);
  const health = new HealthChecks();
  health.register(switchChecks(switches, { longDays: 7, texts: texts.health }));
  health.register(noticeChecks(opts.notifier.stats, { texts: texts.health, maxOverBudgetDays: 2 }));
  health.register(docChecks(docs, { texts: texts.health, staleDays: 90 }));
  if (opts.run !== undefined) {
    health.register(uncommittedCodeCheck({ codeDir: opts.codeDir ?? CODE_DIR, run: opts.run, texts: texts.health }));
  }

  opts.host.provide(Contracts.switches, switches);
  opts.host.provide(Contracts.featureHealth, breaker);
  opts.host.provide(Contracts.docs, docs);
  opts.host.provide(Contracts.health, health);
  opts.host.provide(Contracts.usage, new SqliteUsageReader(opts.store.sql));
  opts.host.provide(Contracts.noticeStats, opts.notifier.stats);

  opts.scheduler.add(
    pauseExpiryJob({
      switches,
      notifier,
      now,
      text: (state) => texts.pauseEnding(state.feature, state.reason, ymdOf(new Date(state.until), timeZone)),
    }),
  );
  opts.scheduler.add({
    name: 'core.notify.digest',
    schedule: { kind: 'daily', at: opts.config.notify.digestAt as `${number}:${number}` },
    async run() {
      await opts.notifier.flushDigest();
    },
  });
  opts.scheduler.add({
    name: 'core.failure-retention',
    schedule: { kind: 'daily', at: '04:20' },
    async run(at) {
      breaker.prune(new Date(at.getTime() - FAILURE_KEEP_DAYS * DAY_MS));
    },
  });

  // A document that relied on a fact is flagged the moment the fact ends, and the owner hears about it once.
  return opts.bus.on('memory.fact_expired', async (fact) => {
    const ids = await docs.flagFact(fact.id, fact.text);
    if (ids.length === 0) return;
    const titles = (await Promise.all(ids.map((id) => docs.get(id)))).flatMap((doc) =>
      doc === undefined ? [] : [doc.title],
    );
    await opts.notifier.notify({
      kind: 'core.docs-review',
      dedupeKey: fact.id,
      text: texts.docsNeedReview(fact.text, titles),
    });
  });
}
