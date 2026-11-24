import type { JobPhase } from './types.js';

export type DevLanguage = 'ko' | 'en';
export type TestsState = 'passed' | 'failed' | 'none';

export interface DevTexts {
  readonly language: DevLanguage;
  tests(state: TestsState): string;
  startDescription(repo: string, request: string): string;
  startReady(branch: string, state: TestsState): string;
  startFailed(error: string): string;
  /** The job hit its deadline in `phase`: what was done, and that nothing was committed. */
  timedOut(phase: JobPhase | undefined): string;
  noChanges: string;
  protectedChanged(paths: readonly string[]): string;
  secretFound(kinds: readonly string[]): string;
  repos(count: number, slugs: readonly string[]): string;
  reposEmpty: string;
  issues(repo: string, count: number): string;
  issuesEmpty(repo: string): string;
  jobs(count: number): string;
  jobsEmpty: string;
  jobNotFound(id: string): string;
  jobNotReady(status: string): string;
  prDescription(
    repo: string,
    base: string,
    branch: string,
    title: string,
    diffStat: string,
    state: TestsState,
  ): string;
  prMissing(id: string): string;
  prOpened(url: string): string;
  discardDescription(branch: string, dir: string): string;
  discardMissing(id: string): string;
  discarded(branch: string): string;
  notManaged(branch: string): string;
  phase(phase: JobPhase): string;
  started(jobId: string): string;
  queued(jobId: string, ahead: number, current: string | undefined): string;
  finished(title: string, message: string, jobId: string): string;
  interrupted(title: string, jobId: string): string;
  activeLine(title: string, status: 'queued' | 'running', phase: JobPhase | undefined, minutes: number): string;
  resumeDescription(repo: string, branch: string): string;
  notInterrupted(status: string): string;
  jobBusy: string;
  queueFull(count: number): string;
}

const KO_PHASES: Record<JobPhase, string> = {
  preparing: '준비 중',
  worktree: '작업 공간 만듦',
  coding: '코드 고치는 중',
  testing: '테스트 중',
  committing: '커밋 중',
  pr: 'PR 올리는 중',
};

const KO_DONE: Record<JobPhase, string> = {
  preparing: '준비하던 중이라 아직 아무것도 바꾸지 않았어요.',
  worktree: '작업 공간까지 만들었어요.',
  coding: '작업 공간을 만들고 코드를 고치던 중이었어요.',
  testing: '코드는 고쳤고 테스트를 돌리던 중이었어요.',
  committing: '코드를 고치고 테스트까지 마쳤어요.',
  pr: '코드를 고치고 테스트까지 마쳤어요.',
};

const EN_DONE: Record<JobPhase, string> = {
  preparing: 'It was still preparing, so nothing changed.',
  worktree: 'The worktree was ready.',
  coding: 'The worktree was ready and the coder was still editing.',
  testing: 'The code was edited and the tests were still running.',
  committing: 'The code was edited and the tests had run.',
  pr: 'The code was edited and the tests had run.',
};

const EN_PHASES: Record<JobPhase, string> = {
  preparing: 'preparing',
  worktree: 'worktree ready',
  coding: 'coding',
  testing: 'running tests',
  committing: 'committing',
  pr: 'opening the PR',
};

const KO: DevTexts = {
  language: 'ko',
  tests(state) {
    if (state === 'passed') return '통과';
    if (state === 'failed') return '실패';
    return '없음';
  },
  startDescription: (repo, request) => `개발 작업 시작: ${repo} — ${request}`,
  startReady: (branch, state) =>
    `작업을 준비했어요. 브랜치 ${branch}, 테스트 ${KO.tests(state)}. 아직 GitHub에는 올리지 않았어요.`,
  startFailed: (error) => `작업을 마치지 못했어요. ${error}`,
  timedOut: (phase) => `시간이 다 돼서 멈췄어요. ${KO_DONE[phase ?? 'preparing']} 커밋은 하지 않았어요.`,
  noChanges: '바뀐 파일이 없어서 작업을 접었어요.',
  protectedChanged: (paths) => `만지면 안 되는 파일이 바뀌어서 멈췄어요: ${paths.join(', ')}`,
  secretFound: (kinds) => `비밀값이 섞인 것 같아서 멈췄어요 (${kinds.join(', ')}).`,
  repos: (count, slugs) => `등록된 저장소 ${count}개: ${slugs.join(', ')}`,
  reposEmpty: '등록된 저장소가 없어요. 설정에 repos를 추가해 주세요.',
  issues: (repo, count) => `${repo} 열린 이슈 ${count}개`,
  issuesEmpty: (repo) => `${repo}에 열린 이슈가 없어요.`,
  jobs: (count) => `개발 작업 ${count}개`,
  jobsEmpty: '개발 작업이 없어요.',
  jobNotFound: (id) => `${id} 작업을 찾지 못했어요.`,
  jobNotReady: (status) => `이 작업은 지금 상태(${status})라 PR을 열 수 없어요.`,
  prDescription: (repo, base, branch, title, diffStat, state) =>
    [
      'PR 초안 열기',
      `저장소: ${repo}`,
      `${base} ← ${branch}`,
      `제목: ${title}`,
      `바뀐 내용: ${diffStat.trim() === '' ? '없음' : diffStat.trim()}`,
      `테스트: ${KO.tests(state)}`,
    ].join('\n'),
  prMissing: (id) => `${id} 작업을 찾지 못해요.`,
  prOpened: (url) => `PR 초안을 열었어요. 확인하고 직접 머지해 주세요.\n${url}`,
  discardDescription: (branch, dir) => `작업 지우기: ${branch}\n${dir}`,
  discardMissing: (id) => `지울 ${id} 작업을 찾지 못했어요.`,
  discarded: (branch) => `${branch} 작업을 지웠어요.`,
  notManaged: (branch) => `ax-kit이 만든 브랜치가 아니라서 지우지 않았어요 (${branch}).`,
  phase: (phase) => KO_PHASES[phase],
  started: (jobId) => `시작했어요. 끝나면 알려드릴게요. (작업 ${jobId})`,
  queued: (jobId, ahead, current) =>
    `지금 ${current === undefined ? '다른 개발 작업' : `'${current}' 작업`}을 하고 있어서 그다음 순서로 해 둘게요` +
    `${ahead > 1 ? ` (앞에 ${ahead}개)` : ''}. 끝나면 알려드릴게요. (작업 ${jobId})`,
  finished: (title, message, jobId) => `개발 작업 '${title}': ${message} (작업 ${jobId})`,
  interrupted: (title, jobId) =>
    `서버가 다시 시작되면서 개발 작업 '${title}'이(가) 중간에 멈췄어요. '이어서 해 줘'라고 하시면 같은 브랜치에서 다시 할게요. (작업 ${jobId})`,
  activeLine: (title, status, phase, minutes) =>
    `${title}: ${status === 'queued' ? '순서 기다리는 중' : phase === undefined ? '하는 중' : KO_PHASES[phase]}, ${minutes < 1 ? '방금 시작' : `${minutes}분째`}`,
  resumeDescription: (repo, branch) => `멈춘 개발 작업 이어서 하기: ${repo} — ${branch}`,
  notInterrupted: (status) => `이 작업은 지금 상태(${status})라 이어서 할 게 없어요.`,
  jobBusy: '아직 하고 있는 작업이라 지우지 않았어요. 끝난 뒤에 지워 주세요.',
  queueFull: (count) => `개발 작업이 ${count}개나 밀려 있어서 더 받지 않았어요. 앞의 작업이 끝난 뒤에 다시 말씀해 주세요.`,
};

const EN: DevTexts = {
  language: 'en',
  tests(state) {
    if (state === 'passed') return 'passed';
    if (state === 'failed') return 'failed';
    return 'not run';
  },
  startDescription: (repo, request) => `Start dev job: ${repo} — ${request}`,
  startReady: (branch, state) =>
    `The job is ready on branch ${branch}; tests ${EN.tests(state)}. Nothing has been pushed to GitHub yet.`,
  startFailed: (error) => `The job did not finish. ${error}`,
  timedOut: (phase) => `Ran out of time and stopped. ${EN_DONE[phase ?? 'preparing']} Nothing was committed.`,
  noChanges: 'The coder changed no files, so the job was dropped.',
  protectedChanged: (paths) => `A protected file changed, so the job stopped: ${paths.join(', ')}`,
  secretFound: (kinds) => `The diff looked like it contained a credential (${kinds.join(', ')}), so the job stopped.`,
  repos: (count, slugs) => `${count} configured repositories: ${slugs.join(', ')}`,
  reposEmpty: 'No repositories are configured. Add them under repos in the skill config.',
  issues: (repo, count) => `${count} open issues in ${repo}`,
  issuesEmpty: (repo) => `${repo} has no open issues.`,
  jobs: (count) => `${count} dev jobs`,
  jobsEmpty: 'No dev jobs yet.',
  jobNotFound: (id) => `No job with id ${id}.`,
  jobNotReady: (status) => `The job is ${status}, so no pull request can be opened for it.`,
  prDescription: (repo, base, branch, title, diffStat, state) =>
    [
      'Open a draft pull request',
      `Repository: ${repo}`,
      `${base} ← ${branch}`,
      `Title: ${title}`,
      `Changes: ${diffStat.trim() === '' ? 'none' : diffStat.trim()}`,
      `Tests: ${EN.tests(state)}`,
    ].join('\n'),
  prMissing: (id) => `No job with id ${id}.`,
  prOpened: (url) => `Opened a draft pull request. Review and merge it yourself.\n${url}`,
  discardDescription: (branch, dir) => `Delete job: ${branch}\n${dir}`,
  discardMissing: (id) => `No job with id ${id} to delete.`,
  discarded: (branch) => `Deleted the job on ${branch}.`,
  notManaged: (branch) => `That branch was not created by ax-kit, so it was not deleted (${branch}).`,
  phase: (phase) => EN_PHASES[phase],
  started: (jobId) => `Started. I'll let you know when it's done. (job ${jobId})`,
  queued: (jobId, ahead, current) =>
    `${current === undefined ? 'Another dev job' : `'${current}'`} is running, so this one is queued next` +
    `${ahead > 1 ? ` (${ahead} ahead)` : ''}. I'll let you know when it's done. (job ${jobId})`,
  finished: (title, message, jobId) => `Dev job '${title}': ${message} (job ${jobId})`,
  interrupted: (title, jobId) =>
    `The server restarted and the dev job '${title}' stopped partway. Say "resume it" and I'll redo it on the same branch. (job ${jobId})`,
  activeLine: (title, status, phase, minutes) =>
    `${title}: ${status === 'queued' ? 'queued' : phase === undefined ? 'running' : EN_PHASES[phase]}, ${minutes < 1 ? 'just started' : `${minutes} min`}`,
  resumeDescription: (repo, branch) => `Resume an interrupted dev job: ${repo} — ${branch}`,
  notInterrupted: (status) => `The job is ${status}, so there is nothing to resume.`,
  jobBusy: 'That job is still in progress, so it was not deleted. Delete it once it is done.',
  queueFull: (count) => `${count} dev jobs are already waiting, so I didn't take this one. Ask again once those finish.`,
};

export function devTexts(language: string): DevTexts {
  return language === 'en' ? EN : KO;
}

export function testsState(tests: { passed: boolean } | undefined): TestsState {
  if (tests === undefined) return 'none';
  return tests.passed ? 'passed' : 'failed';
}
