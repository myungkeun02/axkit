import { localTokenPath } from '../mobile/local-token.js';
import { join } from 'node:path';
import type { Config } from '../core/config/schema.js';
import { usesApp, usesDiscord } from '../core/config/schema.js';
import type { Plugin } from '../core/plugin/types.js';
import { discordChannel } from '../channels/discord/plugin.js';
import { appChannel } from '../channels/app/plugin.js';
import { gmailConnector, googleCalendarConnector } from '../connectors/google/plugin.js';
import { koLifeConnector } from '../connectors/ko-life/plugin.js';
import { asideConnector } from '../connectors/aside/plugin.js';
import { waysSkill } from '../skills/ways/plugin.js';
import { greetingSkill } from '../skills/greeting/plugin.js';
import { assistantSkill } from '../skills/assistant/plugin.js';
import { routinesSkill } from '../skills/routines/plugin.js';
import { todoSkill } from '../skills/todo/plugin.js';
import { briefingSkill } from '../skills/briefing/plugin.js';
import { calendarSkill } from '../skills/calendar/plugin.js';
import { mailSkill } from '../skills/mail/plugin.js';
import { memorySkill } from '../skills/memory/plugin.js';
import { interviewSkill } from '../skills/interview/plugin.js';
import { daySkill } from '../skills/day/plugin.js';
import { localLifeSkill } from '../skills/local-life/plugin.js';
import { mobileBridge } from '../mobile/plugin.js';
import { webConnector } from '../connectors/web/plugin.js';
import { webSearchSkill } from '../skills/web-search/plugin.js';
import { opsSkill } from '../skills/ops/plugin.js';
import { appUpdatesSkill, updatePaths } from '../skills/app-updates/plugin.js';
import { localFilesConnector } from '../connectors/local-files/plugin.js';
import { googleDriveConnector } from '../connectors/google/drive-plugin.js';
import { todoSource, workspacePlugins } from './plugins-workspace.js';
import { spendingSkill } from '../skills/spending/plugin.js';
import { expensesSkill } from '../skills/expenses/plugin.js';
import { watchSkill } from '../skills/watch/plugin.js';
import { receiptsSkill } from '../skills/receipts/plugin.js';
import { tripSkill } from '../skills/trip/plugin.js';
import { filesSkill } from '../skills/files/plugin.js';
import { discordAppConnector, kakaoDesktopConnector } from '../connectors/screen-chat/index.js';
import { chatInboxSkill } from '../skills/chat-inbox/plugin.js';
import { smsReaderSkill } from '../skills/sms-reader/plugin.js';
import { browserConnector } from '../connectors/browser/plugin.js';
import { browserSkill } from '../skills/browser/plugin.js';
import { errandsSkill } from '../skills/errands/plugin.js';
import { recordingsSkill } from '../skills/recordings/plugin.js';
import { macosOcrConnector } from '../connectors/macos-ocr/plugin.js';
import { macAppsConnector } from '../connectors/mac-apps/plugin.js';
import { appleRemindersConnector } from '../connectors/apple-reminders/plugin.js';
import { devAssistSkill } from '../skills/dev-assist/plugin.js';
import { tuningSkill } from '../skills/tuning/plugin.js';
import { folderScanConnector } from '../connectors/local-files/scan-plugin.js';
import { agentSessionsConnector } from '../connectors/agent-sessions/plugin.js';
import { remoteSourcesConnector } from '../connectors/remote-sources/plugin.js';
import { readRemotesSync, remotesFile } from '../connectors/remote-sources/store.js';
import { talentSkill } from '../skills/talent/plugin.js';
import { standingSkill } from '../skills/standing/plugin.js';
import { knowledgeSkill } from '../skills/knowledge/plugin.js';
import { onboardingSkill } from '../skills/onboarding/plugin.js';
import { docsSkill } from '../skills/docs/plugin.js';
import { companySkill } from '../skills/company/plugin.js';
import { workSkill } from '../skills/work/plugin.js';

export interface BuiltinPluginOptions {
  /** The ax-kit home (~/.ax-kit); the receipts vault lives under it. Without it receipts are indexed only. */
  home?: string;
}

const on = (config: Config, id: string): boolean => config.plugins[id]?.enabled !== false;
const optedIn = (config: Config, id: string): boolean => config.plugins[id]?.enabled === true;

function koreanPackEnabled(config: Config): boolean {
  const enabled = config.plugins['connector.ko-life']?.enabled;
  return config.assistant.language === 'ko' ? enabled !== false : enabled === true;
}

/**
 * The built-in plugin set. Google connectors are opt-in because their `needs` would stop the app
 * when the account was never connected; setup enables them after a successful OAuth flow.
 */
export function builtinPlugins(config: Config, options: BuiltinPluginOptions = {}): Plugin[] {
  const plugins: Plugin[] = [
    ...channelPlugins(config, options),
    greetingSkill(),
    assistantSkill(),
    // 지금 하고 있는 일: dev jobs, browser tasks and errands register here; `work.status` answers "어떻게 됐어?"
    ...(on(config, 'skill.work') ? [workSkill()] : []),
    // finding a way: the owner's sites, what worked before, and the owner's signed-in browser through Aside
    ...(on(config, 'skill.ways') ? [waysSkill()] : []),
    ...(on(config, 'connector.aside') ? [asideConnector()] : []),
    ...(on(config, 'skill.routines') ? [routinesSkill()] : []),
    todoSkill({ source: todoSource(config) }),
    briefingSkill(),
    memorySkill(),
    interviewSkill(),
    daySkill(),
    docsSkill(options.home === undefined ? {} : { dir: join(options.home, 'knowledge', 'docs') }),
  ];

  // The app channel lives on the bridge's routes, so choosing the app keeps the bridge on.
  if (config.plugins['bridge.mobile']?.enabled !== false || usesApp(config)) plugins.push(mobileBridge(options.home !== undefined ? { localTokenFile: localTokenPath(options.home) } : {}));
  if (koreanPackEnabled(config)) plugins.push(koLifeConnector(), localLifeSkill());

  if (config.plugins['connector.google-calendar']?.enabled === true) {
    plugins.push(googleCalendarConnector(), calendarSkill());
  }
  if (config.plugins['connector.gmail']?.enabled === true) {
    plugins.push(gmailConnector(), mailSkill());
  }

  if (on(config, 'connector.web')) plugins.push(webConnector());
  // web research without the browser rides on the Claude Code CLI the assistant already signs in with
  const claudeCli = config.llm.providers.find((provider) => provider.kind === 'claude-cli');
  // the Android and Mac apps updated from this Mac's own builds (no store)
  if (usesApp(config) && on(config, 'skill.app-updates')) plugins.push(appUpdatesSkill(options.home !== undefined ? { paths: updatePaths(options.home) } : {}));
  // operating this Mac from chat: looks freely, every command on a card
  if (on(config, 'skill.ops')) plugins.push(opsSkill());
  if (claudeCli !== undefined && on(config, 'skill.web-search')) plugins.push(webSearchSkill(claudeCli.command !== undefined ? { command: claudeCli.command } : {}));
  if (optedIn(config, 'connector.local-files')) plugins.push(localFilesConnector());
  if (optedIn(config, 'connector.google-drive')) plugins.push(googleDriveConnector());
  plugins.push(...workspacePlugins(config));
  if (on(config, 'skill.spending')) plugins.push(spendingSkill());
  if (on(config, 'skill.expenses')) plugins.push(expensesSkill());
  if (on(config, 'skill.watch')) plugins.push(watchSkill());
  if (on(config, 'skill.standing')) plugins.push(standingSkill());
  if (on(config, 'skill.receipts')) {
    plugins.push(
      receiptsSkill(options.home === undefined ? {} : { vaultDir: join(options.home, 'files', 'vault') }),
    );
  }
  if (on(config, 'skill.trip')) plugins.push(tripSkill());
  if (on(config, 'skill.files')) plugins.push(filesSkill());
  plugins.push(...knowledgePlugins(config, options));
  plugins.push(...optionalPlugins(config, options));
  return plugins;
}

/** Discord, the phone app, or both (config.channel); each registers with the core channel hub. */
function channelPlugins(config: Config, options: BuiltinPluginOptions): Plugin[] {
  const plugins: Plugin[] = [];
  const ownerUserId = config.owner.discordUserId;
  if (usesDiscord(config) && ownerUserId !== undefined) {
    plugins.push(discordChannel({ ownerUserId, expiresMinutes: config.policy.expiresMinutes }));
  }
  if (usesApp(config)) {
    plugins.push(
      appChannel({
        expiresMinutes: config.policy.expiresMinutes,
        budget: config.llm.budget,
        ...(options.home !== undefined
          ? { inboxDir: join(options.home, 'files', 'inbox'), filesDir: join(options.home, 'files', 'app') }
          : {}),
      }),
    );
    // recordings → meeting notes come in through the app; off with plugins["skill.recordings"].enabled = false
    if (on(config, 'skill.recordings')) {
      plugins.push(recordingsSkill(options.home !== undefined ? { dir: join(options.home, 'files', 'recordings') } : {}));
    }
  }
  return plugins;
}

/**
 * M5a: the knowledge documents are on by default; the first-look scan (and its folder scanner) only after the owner
 * agreed in setup, which writes `skill.onboarding.enabled`.
 */
function knowledgePlugins(config: Config, options: BuiltinPluginOptions): Plugin[] {
  const plugins: Plugin[] = [];
  if (on(config, 'skill.knowledge')) {
    plugins.push(knowledgeSkill(options.home === undefined ? {} : { dir: join(options.home, 'knowledge') }));
  }
  if (optedIn(config, 'skill.onboarding')) plugins.push(folderScanConnector(), agentSessionsConnector(), onboardingSkill());
  // Other Macs paired with `ax-kit remote add` (work files on a MacBook); off with plugins["connector.remote-sources"].enabled = false
  const remotes = options.home === undefined ? [] : readRemotesSync(remotesFile(options.home));
  if (remotes.length > 0 && on(config, 'connector.remote-sources')) plugins.push(remoteSourcesConnector({ remotes }));
  return plugins;
}

/** M4 optional plugins: off until the owner turns them on (setup asks Korean owners, with the risks). */
function optionalPlugins(config: Config, options: BuiltinPluginOptions): Plugin[] {
  const plugins: Plugin[] = [];
  const binDir = options.home === undefined ? {} : { binDir: join(options.home, 'bin') };
  const kakao = optedIn(config, 'connector.kakao-desktop');
  const discord = optedIn(config, 'connector.discord-app');
  if (kakao) plugins.push(kakaoDesktopConnector(binDir));
  if (discord) plugins.push(discordAppConnector(binDir));
  // Text-message appointments need the inbox skill even without a screen-read chat app.
  // 문자 읽기 owns text messages when it is on: reservations, parcels, bills and smishing warnings.
  const smsReader = optedIn(config, 'skill.sms-reader');
  if (smsReader) plugins.push(smsReaderSkill());
  const smsAppointments = !smsReader && config.plugins['skill.chat-inbox']?.['sms'] === true;
  if ((kakao || discord || smsAppointments) && on(config, 'skill.chat-inbox')) {
    plugins.push(chatInboxSkill({ smsAppointments: !smsReader }));
  }
  if (optedIn(config, 'connector.browser')) {
    plugins.push(
      browserConnector(options.home === undefined ? {} : { profileDir: join(options.home, 'browser-profile') }),
    );
    if (on(config, 'skill.browser')) plugins.push(browserSkill());
    // 생활 심부름 (trains, tables, carts) rides on the same browser; off until the owner turns it on
    if (optedIn(config, 'skill.errands')) plugins.push(errandsSkill());
  }
  // The talent pack reads PDF résumés, which needs the on-device reader even when the owner did not pick it alone.
  const talent = optedIn(config, 'skill.talent');
  if (optedIn(config, 'connector.macos-ocr') || talent) plugins.push(macosOcrConnector(binDir));
  if (talent) plugins.push(talentSkill());
  if (optedIn(config, 'skill.dev-assist')) {
    plugins.push(devAssistSkill(options.home === undefined ? {} : { workDir: join(options.home, 'dev') }));
  }
  // 맥 확장: other apps through Accessibility, and Apple Reminders as the to-do list's two-way sync partner.
  if (optedIn(config, 'connector.mac-apps')) plugins.push(macAppsConnector(binDir));
  if (todoSource(config) === 'synced') plugins.push(appleRemindersConnector(binDir));
  if (optedIn(config, 'skill.tuning')) plugins.push(tuningSkill());
  if (optedIn(config, 'skill.company')) plugins.push(companySkill());
  return plugins;
}
