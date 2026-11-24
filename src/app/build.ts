import type { Clock } from '../core/scheduler/types.js';
import type { Config } from '../core/config/schema.js';
import type { Logger } from '../core/log/types.js';
import type { SecretStore } from '../core/secrets/types.js';
import type { Plugin } from '../core/plugin/types.js';
import type { ToolExecutor, ToolRegistry } from '../core/tools/types.js';
import { systemClock } from '../core/scheduler/clock.js';
import { openSqliteStore } from '../core/store/sqlite.js';
import { InMemoryEventBus } from '../core/events/bus.js';
import type { EventBus } from '../core/events/types.js';
import { TimerScheduler } from '../core/scheduler/scheduler.js';
import { AppLlmControl } from './llm-control.js';
import { TierHarness } from './tier-harness.js';
import { KvJobRuns } from '../core/scheduler/kv-runs.js';
import { RoutingLlmGateway } from '../core/llm/gateway.js';
import type { LlmProvider } from '../core/llm/types.js';
import { SqliteUsageLedger, LEDGER_MIGRATIONS } from '../core/llm/sqlite-ledger.js';
import { InMemoryToolRegistry } from '../core/tools/registry.js';
import { PolicyToolExecutor } from '../core/tools/executor.js';
import { RegistryToolbox } from '../core/tools/toolbox.js';
import { SqliteAuditLog, AUDIT_MIGRATIONS } from '../core/log/sqlite-audit.js';
import { setInjectionReporter } from '../core/text/data.js';
import { PluginHost } from '../core/plugin/host.js';
import { MessageRouter } from '../core/conversation/router.js';
import { PendingMessages } from '../core/conversation/pending.js';
import { Caps } from '../core/plugin/types.js';
import { Contracts } from '../core/contracts/index.js';
import { QuietHoursNotifier } from '../core/notify/quiet-notifier.js';
import { quietGate } from '../core/notify/quiet-gate.js';
import { ChannelHub } from '../core/hub/hub.js';
import { retentionJob } from '../core/log/retention.js';
import { SWITCH_MIGRATIONS } from '../core/switches/sqlite-switches.js';
import { KILL_MIGRATIONS, SqliteKillSwitch } from '../core/switches/kill.js';
import { resumeAllTool, stopAllTool } from '../core/switches/kill-tools.js';
import { AUTONOMY_MIGRATIONS, SqliteAutonomyRules } from '../core/policy/autonomy.js';
import { PROMOTION_MIGRATIONS, SqliteScopeTracks } from '../core/policy/promotion.js';
import { AutonomyPromoter } from '../core/policy/promoter.js';
import { autonomyCorrectTool } from '../core/policy/promotion-tool.js';
import { SqliteWorkLog, WORK_LOG_MIGRATIONS } from '../core/log/work-log.js';
import { KvBotDirectory } from '../core/bots/directory.js';
import { SqliteTopicAnswers, TOPIC_MIGRATIONS } from '../core/policy/topics.js';
import { OwnerQuestions } from '../core/policy/questions.js';
import { nodeProcessRunner } from '../core/process/node-runner.js';
import type { ProcessRunner } from '../core/process/types.js';
import { createProviders } from './llm-providers.js';
import { provideCoreServices } from './core-services.js';
import { coreTexts } from './core-texts.js';

export interface App {
  host: PluginHost;
  bus: EventBus;
  tools: ToolRegistry;
  executor: ToolExecutor;
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
}

export interface BuildAppOptions {
  config: Config;
  /** Tests answer model calls without a network; production builds providers from config. */
  llmProviders?: readonly LlmProvider[];
  secrets: SecretStore;
  log: Logger;
  plugins: readonly Plugin[];
  storePath: string;
  clock?: Clock;
  /** Runs `git status` for the uncommitted-code health check; tests pass a fake. */
  run?: ProcessRunner;
}

const KO_FAILURE = '처리하다 문제가 생겼어요. 잠시 뒤 다시 말씀해 주세요.';
const EN_FAILURE = 'Something went wrong. Please try again in a moment.';
/** How long a stop waits for turns already running to finish and deliver, before channels and storage close. */
const SHUTDOWN_WAIT_MS = 10_000;

export async function buildApp(opts: BuildAppOptions): Promise<App> {
  const store = openSqliteStore(opts.storePath);
  await store.migrate([...LEDGER_MIGRATIONS, ...AUDIT_MIGRATIONS, ...SWITCH_MIGRATIONS, ...KILL_MIGRATIONS, ...AUTONOMY_MIGRATIONS, ...WORK_LOG_MIGRATIONS, ...TOPIC_MIGRATIONS, ...PROMOTION_MIGRATIONS]);
  const bus = new InMemoryEventBus(opts.log);
  const clock = opts.clock ?? systemClock;

  const scheduler = new TimerScheduler({
    timeZone: opts.config.assistant.timezone,
    log: opts.log,
    runs: new KvJobRuns(store.kv('core.jobs')),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  });

  const providers = opts.llmProviders ?? (await createProviders(opts.config, opts.secrets, opts.log));
  const ledger = new SqliteUsageLedger(store.sql);
  const llm = new RoutingLlmGateway({
    providers,
    routes: opts.config.llm.routes,
    budget: opts.config.llm.budget,
    ledger,
    timeZone: opts.config.assistant.timezone,
    log: opts.log,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  });

  const audit = new SqliteAuditLog(store.sql);
  // Every <data> block is screened; each stripped attempt leaves a masked trace in the audit log.
  setInjectionReporter((report) => {
    opts.log.warn('guard: stripped an instruction aimed at the AI', { source: report.kind, kind: report.hit.kind });
    void audit
      .append({ at: clock.now(), kind: 'guard.injection', subject: report.kind, detail: { ...report.hit, count: report.count } })
      .catch(() => undefined);
  });
  // the app's AI settings (keys connected on the phone, tier order, a tier per purpose) apply before anything runs
  const tiers: { harness?: TierHarness } = {};
  const llmControl = new AppLlmControl({
    config: opts.config,
    secrets: opts.secrets,
    gateway: llm,
    kv: store.kv('core.llm-settings'),
    audit,
    ledger,
    now: () => clock.now(),
    onConnected: async (id, key) => await tiers.harness?.discover(id, key, true),
  });
  await llmControl.apply();
  scheduler.add(
    retentionJob({
      usage: ledger,
      audit,
      usageDays: opts.config.retention.usageDays,
      auditDays: opts.config.retention.auditDays,
      clock,
      log: opts.log,
    }),
  );

  const tools = new InMemoryToolRegistry();
  const kill = new SqliteKillSwitch(store.sql, () => clock.now());
  tools.register(stopAllTool(kill));
  tools.register(resumeAllTool(kill));
  const autonomy = new SqliteAutonomyRules(store.sql, () => clock.now());
  const workLog = new SqliteWorkLog(store.sql);
  const ko = opts.config.assistant.language !== 'en';
  // set once the notifier exists below; an action that runs under a rule is reported, never silent
  const autoNotice: { send?: (text: string) => void } = {};
  // a kind of action the owner always approved is offered once to run on its own; a yes is an ordinary rule
  const promoter = new AutonomyPromoter({
    tracks: new SqliteScopeTracks(store.sql, () => clock.now()),
    rules: autonomy,
    questions: () => pluginHost.capability(Contracts.questions),
    notify: (text) => autoNotice.send?.(text),
    audit,
    log: opts.log,
    language: opts.config.assistant.language,
  });
  tools.register(autonomyCorrectTool(promoter));
  // Channels register with the hub during setup; everything else talks to the hub, never to one channel.
  const channels = new ChannelHub();
  // notices go to the channel the owner wrote on last
  channels.attach(bus);
  const executor = new PolicyToolExecutor({
    registry: tools,
    confirmer: () => channels,
    policy: opts.config.policy,
    audit,
    log: opts.log,
    kill: () => kill.state(),
    autonomy,
    rememberLabel: (summary) => (ko ? `앞으로 같은 일("${summary.slice(0, 60)}")은 묻지 않고 할게요` : `Next time, do "${summary.slice(0, 60)}" without asking`),
    onDone: (_name, summary, _effects, auto) => {
      void workLog.add({ at: clock.now(), title: summary, kind: auto ? 'auto' : 'action' }).catch(() => undefined);
    },
    tracker: promoter,
    onAuto: (_rule, summary) => autoNotice.send?.(ko ? `알아서 했어요: ${summary}` : `Done on my own: ${summary}`),
  });
  const pluginHost: PluginHost = new PluginHost({
    config: opts.config,
    secrets: opts.secrets,
    bus,
    scheduler,
    clock,
    llm,
    log: opts.log,
    tools,
    toolbox: new RegistryToolbox(tools, executor),
    kv: (namespace) => store.kv(namespace),
  });
  const router = new MessageRouter({
    handlers: () => pluginHost.handlers(),
    replier: () => channels,
    log: opts.log,
    failureText: opts.config.assistant.language === 'en' ? EN_FAILURE : KO_FAILURE,
    pending: new PendingMessages(store.kv('core.pending')),
    lateNote: opts.config.assistant.language === 'en' ? '(Sent while I was restarting; answering late) ' : '(제가 다시 켜지는 동안 받은 메시지예요. 늦게 답해요) ',
  });

  pluginHost.provide(Caps.channels, channels);
  pluginHost.provide(Caps.replier, channels);
  pluginHost.provide(Caps.confirmer, channels);
  pluginHost.provide(Contracts.ownerChannel, channels);
  const notifier = new QuietHoursNotifier({
    channel: () => (channels.ids().length > 0 ? channels : undefined),
    clock,
    timeZone: opts.config.assistant.timezone,
    kv: store.kv('core.notify'),
    log: opts.log,
    dailyBudget: opts.config.notify.dailyBudget,
    digestTitle: (count) => coreTexts(opts.config.assistant.language).digestTitle(count),
    overnightTitle: (count) => coreTexts(opts.config.assistant.language).overnightTitle(count),
    onDelivered: (event) => bus.emit('notice.delivered', event),
    ...(opts.config.assistant.quietHours !== undefined
      ? { quietHours: opts.config.assistant.quietHours }
      : {}),
  });
  pluginHost.provide(Contracts.notifier, notifier);
  pluginHost.provide(Contracts.noticeMute, notifier);
  pluginHost.provide(Contracts.killSwitch, kill);
  pluginHost.provide(Contracts.autonomy, autonomy);
  pluginHost.provide(Contracts.autonomyPromotion, promoter);
  pluginHost.provide(Contracts.llmControl, llmControl);
  // keeps the S/A/B/C lineup current and the work spread by cost; the owner's own choices always win
  tiers.harness = new TierHarness({
    control: llmControl,
    secrets: opts.secrets,
    usage: () => pluginHost.capability(Contracts.usage),
    questions: () => pluginHost.capability(Contracts.questions),
    now: () => clock.now(),
    log: opts.log,
    ledger,
  });
  const harness = tiers.harness;
  scheduler.add({
    name: 'llm.tiers',
    label: ko ? 'AI 등급표 점검' : 'AI tier review',
    schedule: { kind: 'daily', at: '04:40' },
    run: async () => {
      await harness.discoverAll();
      await harness.review();
    },
  });
  pluginHost.provide(Contracts.workLog, workLog);
  pluginHost.provide(Contracts.bots, new KvBotDirectory(store.kv('core.bots'), () => clock.now()));
  const topics = new SqliteTopicAnswers(store.sql, () => clock.now());
  pluginHost.provide(Contracts.topics, topics);
  const questionGate = quietGate({
    clock,
    timeZone: opts.config.assistant.timezone,
    ownerActiveAt: () => channels.lastOwnerActivity(),
    ...(opts.config.assistant.quietHours !== undefined ? { quietHours: opts.config.assistant.quietHours } : {}),
  });
  pluginHost.provide(Contracts.questions, new OwnerQuestions({ topics, confirmer: () => channels, now: () => clock.now(), gate: questionGate }));
  autoNotice.send = (text) => {
    void notifier.notify({ kind: 'autonomy.done', text }).catch(() => undefined);
  };
  const stopCoreServices = provideCoreServices({
    config: opts.config,
    store,
    host: pluginHost,
    bus,
    scheduler,
    clock,
    notifier,
    log: opts.log,
    run: opts.run ?? nodeProcessRunner,
  });

  for (const plugin of opts.plugins) pluginHost.add(plugin);

  let unsubscribe: (() => void) | undefined;
  let started = false;
  let stopped = false;

  return {
    host: pluginHost,
    bus,
    tools,
    executor,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      await pluginHost.setupAll();
      unsubscribe = router.attach(bus);
      await pluginHost.startAll();
      // The channel is logged in now, so anything held before a restart can be flushed or re-armed.
      await notifier.restore();
      scheduler.start();
      await bus.emit('app.started', { at: clock.now() });
      // a turn cut off by the last stop or crash is answered now, once
      await router.recover(clock.now());
    },
    async stop(reason: string): Promise<void> {
      if (stopped) return;
      stopped = true;
      await bus.emit('app.stopping', { reason });
      // intake stops first (a message arriving now is kept for the next start); running turns get a moment to deliver
      await router.close(SHUTDOWN_WAIT_MS);
      unsubscribe?.();
      stopCoreServices();
      notifier.stop();
      await scheduler.stop();
      await pluginHost.stopAll();
      await store.close();
    },
  };
}
