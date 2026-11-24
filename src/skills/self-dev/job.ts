import { join } from 'node:path';
import type { ProcessRunner } from '../../core/process/types.js';
import type { Coder } from '../dev-assist/coder.js';
import type { Checks, GitEnv } from './git-ops.js';
import { abortMerge, closeWorktree, commitAll, finishMerge, git, headOf, mergeBranch, openWorktree, runChecks, tail, takeFile } from './git-ops.js';
import type { AppRepo, AppResult } from './apps.js';
import { appsPrompt, applyApps, openAppWorktrees } from './apps.js';
import type { Piece } from './plan.js';
import { PLAN_FILE, SPLIT_RULES, parsePlan } from './plan.js';

/** How the assistant checks a change to its own code before it applies it (the repo's own gates). */
export const DEFAULT_CHECKS: Checks = [
  ['pnpm', 'exec', 'tsc', '--noEmit', '-p', '.'],
  ['pnpm', 'exec', 'eslint', '.'],
  ['pnpm', 'exec', 'vitest', 'run'],
];

const FIX_ROUNDS = 2;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** A part handed to a parallel session, as it ended. */
export type PieceOutcome =
  | { piece: Piece; status: 'done'; branch: string; summary: string; needs: string }
  | { piece: Piece; status: 'failed' | 'stopped'; detail: string };

export interface SelfDevDeps extends GitEnv {
  /** Where the job's own worktree goes (outside the checkout). */
  workDir: string;
  run: ProcessRunner;
  coder: Coder;
  checks?: Checks;
  /** false skips the start check after applying (tests without an ax-kit checkout). */
  boot?: boolean;
  /** Progress lines for the room ("코드를 고치는 중…"). */
  progress?: (line: string) => void;
  /** Runs the lead's split-off parts as parallel sessions from `base` and resolves when each has ended; none = no splitting. */
  parallel?: (pieces: readonly Piece[], base: string) => Promise<PieceOutcome[]>;
  /** One check run at a time on this Mac (parallel sessions share it). */
  checkLock?: <T>(work: () => Promise<T>) => Promise<T>;
  /** The assistant's own apps on this Mac, which the lead coder may change too (checked, merged and built per app). */
  apps?: readonly AppRepo[];
}

export type SelfDevOutcome =
  | { status: 'applied'; commit: string; summary: string; needs: string; installed: boolean; pieces?: PieceOutcome[]; apps?: AppResult[]; restart?: boolean }
  | { status: 'unchanged'; summary: string; needs: string }
  | { status: 'failed'; stage: 'prepare' | 'code' | 'checks' | 'apply'; detail: string; branch?: string; needs: string };

/** "요약: …" and "사람이 할 일: …" from the coder's last words (the instructions ask for them). */
export function readReport(log: string): { summary: string; needs: string } {
  const pick = (label: RegExp): string => {
    const match = label.exec(log);
    return match?.[1]?.trim().split('\n').slice(0, 8).join('\n').slice(0, 800) ?? '';
  };
  const summary = pick(/요약:\s*([\s\S]*?)(?=\n\s*사람이 할 일:|$)/);
  const needs = pick(/사람이 할 일:\s*([\s\S]*)$/);
  return { summary: summary || log.trim().split('\n').slice(-3).join('\n').slice(0, 400), needs: /^(없음|없어요|none)\.?$/i.test(needs) ? '' : needs };
}

/** The repository rules and the two report lines every coder gets, around its own task. */
export function codingPrompt(task: string): string {
  return [
    task,
    'Work only inside this folder (a git worktree of the running checkout). Follow the repository rules in CLAUDE.md/AGENTS.md/docs if present:',
    'layering core <- connectors/channels/skills <- app <- cli, at most 300 lines per file (split files), strict TypeScript, tests for behaviour changes, Korean user-facing text.',
    'Do not touch secrets, tokens or files outside this folder. Do not commit; the assistant runs `tsc`, `eslint` and `vitest` and commits itself.',
    'If the request needs something only a person can do (signing in, an API key, a permission prompt, a device), do the code part and say what is left.',
    'End your answer with exactly two lines in Korean:',
    '요약: <what you changed, one or two sentences>',
    '사람이 할 일: <what the owner must connect or do, or "없음">',
  ].join('\n');
}

export function instructionsFor(request: string, split = false): string {
  const task = `You are improving ax-kit itself: the local assistant this very process runs. The owner asked, in the "ax 개선" room:\n<request>\n${request}\n</request>`;
  return codingPrompt(split ? `${task}\n\n${SPLIT_RULES}` : task);
}

const locked = <T,>(deps: Pick<SelfDevDeps, 'checkLock'>, work: () => Promise<T>): Promise<T> => (deps.checkLock !== undefined ? deps.checkLock(work) : work());

/**
 * The repo's checks in `dir`, feeding failures back to the coder up to twice. Used by the lead and by each
 * parallel session; the report is the coder's last one.
 */
export async function checkAndFix(
  deps: Pick<SelfDevDeps, 'run' | 'coder' | 'checks' | 'checkLock' | 'progress'>,
  dir: string,
  instructions: string,
  report: { summary: string; needs: string },
  signal?: AbortSignal,
): Promise<{ ok: true; report: { summary: string; needs: string } } | { ok: false; detail: string; report: { summary: string; needs: string } }> {
  const say = deps.progress ?? (() => undefined);
  const checks = deps.checks ?? DEFAULT_CHECKS;
  let result = await locked(deps, () => runChecks(deps.run, checks, dir, signal));
  for (let round = 0; !result.ok && round < FIX_ROUNDS; round += 1) {
    if (signal?.aborted === true) break;
    say(`검사에서 걸린 곳을 고치는 중이에요 (${round + 1}/${FIX_ROUNDS})…`);
    const coded = await deps.coder.write({ dir, instructions: `${instructions}\n\nThe checks failed. Fix only what they report:\n<checks>\n${result.ok ? '' : result.detail}\n</checks>`, ...(signal !== undefined ? { signal } : {}) });
    report = readReport(coded.log);
    result = await locked(deps, () => runChecks(deps.run, checks, dir, signal));
  }
  return result.ok ? { ok: true, report } : { ok: false, detail: result.detail, report };
}

const joinLines = (lines: readonly string[]): string => lines.filter((line) => line !== '').join('\n');

/** The split-off parts: start them, take in the finished ones (conflicts resolved by the lead coder), redo failed ones here. */
async function runPieces(deps: SelfDevDeps, dir: string, request: string, base: string, pieces: readonly Piece[], signal?: AbortSignal): Promise<{ ok: true; outcomes: PieceOutcome[] } | { ok: false; detail: string }> {
  const say = deps.progress ?? (() => undefined);
  const own = await commitAll(deps, dir, `ax 개선: ${request.split('\n')[0]?.slice(0, 60) ?? ''} (내 몫)`);
  if (typeof own === 'object') return { ok: false, detail: own.error };
  const outcomes = await (deps.parallel as NonNullable<SelfDevDeps['parallel']>)(pieces, base);
  if (signal?.aborted === true) return { ok: false, detail: '멈췄어요.' };
  say('하위 작업이 다 끝나서 합치는 중이에요…');
  for (const outcome of outcomes) {
    if (outcome.status !== 'done') {
      if (outcome.status === 'stopped') continue;
      say(`'${outcome.piece.title}'은(는) 하위 작업에서 끝내지 못해서 여기서 직접 할게요…`);
      await deps.coder.write({ dir, instructions: `${instructionsFor(request)}\n\nA parallel coder could not finish this part; do it here:\n<part title="${outcome.piece.title}">\n${outcome.piece.brief}\n</part>\nWhat stopped it:\n${tail(outcome.detail).slice(-1500)}`, ...(signal !== undefined ? { signal } : {}) });
      const redone = await commitAll(deps, dir, `ax 개선: ${outcome.piece.title} (직접)`);
      if (typeof redone === 'object') return { ok: false, detail: redone.error };
      continue;
    }
    const merged = await mergeBranch(deps, dir, outcome.branch, `ax 개선: ${outcome.piece.title} 합치기`);
    if (merged === 'merged') continue;
    if (merged !== 'conflict') return { ok: false, detail: merged.error };
    say(`'${outcome.piece.title}'을(를) 합치다 겹친 곳이 있어서 정리하는 중이에요…`);
    await deps.coder.write({ dir, instructions: `${instructionsFor(request)}\n\nMerging the part "${outcome.piece.title}" from a parallel coder left git conflict markers in this folder. Resolve every conflict so both intents are kept; change nothing else.`, ...(signal !== undefined ? { signal } : {}) });
    const finished = await finishMerge(deps, dir);
    if (finished !== 'merged') {
      await abortMerge(deps, dir);
      return { ok: false, detail: `'${outcome.piece.title}'을(를) 합치지 못했어요. ${finished.error}` };
    }
  }
  return { ok: true, outcomes };
}

/** Fast-forwards the running checkout to `branch` if it is still at `base` and clean; installs and checks it starts. */
async function apply(deps: SelfDevDeps, base: string, branch: string): Promise<{ ok: true; installed: boolean } | { ok: false; detail: string }> {
  const say = deps.progress ?? (() => undefined);
  const dirty = await git(deps, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.out !== '') return { ok: false, detail: '실행 중인 코드에 커밋하지 않은 변경이 있어요.' };
  if ((await headOf(deps)) !== base) return { ok: false, detail: '그사이 실행 중인 코드가 바뀌었어요.' };
  const diff = await git(deps, ['diff', '--name-only', base, branch]);
  if (/(^|\n)node_modules(\/|\n|$)/.test(diff.out)) return { ok: false, detail: 'node_modules가 바뀌는 변경은 적용하지 않아요.' };
  const merged = await git(deps, ['merge', '--ff-only', '-q', branch]);
  if (!merged.ok) return { ok: false, detail: merged.out };
  let installed = false;
  if (/(^|\n)(package\.json|pnpm-lock\.yaml)(\n|$)/.test(diff.out)) {
    say('패키지가 바뀌어서 설치하는 중이에요…');
    installed = (await deps.run('pnpm', ['install', '--frozen-lockfile'], { cwd: deps.root, timeoutMs: INSTALL_TIMEOUT_MS }).catch(() => ({ code: 1 }))).code === 0;
    if (!installed) {
      // new code with old packages is not applied: back to where it was, packages too
      await git(deps, ['reset', '--keep', base]);
      await deps.run('pnpm', ['install', '--frozen-lockfile'], { cwd: deps.root, timeoutMs: INSTALL_TIMEOUT_MS }).catch(() => undefined);
      return { ok: false, detail: '바뀐 패키지를 설치하지 못해서 되돌렸어요. 인터넷 연결을 확인하고 다시 해 주세요.' };
    }
  }
  // the new code must still start: if it does not, the running checkout goes back to where it was and nothing restarts
  if (deps.boot !== false) {
    const boot = await deps.run(process.execPath, ['bin/ax-kit.mjs', 'help'], { cwd: deps.root, timeoutMs: 120_000 }).catch((error: unknown) => ({ code: 1, stdout: '', stderr: String(error), timedOut: false }));
    if (boot.code !== 0 || boot.timedOut) {
      await git(deps, ['reset', '--keep', base]);
      return { ok: false, detail: `새 코드가 켜지지 않아서 되돌렸어요.\n${tail(`${boot.stdout}\n${boot.stderr}`.trim())}` };
    }
  }
  return { ok: true, installed };
}

/**
 * One request in the "ax 개선" room: a worktree of the running checkout, the lead coder changes it (and may hand
 * independent parts to parallel sessions, merged back here), ax-kit runs the repo's checks (feeding failures back),
 * commits, then fast-forwards the running checkout. Restarting is the caller's; nothing here pushes.
 */
export async function runSelfDev(deps: SelfDevDeps, id: string, request: string, signal?: AbortSignal): Promise<SelfDevOutcome> {
  const branch = `ax-self/${id}`;
  const dir = join(deps.workDir, id);
  const say = deps.progress ?? (() => undefined);
  const base = await headOf(deps);
  if (base === undefined) return { status: 'failed', stage: 'prepare', detail: (await git(deps, ['rev-parse', 'HEAD'])).out, needs: '' };
  const added = await openWorktree(deps, dir, branch, base);
  if (!added.ok) return { status: 'failed', stage: 'prepare', detail: added.out, needs: '' };
  const appTrees = await openAppWorktrees(deps.run, deps.apps ?? [], deps.workDir, id);
  // a stop keeps each app's work on its branch; only the worktrees go
  const dropApps = async (): Promise<void> => {
    for (const tree of appTrees) await git({ root: tree.app.path, run: deps.run }, ['worktree', 'remove', '--force', tree.dir]);
  };
  // a failure keeps the work on its branches (ax-kit and each app) and removes the worktrees
  const failed = async (stage: 'code' | 'checks' | 'apply', detail: string, needs: string): Promise<SelfDevOutcome> => {
    for (const tree of appTrees) await commitAll({ root: tree.app.path, run: deps.run }, tree.dir, `ax 개선: 멈춘 작업 (${tree.app.name})`).catch(() => undefined);
    await dropApps();
    await git(deps, ['worktree', 'remove', '--force', dir]);
    return { status: 'failed', stage, detail, branch, needs };
  };
  const stopped = (): boolean => signal?.aborted === true;

  say('코드를 고치는 중이에요…');
  const split = deps.parallel !== undefined;
  const instructions = [instructionsFor(request, split), appsPrompt(appTrees)].filter((part) => part !== '').join('\n\n');
  const extraDirs = appTrees.map((tree) => tree.dir);
  const coded = await deps.coder.write({ dir, instructions, ...(extraDirs.length > 0 ? { extraDirs } : {}), ...(signal !== undefined ? { signal } : {}) });
  let report = readReport(coded.log);
  if (!coded.ok) return await failed('code', tail(coded.log), report.needs);
  const planText = await takeFile(dir, PLAN_FILE);
  let outcomes: PieceOutcome[] | undefined;
  if (planText !== undefined && split) {
    const plan = parsePlan(planText);
    if (!plan.ok || plan.pieces.length === 0) {
      say(plan.ok ? '나누지 않고 여기서 할게요…' : `${plan.reason}. 나누지 않고 여기서 할게요…`);
      const whole = await deps.coder.write({ dir, instructions: `${instructionsFor(request)}\n\nDo the whole request here (no ${PLAN_FILE}).`, ...(signal !== undefined ? { signal } : {}) });
      await takeFile(dir, PLAN_FILE);
      report = readReport(whole.log);
    } else {
      const pieces = await runPieces(deps, dir, request, base, plan.pieces, signal);
      if (!pieces.ok) return await failed('code', pieces.detail, report.needs);
      outcomes = pieces.outcomes;
      const done = outcomes.flatMap((outcome) => (outcome.status === 'done' ? [outcome] : []));
      report = { summary: joinLines([report.summary, ...done.map((outcome) => `· ${outcome.piece.title}: ${outcome.summary}`)]), needs: joinLines([report.needs, ...done.map((outcome) => outcome.needs)]) };
    }
  }
  const checked = await checkAndFix({ ...deps, progress: say }, dir, instructions, report, signal);
  // a fix round's report says what the fix was; what the lead and the parts did stays in front of it
  if (checked.report !== report) report = { summary: joinLines([report.summary, checked.report.summary !== '' ? `· 검사 고침: ${checked.report.summary}` : '']), needs: joinLines([report.needs, checked.report.needs]) };
  if (!checked.ok) return await failed('checks', checked.detail, report.needs);

  // a stop or the job's deadline during the checks: nothing is applied, whatever the checks said
  if (stopped()) return await failed('checks', '멈췄어요.', report.needs);
  const message = `ax 개선: ${request.split('\n')[0]?.slice(0, 60) ?? ''}`;
  const committed = await commitAll(deps, dir, message);
  if (typeof committed === 'object') return await failed('apply', committed.error, report.needs);
  const serverChanged = !(committed === 'none' && (await headOf(deps, dir)) === base);
  // the server first: apps follow only once the server they talk to has the change too
  const applied = serverChanged ? await apply(deps, base, branch) : undefined;
  if (applied !== undefined && !applied.ok) return await failed('apply', applied.detail, report.needs);
  // each app the coder changed: its own checks (with fix rounds in its folder), merge, build
  const apps = stopped() ? [] : await applyApps(deps.run, appTrees, id, message, async (app, appDir) => {
    const run: ProcessRunner = (cmd, args, opts) => deps.run(cmd, args, { ...opts, env: { ...app.env, ...opts.env } });
    const fixed = await checkAndFix({ run, coder: deps.coder, checks: app.checks, progress: say, ...(deps.checkLock !== undefined ? { checkLock: deps.checkLock } : {}) }, appDir, `${instructions}\n\nYou are now fixing the ${app.label} only, in this folder.`, report, signal);
    return { ok: fixed.ok, detail: fixed.ok ? '' : fixed.detail };
  }, say);
  if (stopped()) {
    // the server part may already be in; the app parts stay on their branches
    for (const tree of appTrees) await commitAll({ root: tree.app.path, run: deps.run }, tree.dir, `ax 개선: 멈춘 작업 (${tree.app.name})`).catch(() => undefined);
    await dropApps();
  }
  if (applied === undefined) {
    await closeWorktree(deps, dir, branch);
    if (apps.length > 0) return { status: 'applied', commit: '', installed: false, restart: false, apps, ...report };
    return { status: 'unchanged', ...report };
  }
  const commit = (await git(deps, ['rev-parse', '--short', 'HEAD'])).out;
  await closeWorktree(deps, dir, branch);
  return { status: 'applied', commit, installed: applied.installed, ...report, ...(outcomes !== undefined ? { pieces: outcomes } : {}), ...(apps.length > 0 ? { apps } : {}) };
}
