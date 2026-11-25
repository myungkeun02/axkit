import { defineCapability } from '../plugin/capability.js';
import type { CalendarReader, CalendarWriter } from './calendar.js';
import type {
  MailAttachmentReader,
  MailAwaitingReply,
  MailComposer,
  MailDrafter,
  MailOrganizer,
  MailReader,
  MailSender,
} from './mail.js';
import type { NoticeMuter, Notifier, OwnerChannel } from './notify.js';
import type { TodoBackend, TodoReader, TodoSyncBackend, TodoWriter } from './todo.js';
import type { ContactsReader, DocsEditor, DocsReader, DocsWriter, SheetsReader, SheetsWriter } from './workspace.js';
import type { OneTimeCodeVault, PhoneSignals, SmsReaderClaims } from './phone.js';
import type { MemoryReader, MemoryWriter, PeopleReader, PeopleWriter } from './memory.js';
import type { KnownPlacesSource, ParcelTracker, PlaceSource, PriceSearch, RouteSource, TransitSource, WeatherSource } from './life.js';
import type { SpendReader } from './money.js';
import type { AppFileShare, FileSource, FileSourceRegistry } from './files.js';
import type { PageReader } from './web.js';
import type { TextRecognizer } from './ocr.js';
import type { BrowserAgent, BrowserLiveHub } from './browser.js';
import type { KillSwitch } from '../switches/kill.js';
import type { AutonomyRules } from '../policy/autonomy.js';
import type { AutonomyPromotion } from '../policy/promoter.js';
import type { WorkLog } from '../log/work-log.js';
import type { BotDirectory } from './bots.js';
import type { DriveWriter } from './drive.js';
import type { OwnerQuestions } from '../policy/questions.js';
import type { TopicAnswers } from '../policy/topics.js';
import type { LlmControl } from './llm-control.js';
import type { AssistantContext, WebAgent } from './web-agent.js';
import type { KnowledgeWriter, ProfileReader } from './knowledge.js';
import type { OwnerReview } from './review.js';
import type { FolderScanner } from './scan.js';
import type { AgentSessionReader } from './sessions.js';
import type { RemoteSourceDirectory } from './remote.js';
import type { TalentDirectory, TalentIntake } from './talent.js';
import type { FeatureSetup } from './feature-setup.js';
import type { MailIntentRegistry } from './mail-intents.js';
import type { DocStore } from './docs.js';
import type { FeatureHealth, FeatureSwitches } from './switches.js';
import type { HealthRegistry } from './health.js';
import type { UsageReader } from './usage.js';
import type { BacklogReader } from './work.js';
import type { WorkInProgress } from './work-in-progress.js';
import type { NoticeStats } from './notify.js';
import type { MemoryExpiry } from './memory.js';
import type { AppViewRegistry, DeviceApi } from './device-api.js';
import type { ChatAwaitingReader } from './chat.js';
import type { AssistantRunner } from './assistant.js';
import type { FirstLookReader } from './first-look.js';
export * from './exports.js';

export const Contracts = {
  calendarRead: defineCapability<CalendarReader>('calendar.read'),
  calendarWrite: defineCapability<CalendarWriter>('calendar.write'),
  mailRead: defineCapability<MailReader>('mail.read'),
  mailDraft: defineCapability<MailDrafter>('mail.draft'),
  mailSend: defineCapability<MailSender>('mail.send'),
  mailAwaiting: defineCapability<MailAwaitingReply>('mail.awaiting'),
  todoRead: defineCapability<TodoReader>('todo.read'),
  todoWrite: defineCapability<TodoWriter>('todo.write'),
  todoBackend: defineCapability<TodoBackend>('todo.backend'),
  todoSync: defineCapability<TodoSyncBackend>('todo.sync'),
  docsRead: defineCapability<DocsReader>('docs.read'),
  docsWrite: defineCapability<DocsWriter>('docs.write'),
  docsEdit: defineCapability<DocsEditor>('docs.edit'),
  sheetsRead: defineCapability<SheetsReader>('sheets.read'),
  sheetsWrite: defineCapability<SheetsWriter>('sheets.write'),
  contactsRead: defineCapability<ContactsReader>('contacts.read'),
  ownerChannel: defineCapability<OwnerChannel>('owner.channel'),
  notifier: defineCapability<Notifier>('core.notifier'),
  phoneSignals: defineCapability<PhoneSignals>('phone.signals'),
  phoneOtp: defineCapability<OneTimeCodeVault>('phone.otp'),
  smsReader: defineCapability<SmsReaderClaims>('phone.sms-reader'),
  memoryRead: defineCapability<MemoryReader>('memory.read'),
  memoryWrite: defineCapability<MemoryWriter>('memory.write'),
  peopleRead: defineCapability<PeopleReader>('people.read'),
  places: defineCapability<PlaceSource>('life.places'),
  routes: defineCapability<RouteSource>('life.routes'),
  weather: defineCapability<WeatherSource>('life.weather'),
  knownPlaces: defineCapability<KnownPlacesSource>('life.known-places'),
  transit: defineCapability<TransitSource>('life.transit'),
  parcel: defineCapability<ParcelTracker>('life.parcel'),
  prices: defineCapability<PriceSearch>('life.prices'),
  mailAttachments: defineCapability<MailAttachmentReader>('mail.attachments'),
  mailCompose: defineCapability<MailComposer>('mail.compose'),
  mailOrganize: defineCapability<MailOrganizer>('mail.organize'),
  spendRead: defineCapability<SpendReader>('spend.read'),
  filesLocal: defineCapability<FileSource>('files.local'),
  filesDrive: defineCapability<FileSource>('files.drive'),
  fileSources: defineCapability<FileSourceRegistry>('files.sources'),
  driveWrite: defineCapability<DriveWriter>('files.drive-write'),
  webPage: defineCapability<PageReader>('web.page'),
  peopleWrite: defineCapability<PeopleWriter>('people.write'),
  noticeMute: defineCapability<NoticeMuter>('core.notice-mute'),
  ocr: defineCapability<TextRecognizer>('ocr.text'),
  browser: defineCapability<BrowserAgent>('browser.agent'),
  browserLive: defineCapability<BrowserLiveHub>('browser.live'),
  knowledgeProfile: defineCapability<ProfileReader>('knowledge.profile'),
  knowledgeWrite: defineCapability<KnowledgeWriter>('knowledge.write'),
  ownerReview: defineCapability<OwnerReview>('owner.review'),
  folderScan: defineCapability<FolderScanner>('files.scan'),
  agentSessions: defineCapability<AgentSessionReader>('sessions.agents'),
  remoteSources: defineCapability<RemoteSourceDirectory>('files.remote-sources'),
  talentIntake: defineCapability<TalentIntake>('talent.intake'),
  talent: defineCapability<TalentDirectory>('talent.directory'),
  featureSetup: defineCapability<FeatureSetup>('core.feature-setup'),
  mailIntents: defineCapability<MailIntentRegistry>('mail.intents'),
  docs: defineCapability<DocStore>('knowledge.docs'),
  switches: defineCapability<FeatureSwitches>('core.switches'),
  featureHealth: defineCapability<FeatureHealth>('core.feature-health'),
  health: defineCapability<HealthRegistry>('core.health'),
  usage: defineCapability<UsageReader>('core.usage'),
  noticeStats: defineCapability<NoticeStats>('core.notice-stats'),
  backlog: defineCapability<BacklogReader>('work.backlog'),
  workInProgress: defineCapability<WorkInProgress>('work.in-progress'),
  memoryExpiry: defineCapability<MemoryExpiry>('memory.expiry'),
  deviceApi: defineCapability<DeviceApi>('device.api'),
  appViews: defineCapability<AppViewRegistry>('app.views'),
  appShare: defineCapability<AppFileShare>('app.share-file'),
  chatAwaiting: defineCapability<ChatAwaitingReader>('chat.awaiting'),
  killSwitch: defineCapability<KillSwitch>('core.kill-switch'),
  autonomy: defineCapability<AutonomyRules>('core.autonomy'),
  autonomyPromotion: defineCapability<AutonomyPromotion>('core.autonomy-promotion'),
  workLog: defineCapability<WorkLog>('core.work-log'),
  bots: defineCapability<BotDirectory>('bots.directory'),
  questions: defineCapability<OwnerQuestions>('core.questions'),
  topics: defineCapability<TopicAnswers>('core.topics'),
  llmControl: defineCapability<LlmControl>('core.llm-control'),
  webAgent: defineCapability<WebAgent>('web.agent'),
  assistantContext: defineCapability<AssistantContext>('assistant.context'),
  assistantRunner: defineCapability<AssistantRunner>('assistant.runner'),
  firstLook: defineCapability<FirstLookReader>('onboarding.first-look'),
} as const;
