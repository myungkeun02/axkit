/** What the first look saw, in numbers, for choosing what to offer. Never file names or text. */
export interface SuggestFacts {
  /** Files and documents by type (resume, plan, proposal, contract, minutes, report, other). */
  docTypes: Readonly<Record<string, number>>;
  repos: number;
  /** Claude Code / Codex sessions read. */
  sessions: number;
  driveFiles: number;
  /** Mail senders and subjects seen in the signals step. */
  mail: number;
  calendar: number;
}

export interface SuggestEnv {
  /** Plugin on in config. */
  on(pluginId: string): boolean;
  /** Capability present in this server. */
  has(capabilityId: string): boolean;
}

/**
 * How a suggestion is turned on. "switch": the owner's yes writes the config and the server restarts. "command": it
 * needs an account or a token, so the owner runs a command on the Mac.
 */
export type SuggestHow = { kind: 'switch'; plugins: readonly string[] } | { kind: 'command'; command: string };

export interface Suggestion {
  id: string;
  title: string;
  /** What it does for the owner, one sentence. */
  benefit: string;
  /** Why it fits this owner, from the facts ("이력서가 342건 있어요"). */
  reason: string;
  how: SuggestHow;
}

interface Entry {
  id: string;
  title: string;
  benefit: string;
  how: SuggestHow;
  fits(facts: SuggestFacts, env: SuggestEnv): string | undefined;
}

const count = (facts: SuggestFacts, ...types: string[]): number => types.reduce((sum, type) => sum + (facts.docTypes[type] ?? 0), 0);

/**
 * Features worth offering after the first look, each with the evidence that makes it fit. General on purpose: who the
 * owner is decides, not a fixed persona. The model only picks among these and words the reasons; ideas outside the
 * list become improvement requests instead.
 */
const CATALOG: readonly Entry[] = [
  {
    id: 'talent',
    title: '인재 소개 팩',
    benefit: '이력서를 후보자 명부로 정리해 "자바 8년차 이상" 같은 말로 찾고, 채용 요청에 맞는 사람을 골라 드려요.',
    how: { kind: 'switch', plugins: ['skill.talent'] },
    fits: (facts, env) => (count(facts, 'resume') >= 5 && !env.on('skill.talent') ? `다른 사람의 이력서가 ${count(facts, 'resume')}건 있어요` : undefined),
  },
  {
    id: 'ocr',
    title: 'PDF·사진 글자 읽기',
    benefit: '스캔한 PDF와 사진 속 글자를 이 맥에서 읽어 문서 알아보기와 영수증 정리에 써요.',
    how: { kind: 'switch', plugins: ['connector.macos-ocr'] },
    fits: (facts, env) => {
      const docs = count(facts, 'resume', 'plan', 'proposal', 'contract', 'report');
      // The talent pack brings the reader along; offering both would ask twice.
      const talentFits = count(facts, 'resume') >= 5;
      return docs >= 10 && !talentFits && !env.has('ocr.text') && !env.on('skill.talent') ? `PDF·Word 문서가 ${docs}건 있어요` : undefined;
    },
  },
  {
    id: 'google-docs',
    title: 'Google 문서·시트 읽고 쓰기',
    benefit: '기획서·보고서를 Google 문서로 바로 만들고 고치며, 시트 숫자도 대화로 찾아요.',
    how: { kind: 'command', command: 'ax-kit connect google' },
    fits: (facts, env) => {
      const docs = count(facts, 'plan', 'proposal', 'report', 'minutes');
      return docs >= 5 && facts.driveFiles > 0 && !env.has('docs.read') ? `기획서·보고서·회의록이 ${docs}건, Drive 문서도 쓰고 계세요` : undefined;
    },
  },
  {
    id: 'gmail-organize',
    title: 'Gmail 정리',
    benefit: '광고·알림 메일을 모아 보관하고 라벨을 붙여 받은편지함을 가볍게 해요(지우지는 않아요).',
    how: { kind: 'command', command: 'ax-kit connect google' },
    fits: (facts, env) => (facts.mail >= 20 && !env.has('mail.organize') ? '메일이 많이 오가요' : undefined),
  },
  {
    id: 'company',
    title: '회사 모드 (팀 봇)',
    benefit: '맡긴 일을 팀장 봇이 계획하고 팀원 봇이 하고 검토까지 해서 하루 한 번 보고해요.',
    how: { kind: 'command', command: 'ax-kit setup' },
    fits: (facts, env) => {
      const work = count(facts, 'plan', 'proposal', 'report', 'minutes') + facts.repos;
      return work >= 5 && !env.on('skill.company') ? `진행 중인 기획·프로젝트가 여럿이에요` : undefined;
    },
  },
  {
    id: 'dev-assist',
    title: '개발 보조',
    benefit: '개발하던 저장소를 이 맥에 받아, 개발팀이 여기서 이슈를 고치고 시험을 돌려 초안 PR까지 만들어요(병합은 직접).',
    how: { kind: 'switch', plugins: ['skill.dev-assist'] },
    fits: (facts, env) => (facts.repos >= 1 && facts.sessions >= 5 && !env.on('skill.dev-assist') ? `코드 저장소 ${facts.repos}개와 코딩 대화 ${facts.sessions}개가 있어요` : undefined),
  },
];

/** The features that fit what the first look saw and are not on yet. */
export function fittingSuggestions(facts: SuggestFacts, env: SuggestEnv): Suggestion[] {
  const out: Suggestion[] = [];
  for (const entry of CATALOG) {
    const reason = entry.fits(facts, env);
    if (reason !== undefined) out.push({ id: entry.id, title: entry.title, benefit: entry.benefit, reason, how: entry.how });
  }
  return out;
}
