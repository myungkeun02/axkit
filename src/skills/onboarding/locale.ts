import type { RunCounts, RunState, RunStatus, ScanPhase } from './state.js';

export type OnboardingLanguage = 'ko' | 'en';

export interface OnboardingFinished {
  counts: RunCounts;
  added: number;
  retired: number;
}

export interface OnboardingTexts {
  readonly language: OnboardingLanguage;
  readonly reviewTitle: string;
  readonly started: string;
  readonly alreadyRunning: string;
  readonly stopped: string;
  readonly notRunning: string;
  readonly resumed: string;
  readonly notPaused: string;
  readonly failed: (error: string) => string;
  /** The first look stopped because no AI answered. */
  readonly noModel: string;
  readonly summarizeLanguage: string;
  readonly answerLanguage: string;
  readonly activeStatus: string;
  readonly restingStatus: string;
  readonly progress: (phase: ScanPhase, done: number, total: number) => string;
  readonly finished: (summary: OnboardingFinished) => string;
  readonly status: (state: RunState, cacheSize: number) => string;
  readonly tools: (items: readonly string[]) => string;
  /** The folder-statistics line that stands in for all résumés found. */
  readonly resumeStat: (count: number) => string;
}

const KO_PHASE: Record<ScanPhase, string> = {
  local: '폴더',
  projects: '프로젝트 문서·대화 기록',
  drive: 'Drive',
  signals: '연결된 기능',
  profile: '정리',
  done: '끝',
};

const KO_STATUS: Record<RunStatus, string> = {
  idle: '아직 안 함',
  running: '하는 중',
  paused: '멈춤',
  done: '끝남',
  failed: '실패',
};

const KO: OnboardingTexts = {
  language: 'ko',
  reviewTitle: '제가 이해한 당신',
  started: '알아보기 시작할게요. 끝나면 알려 드릴게요.',
  alreadyRunning: '이미 알아보는 중이에요.',
  stopped: '알아보기를 멈췄어요. 다시 하려면 "알아보기 계속"이라고 해 주세요.',
  notRunning: '지금 알아보는 중이 아니에요.',
  resumed: '멈춘 곳부터 다시 알아볼게요.',
  notPaused: '이어서 할 알아보기가 없어요. "처음 알아보기"로 시작할 수 있어요.',
  failed: (error) => `알아보다가 문제가 생겼어요(${error}). 나중에 다시 해 볼게요.`,
  noModel: 'AI에 연결되지 않아서 처음 알아보기를 멈췄어요. 맥에서 `ax-kit doctor`로 AI 연결을 확인한 뒤, 대화창에 "처음 알아보기"라고 보내 주세요. 읽은 파일은 기억해 두었어요.',
  summarizeLanguage: 'Korean',
  answerLanguage: 'Korean',
  activeStatus: '진행 중',
  restingStatus: '쉬는 중',
  progress: (phase, done, total) => `${KO_PHASE[phase]} 살펴보는 중… ${done}/${total}`,
  finished: ({ counts, added, retired }) =>
    `알아보기 끝났어요. 새로 ${added}줄, 정리한 ${retired}줄. ` +
    `파일 ${counts.files} · 저장소 ${counts.repos} · 프로젝트 문서 ${counts.docs} · 대화 기록 ${counts.sessions} · Drive ${counts.drive} · 요약 ${counts.summarized} · 신호 ${counts.signals}`,
  status: (state, cacheSize) =>
    `알아보기: ${KO_STATUS[state.status]} · ${KO_PHASE[state.phase]} · ` +
    `파일 ${state.counts.files} · 저장소 ${state.counts.repos} · 프로젝트 문서 ${state.counts.docs} · 대화 기록 ${state.counts.sessions} · Drive ${state.counts.drive} · ` +
    `요약 ${state.counts.summarized} · 신호 ${state.counts.signals} · 기억한 요약 ${cacheSize}`,
  tools: (items) => `주로 쓰는 언어/도구: ${items.join(', ')}`,
  resumeStat: (count) => `다른 사람의 이력서 ${count}건을 갖고 있음(인재 소개·채용 일)`,
};

const EN_PHASE: Record<ScanPhase, string> = {
  local: 'folders',
  projects: 'project docs and sessions',
  drive: 'Drive',
  signals: 'connected apps',
  profile: 'profile',
  done: 'done',
};

const EN_STATUS: Record<RunStatus, string> = {
  idle: 'not started',
  running: 'running',
  paused: 'paused',
  done: 'done',
  failed: 'failed',
};

const EN: OnboardingTexts = {
  language: 'en',
  reviewTitle: 'What I learned about you',
  started: "I'll start the first look and tell you when it's done.",
  alreadyRunning: 'The first look is already running.',
  stopped: 'I stopped the first look. Say "resume the scan" to continue.',
  notRunning: 'The first look is not running.',
  resumed: 'Picking up where the last scan stopped.',
  notPaused: 'There is no paused scan. Say "get to know me" to start one.',
  failed: (error) => `The first look hit a problem (${error}). I'll try again later.`,
  noModel: 'No AI answered, so the first look stopped. Check the AI connection with `ax-kit doctor` on the Mac, then send "first look". What was read is kept.',
  summarizeLanguage: 'English',
  answerLanguage: 'English',
  activeStatus: 'active',
  restingStatus: 'resting',
  progress: (phase, done, total) => `${EN_PHASE[phase]}: ${done}/${total}`,
  finished: ({ counts, added, retired }) =>
    `The first look is finished. ${added} new lines, ${retired} retired. ` +
    `files ${counts.files} · repos ${counts.repos} · project docs ${counts.docs} · sessions ${counts.sessions} · Drive ${counts.drive} · summaries ${counts.summarized} · signals ${counts.signals}`,
  status: (state, cacheSize) =>
    `First look: ${EN_STATUS[state.status]} · ${EN_PHASE[state.phase]} · ` +
    `files ${state.counts.files} · repos ${state.counts.repos} · project docs ${state.counts.docs} · sessions ${state.counts.sessions} · Drive ${state.counts.drive} · ` +
    `summaries ${state.counts.summarized} · signals ${state.counts.signals} · cached ${cacheSize}`,
  tools: (items) => `Main languages/tools: ${items.join(', ')}`,
  resumeStat: (count) => `Holds ${count} résumés of other people (recruiting or introductions)`,
};

export function onboardingTexts(language: string): OnboardingTexts {
  return language === 'en' ? EN : KO;
}
