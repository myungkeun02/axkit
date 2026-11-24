import type { AreaId } from './areas.js';

export type KnowledgeLanguage = 'ko' | 'en';

export interface KnowledgeFiles {
  readonly readme: string;
  readonly profile: string;
  readonly projectsDir: string;
  readonly areasDir: string;
  readonly changelog: string;
}

export type ProfileTopic = 'role' | 'org' | 'interest' | 'other';

export type ProjectSection = 'purpose' | 'status' | 'tasks' | 'role' | 'stack' | 'decisions' | 'open' | 'files' | 'recent' | 'people' | 'other';

export interface KnowledgeTexts {
  readonly language: KnowledgeLanguage;
  readonly files: KnowledgeFiles;
  readonly profileTopics: Readonly<Record<ProfileTopic, string>>;
  readonly projectSections: Readonly<Record<ProjectSection, string>>;
  readonly areaTitles: Readonly<Record<AreaId, string>>;
  readonly correctedLabel: string;
  readonly sourceLabel: string;
  readonly ownerLabel: string;
  readonly title: string;
  readonly profileTitle: string;
  readonly profileHeading: string;
  readonly projectsHeading: string;
  /** Heading of a company index and the line under each project's title. */
  companyLine(company: string): string;
  companyIndex(company: string, count: number): string;
  readonly areasHeading: string;
  readonly addedLabel: string;
  readonly changedLabel: string;
  readonly removedLabel: string;
  readonly changelogTitle: string;
  readonly changelogNote: string;
  readonly whatTheyDo: string;
  readonly organization: string;
  readonly interests: string;
  readonly activeProjects: string;
  readonly changelogHeader: string;
  lineCount(count: number): string;
  updatedLine(detail: string, stamp: string): string;
  readmeSummary(profileCount: number, projectCount: number, areaCount: number): string;
  readmeProfileLine(file: string, count: number): string;
  readmeProjectLine(name: string, file: string, status: string | undefined, date: string | undefined): string;
  readmeAreaLine(title: string, file: string, count: number, date: string | undefined): string;
  baseline(count: number): string;
  projectPurpose(name: string, purpose: string): string;
}

const KO: KnowledgeTexts = {
  language: 'ko',
  files: {
    readme: 'README.md',
    profile: '프로필.md',
    projectsDir: '프로젝트',
    areasDir: '분야',
    changelog: '변경기록.md',
  },
  profileTopics: {
    role: '하는 일·역할',
    org: '회사·조직',
    interest: '주요 관심사',
    other: '기타',
  },
  projectSections: {
    purpose: '목적',
    status: '상태',
    files: '관련 파일',
    tasks: '반복하는 일',
    role: '팀 역할',
    stack: '기술·도구',
    decisions: '정한 것',
    open: '남은 일',
    recent: '최근 활동',
    people: '사람',
    other: '메모',
  },
  areaTitles: {
    work: '일',
    people: '사람',
    life: '생활',
    health: '건강',
    money: '돈',
    tech: '기술·도구',
    interests: '관심사',
    other: '기타',
  },
  correctedLabel: '직접 고침',
  sourceLabel: '출처',
  ownerLabel: '나',
  title: '지식 문서',
  profileTitle: '프로필',
  profileHeading: '개요',
  projectsHeading: '프로젝트',
  companyLine: (company) => `회사: ${company}`,
  companyIndex: (company, count) => `${company}의 프로젝트 ${count}개`,
  areasHeading: '분야',
  addedLabel: '추가',
  changedLabel: '바뀜',
  removedLabel: '빠짐',
  changelogTitle: '변경 기록',
  changelogNote: '문서가 바뀔 때마다 맨 위에 붙습니다.',
  whatTheyDo: '하는 일',
  organization: '조직',
  interests: '관심사',
  activeProjects: '진행 중 프로젝트',
  changelogHeader: '# 변경 기록\n\n> 문서가 바뀔 때마다 맨 위에 붙습니다.',
  lineCount: (count) => `${count}줄`,
  updatedLine: (detail, stamp) => `> ${detail} · 갱신 ${stamp}`,
  readmeSummary: (profileCount, projectCount, areaCount) =>
    `프로필 ${profileCount}줄 · 프로젝트 ${projectCount}개 · 분야 ${areaCount}개`,
  readmeProfileLine: (file, count) => `- [${file}](<${file}>) — ${count}줄`,
  readmeProjectLine: (name, file, status, date) =>
    `- [${name}](<${file}>)${status === undefined ? '' : ` — ${status}`}${date === undefined ? '' : ` · ${date}`}`,
  readmeAreaLine: (title, file, count, date) =>
    `- [${title}](<${file}>) — ${count}줄${date === undefined ? '' : ` · ${date}`}`,
  baseline: (count) => `기준점 생성 (${count}줄)`,
  projectPurpose: (name, purpose) => `${name}: ${purpose}`,
};

const EN: KnowledgeTexts = {
  language: 'en',
  files: {
    readme: 'README.md',
    profile: 'profile.md',
    projectsDir: 'projects',
    areasDir: 'topics',
    changelog: 'changelog.md',
  },
  profileTopics: {
    role: 'Role',
    org: 'Organization',
    interest: 'Interests',
    other: 'Other',
  },
  projectSections: {
    purpose: 'Purpose',
    status: 'Status',
    files: 'Files',
    tasks: 'Recurring work',
    role: 'Team roles',
    stack: 'Stack & tools',
    decisions: 'Decisions',
    open: 'Open work',
    recent: 'Recent activity',
    people: 'People',
    other: 'Notes',
  },
  areaTitles: {
    work: 'Work',
    people: 'People',
    life: 'Life',
    health: 'Health',
    money: 'Money',
    tech: 'Tech & tools',
    interests: 'Interests',
    other: 'Other',
  },
  correctedLabel: 'corrected by owner',
  sourceLabel: 'source',
  ownerLabel: 'Owner',
  title: 'Knowledge base',
  profileTitle: 'Profile',
  profileHeading: 'Overview',
  projectsHeading: 'Projects',
  companyLine: (company) => `Company: ${company}`,
  companyIndex: (company, count) => `${count} projects at ${company}`,
  areasHeading: 'Topics',
  addedLabel: 'Added',
  changedLabel: 'Changed',
  removedLabel: 'Removed',
  changelogTitle: 'Changelog',
  changelogNote: 'The newest changes are added at the top.',
  whatTheyDo: 'What they do',
  organization: 'Organization',
  interests: 'Interests',
  activeProjects: 'Active projects',
  changelogHeader: '# Changelog\n\n> The newest changes are added at the top.',
  lineCount: (count) => (count === 1 ? '1 line' : `${count} lines`),
  updatedLine: (detail, stamp) => `> ${detail} · Updated ${stamp}`,
  readmeSummary: (profileCount, projectCount, areaCount) =>
    `${profileCount} profile lines · ${projectCount} projects · ${areaCount} areas`,
  readmeProfileLine: (file, count) => `- [${file}](<${file}>) — ${count === 1 ? '1 line' : `${count} lines`}`,
  readmeProjectLine: (name, file, status, date) =>
    `- [${name}](<${file}>)${status === undefined ? '' : ` — ${status}`}${date === undefined ? '' : ` · ${date}`}`,
  readmeAreaLine: (title, file, count, date) =>
    `- [${title}](<${file}>) — ${count === 1 ? '1 line' : `${count} lines`}${date === undefined ? '' : ` · ${date}`}`,
  baseline: (count) => `Baseline (${count === 1 ? '1 line' : `${count} lines`})`,
  projectPurpose: (name, purpose) => `${name}: ${purpose}`,
};

export function knowledgeTexts(language: string): KnowledgeTexts {
  return language === 'en' ? EN : KO;
}
