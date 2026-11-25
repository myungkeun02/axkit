/** Every contract type and helper value, re-exported from one place (index.ts adds the capability ids). */
export { ViewInputError } from './device-api.js';

export type { CalendarEvent, EventDraft, TimeRange, CalendarReader, CalendarWriter, CalendarInfo, CalendarList } from './calendar.js';
export type {
  MailSummary,
  MailMessage,
  MailQuery,
  MailPage,
  MailDraft,
  MailReader,
  MailDrafter,
  MailSender,
  MailAwaitingReply,
  MailAttachment,
  MailAttachmentReader,
  NewMailDraft,
  MailComposer,
  MailLabel,
  MailOrganizer,
} from './mail.js';
export { MAIL_ORGANIZE_MAX, MailPermissionError, ORGANIZE_SYSTEM_LABELS } from './mail.js';
export type { TodoItem, TodoReader, TodoDraft, TodoWriter, TodoBackend, SyncedTodo, SyncedTodoPatch, TodoSyncBackend } from './todo.js';
export type {
  DocText,
  DocsReader,
  DocsWriter,
  DocsEditor,
  DocTarget,
  DocReplaceResult,
  SheetTab,
  SheetInfo,
  SheetValues,
  SheetsReader,
  SheetsWriter,
  Contact,
  ContactsReader,
} from './workspace.js';
export type {
  OwnerChannel,
  Notice,
  NoticeResult,
  Notifier,
  NoticeMuter,
  NoticeKindStats,
  NoticeStats,
} from './notify.js';
export type {
  PhoneLocation,
  PhoneDayTotals,
  PhoneSignals,
  OneTimeCode,
  OneTimeCodeVault,
  PhoneVoiceMemo,
  PhoneSms,
  SmsReaderClaims,
} from './phone.js';
export type {
  FactSourceKind,
  FactSource,
  Fact,
  RememberInput,
  RecallQuery,
  MemoryReader,
  MemoryWriter,
  PersonInteraction,
  PersonCommitment,
  PersonSummary,
  PersonProfile,
  PeopleReader,
  PeopleWriter,
  FactExpired,
  MemoryExpiry,
} from './memory.js';
export type {
  GeoPoint,
  Place,
  PlaceSource,
  RouteOption,
  RouteSource,
  WeatherReport,
  WeatherSource,
  TransitArrival,
  TransitSource,
  ParcelStatus,
  ParcelTracker,
  PriceOffer,
  PriceSearch,
  KnownPlaces,
  KnownPlacesSource,
} from './life.js';
export { MissingKeyError } from './life.js';
export type {
  PaymentNotice,
  PaymentNoticeSource,
  SpendCategory,
  CategorySource,
  SpendEntry,
  SpendReader,
} from './money.js';
export { SPEND_CATEGORIES } from './money.js';
export type {
  AppFileShare,
  FileChange,
  FileChangeKind,
  FileChangeRecord,
  FileEntry,
  FileSource,
  FileSourceRegistry,
  FileWatch,
  FilesChanged,
} from './files.js';
export type { WebPage, PageReader } from './web.js';
export type { ChatApp, ChatPreview, ChatAwaiting, ChatAwaitingReader } from './chat.js';
export type { RecognizedText, TextRecognizer } from './ocr.js';
export type {
  HandoffReason,
  AuthStep,
  BrowserAuthHelper,
  BrowserTask,
  BrowserRunResult,
  BrowserAgent,
  BrowserLiveHub,
  LiveBrowser,
  LiveCloseReason,
  LiveFrame,
  LiveInput,
  LiveKey,
  LiveState,
} from './browser.js';
export { LIVE_KEYS } from './browser.js';
export type { CardFeedback, TuningChange } from './feedback.js';
export type {
  KnowledgeOrigin,
  KnowledgeArea,
  KnowledgeLine,
  StoredKnowledgeLine,
  ProfileReader,
  ScanResult,
  KnowledgeWriter,
} from './knowledge.js';
export type { OrgUnit, ProposedSchedule, RoutineProposal } from './org.js';
export type { ReviewItem, ReviewRequest, OwnerReview, ReviewAnswer } from './review.js';
export type { ScannedFile, ScannedRepo, RepoCommit, RepoDetails, FolderWalk, FolderScan, FolderScanner } from './scan.js';
export type { RemoteInfo, RemoteFoundFile, RemoteSource, RemoteSourceDirectory } from './remote.js';
export type { AuthorKind, DocAuthor, DocKind, DocEntry, Doc, DocInput, DocQuery, DocStore } from './docs.js';
export type {
  PauseInput,
  PauseState,
  FeatureSwitches,
  FailureReport,
  FailureCount,
  FeatureHealth,
} from './switches.js';
export type { HealthArea, HealthFinding, HealthCheck, HealthRegistry } from './health.js';
export type { PurposeUsage, UsageReader } from './usage.js';
export type { BacklogSnapshot, BacklogReader } from './work.js';
export type { WorkItem, WorkKind, WorkStatus, WorkInProgress } from './work-in-progress.js';
export { ACTIVE_WORK, isActiveWork } from './work-in-progress.js';
export type { AssistantRunner, RunnerInput, RunnerResult } from './assistant.js';
export type { FirstLookPhase, FirstLookProgress, FirstLookReader, FirstLookStatus } from './first-look.js';

/**
 * Capability labels. A connector provides some of these; skills depend on them, never on a connector.
 * Narrow on purpose: a read-only mail connector provides `mailRead` and nothing else.
 */
export type {
  AppView,
  AppViewRegistry,
  DeviceApi,
  DeviceApiHandler,
  DeviceApiRequest,
  DeviceApiResponse,
  DeviceCaller,
  DeviceEventStream,
  DeviceFile,
  DeviceUpload,
  PhoneDeviceRevoked,
  PhoneSharedFile,
} from './device-api.js';
