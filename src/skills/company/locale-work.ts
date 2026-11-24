import type { Effect } from '../../core/policy/types.js';
import type { CompanyTask } from './types.js';

export type ProfileSection = 'about' | 'products' | 'policies';

/** Owner-facing words for the work pipeline, decisions, company documents and the profile onboarding. */
export interface WorkTexts {
  readonly language: 'ko' | 'en';
  readonly scopeLabel: string;
  /** Heading of a chat-made team's member list in its doc. */
  readonly membersLabel: string;
  readonly decisionsTitle: string;
  readonly changelogTitle: string;
  readonly reviewLabel: string;
  readonly devMissing: string;
  readonly reviewFailed: string;
  readonly noDocs: string;
  readonly docMissing: string;
  effectLabel(effect: Effect): string;
  sectionTitle(section: ProfileSection): string;
  profileSaved(section: ProfileSection): string;
  testsLine(state: 'passed' | 'failed' | 'not_run'): string;
  onboarding(questions: readonly string[]): string;
  docsLine(doc: { id: string; title: string; needsReview: boolean }): string;
  decisionNotice(title: string, effects: string, preview: string): string;
  approveChoice(title: string): string;
  declineChoice(title: string): string;
  approved(task: CompanyTask): string;
  declined(title: string): string;
  decisionUnknown: string;
  approveLog(title: string): string;
  declineLog(title: string): string;
}

const MAX_CHOICE_TITLE = 20;

function clip(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > MAX_CHOICE_TITLE ? `${trimmed.slice(0, MAX_CHOICE_TITLE - 1)}…` : trimmed;
}

function numbered(questions: readonly string[]): string {
  return questions.map((question, index) => `${index + 1}. ${question}`).join('\n');
}

const KO: WorkTexts = {
  language: 'ko',
  scopeLabel: '맡는 일',
  membersLabel: '구성',
  decisionsTitle: '결정 기록',
  changelogTitle: '변경 기록',
  reviewLabel: '확인 필요',
  devMissing: '개발 도구가 연결되어 있지 않아요. 설정에서 개발 보조를 켜 주세요.',
  reviewFailed: '검토를 통과하지 못했어요.',
  noDocs: '아직 회사 문서가 없어요.',
  docMissing: '그 문서를 찾지 못했어요.',
  effectLabel: (effect) => {
    switch (effect) {
      case 'send':
        return '외부로 보내기';
      case 'pay':
        return '돈 쓰기';
      case 'delete':
        return '지우기';
      case 'write':
        return '내 데이터 바꾸기';
      default:
        return '읽기';
    }
  },
  sectionTitle: (section) => {
    switch (section) {
      case 'about':
        return '회사 소개';
      case 'products':
        return '제품과 서비스';
      default:
        return '회사 규칙';
    }
  },
  profileSaved: (section) => `회사 문서에 저장했어요: ${KO.sectionTitle(section)}`,
  testsLine: (state) =>
    state === 'passed' ? '검사: 통과' : state === 'failed' ? '검사: 실패' : '검사: 안 함',
  onboarding: (questions) =>
    `회사 문서를 아직 만들지 않았어요. 세 가지만 알려주시면 회사 문서로 저장할게요.\n${numbered(questions)}\n답은 그대로 회사 문서가 돼요.`,
  docsLine: (doc) => `• ${doc.needsReview ? '확인 필요 · ' : ''}${doc.title} (${doc.id})`,
  decisionNotice: (title, effects, preview) =>
    `대표 확인이 필요해요: ${title}\n필요한 일: ${effects}\n결과 미리보기: ${preview}`,
  approveChoice: (title) => `승인 ${clip(title)}`,
  declineChoice: (title) => `거절 ${clip(title)}`,
  approved: (task) =>
    `${task.title}: 승인 기록을 남겼어요. 보내기·결제·삭제는 회사 모드가 하지 않아요. 직접 하시거나, 비서에게 부탁하시면 비서가 확인 카드를 띄운 뒤 진행해요.`,
  declined: (title) => `${title}: 닫을게요.`,
  decisionUnknown: '그 결정을 찾지 못했어요. 이미 처리됐을 수 있어요.',
  approveLog: (title) => `대표 승인: ${title}`,
  declineLog: (title) => `대표 거절: ${title}`,
};

const EN: WorkTexts = {
  language: 'en',
  scopeLabel: 'Scope',
  membersLabel: 'Members',
  decisionsTitle: 'Decision log',
  changelogTitle: 'Change log',
  reviewLabel: 'needs review',
  devMissing: 'The dev tools are not connected. Turn on dev assist in settings.',
  reviewFailed: 'The work did not pass review.',
  noDocs: 'There are no company documents yet.',
  docMissing: 'I could not find that document.',
  effectLabel: (effect) => {
    switch (effect) {
      case 'send':
        return 'send outside';
      case 'pay':
        return 'spend money';
      case 'delete':
        return 'delete';
      case 'write':
        return 'change your data';
      default:
        return 'read';
    }
  },
  sectionTitle: (section) => {
    switch (section) {
      case 'about':
        return 'About the company';
      case 'products':
        return 'Products and services';
      default:
        return 'Company rules';
    }
  },
  profileSaved: (section) => `Saved to a company document: ${EN.sectionTitle(section)}`,
  testsLine: (state) =>
    state === 'passed' ? 'Tests: passed' : state === 'failed' ? 'Tests: failed' : 'Tests: not run',
  onboarding: (questions) =>
    `There are no company documents yet. Answer three short questions and I will save them as company documents.\n${numbered(questions)}\nYour answers become the documents as written.`,
  docsLine: (doc) => `• ${doc.needsReview ? 'needs review · ' : ''}${doc.title} (${doc.id})`,
  decisionNotice: (title, effects, preview) =>
    `Your approval is needed: ${title}\nNeeds: ${effects}\nPreview: ${preview}`,
  approveChoice: (title) => `Approve ${clip(title)}`,
  declineChoice: (title) => `Decline ${clip(title)}`,
  approved: (task) =>
    `${task.title}: approval recorded. Company mode does not send, pay or delete. Do it yourself, or ask the assistant, who shows its own confirmation card first.`,
  declined: (title) => `Closed: ${title}`,
  decisionUnknown: 'I could not find that decision. It may already be handled.',
  approveLog: (title) => `Owner approved: ${title}`,
  declineLog: (title) => `Owner declined: ${title}`,
};

export function workTexts(language: string): WorkTexts {
  return language === 'en' ? EN : KO;
}
