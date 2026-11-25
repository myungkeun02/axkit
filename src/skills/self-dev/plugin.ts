import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { botAddress, botOfAddress } from '../../core/contracts/bots.js';
import { Contracts } from '../../core/contracts/index.js';
import type { MessageHandler } from '../../core/conversation/types.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import type { Coder } from '../dev-assist/coder.js';
import type { AppRepo } from './apps.js';
import type { WorkInProgress } from '../../core/contracts/work-in-progress.js';
import { appsReport } from './apps.js';
import { isOpsRequest, startOps } from './ops-room.js';
import { coderGate } from '../dev-assist/coder-budget.js';
import type { SelfDevOutcome } from './job.js';
import { runSelfDev } from './job.js';
import type { SessionRecord } from './parallel.js';
import { ParallelSessions, SESSIONS_KEY, createLock } from './parallel.js';

export const SELF_DEV_ROOM = 'ax-dev';
const GROUP = 'assistant-admin';
const PENDING_KEY = 'pending-report';
const JOB_TIMEOUT_MS = 90 * 60_000;
const STOP = /^\s*(멈춰|그만|중단|취소|stop)/i;
const STATUS = /(상태|어떻게 (돼|됐)|진행)/;
const TIDY = /^\s*(정리|방 정리)/;

interface Running {
  title: string;
  controller: AbortController;
  sessions: ParallelSessions;
}

const PendingSchema = z.object({ id: z.string(), request: z.string(), commit: z.string(), summary: z.string(), needs: z.string(), installed: z.boolean() });

export interface SelfDevOptions {
  /** The running checkout. */
  root: string;
  workDir: string;
  /** The coding agent (Claude Code / Codex CLI in the worktree); undefined = the room explains how to get one. */
  coder: () => Coder | undefined;
  /** Under the login service: ending the process brings the new code up. */
  managed: boolean;
  restart: () => void;
  run: Parameters<typeof runSelfDev>[0]['run'];
  checks?: readonly (readonly string[])[];
  /** The app repos the room may change (production: found in ~/ax-kit-apps); none in tests. */
  apps?: () => Promise<AppRepo[]>;
}

function line(outcome: SelfDevOutcome): string {
  const needs = outcome.needs !== '' ? `\n\n사람이 할 일:\n${outcome.needs}` : '';
  if (outcome.status === 'unchanged') return `바꿀 코드가 없었어요.\n${outcome.summary}${needs}`;
  if (outcome.status === 'failed') {
    const where = { prepare: '준비', code: '코드 고치기', checks: '검사(tsc·eslint·vitest)', apply: '적용' }[outcome.stage];
    const kept = outcome.branch !== undefined ? `\n작업은 브랜치 ${outcome.branch}에 남겨 뒀어요. 실행 중인 비서는 바뀌지 않았어요.` : '';
    return `${where} 단계에서 멈췄어요.${kept}\n\n${outcome.detail.slice(-1200)}${needs}`;
  }
  const apps = outcome.apps !== undefined && outcome.apps.length > 0 ? `\n\n앱:\n${appsReport(outcome.apps)}` : '';
  const head = outcome.commit !== '' ? `검사를 모두 통과해서 적용했어요 (${outcome.commit}).` : '서버는 그대로 두고 앱만 바꿨어요.';
  return `${head}\n${outcome.summary}${apps}${needs}`;
}

/**
 * The "ax 개선" room: the owner says what to change about the assistant itself; it works on its own code in a
 * worktree, checks it with the repo's own gates, applies it and restarts, then reports here — the result, or what the
 * owner still has to connect. One request at a time.
 */
export function selfDevPlugin(opts: SelfDevOptions): Plugin {
  return {
    manifest: { id: 'skill.self-dev', kind: 'skill', title: 'ax 개선 (비서가 자기 코드를 고치고 다시 켜요)' },
    async setup(ctx) {
      if (ctx.config['enabled'] === false) return;
      let busy: Running | undefined;
      const lock = createLock();
      const postIn = (room: string, text: string): void => void ctx.bus.emit('bots.message', { bot: { id: room, name: 'ax 개선' }, text, channel: room }).catch(() => undefined);
      const post = (text: string): void => postIn(SELF_DEV_ROOM, text);

      ctx.bus.on('app.started', () => {
        void (async () => {
          const directory = ctx.tryUse(Contracts.bots);
          if (directory !== undefined && (await directory.get(SELF_DEV_ROOM)) === undefined) {
            if (!(await directory.groups()).some((group) => group.id === GROUP)) await directory.upsertGroup({ id: GROUP, label: '비서 관리', summary: '비서 자신을 고치고 관리하는 방' });
            await directory.upsert({ id: SELF_DEV_ROOM, name: 'ax 개선', role: '비서 자신의 코드를 고치고, 검사하고, 다시 켜요', group: GROUP, kind: 'dev', origin: 'owner' });
          }
          await interrupted(ctx, postIn);
          const pending = PendingSchema.safeParse(await ctx.kv.get<unknown>(PENDING_KEY));
          if (!pending.success) return;
          await ctx.kv.delete(PENDING_KEY);
          const data = pending.data;
          post(`다시 켰어요 ✓ 새 코드(${data.commit})로 돌고 있어요.\n바뀐 것: ${data.summary}${data.installed ? '\n(패키지도 새로 설치했어요)' : ''}${data.needs !== '' ? `\n\n사람이 할 일:\n${data.needs}` : ''}`);
          // the assistant improving itself is not the owner's news: it goes to the work log only
          await ctx.tryUse(Contracts.workLog)?.add({ at: ctx.clock.now(), title: `ax 개선 적용: ${data.summary.slice(0, 120)}`, kind: 'action' }).catch(() => undefined);
        })().catch((error: unknown) => ctx.log.warn('self-dev: start report failed', { error: error instanceof Error ? error.message : 'error' }));
      });

      const handler: MessageHandler = {
        id: 'self-dev',
        priority: 10,
        async handle(message, replier) {
          const room = botOfAddress(message.conversation.address);
          if (!message.fromOwner || room === undefined || (room !== SELF_DEV_ROOM && !room.startsWith(`${SELF_DEV_ROOM}-`)) || room.startsWith('ax-ops-')) return 'pass';
          const say = (text: string): Promise<void> => replier.reply(message.conversation, { text });
          if (room !== SELF_DEV_ROOM) {
            await say(busy?.sessions.owns(room) === true ? await busy.sessions.message(room, message.text) : '이 작업은 이미 끝났어요. 더 바꿀 게 있으면 \'ax 개선\' 방에서 말씀해 주세요.');
            return 'handled';
          }
          if (busy !== undefined) {
            if (STOP.test(message.text)) {
              busy.controller.abort(new Error('stopped'));
              await say('멈출게요. 하위 작업도 모두 멈추고, 실행 중인 비서는 바꾸지 않아요.');
            } else if (STATUS.test(message.text)) {
              const lines = busy.sessions.status();
              await say(`'${busy.title}'을(를) 하고 있어요.${lines.length > 0 ? `\n${lines.join('\n')}` : ' 하위 작업 없이 혼자 하고 있어요.'}`);
            } else {
              await say(`지금 '${busy.title}'을(를) 하고 있어요. 끝나면 다음 걸 말씀해 주세요. ('멈춰'로 멈추거나 '상태'로 진행을 볼 수 있어요)`);
            }
            return 'handled';
          }
          if (TIDY.test(message.text)) {
            await say(await tidy(ctx));
            return 'handled';
          }
          // operating the Mac (install, connect, clean up, restart) is a sub-session of its own, not a code change
          if (await isOpsRequest(ctx, message.text)) {
            await say(await startOps(ctx, message.text, GROUP, post));
            return 'handled';
          }
          const blocked = await coderGate(ctx);
          if (blocked !== undefined) {
            await say(blocked);
            return 'handled';
          }
          const coder = opts.coder();
          if (coder === undefined) {
            await say('코드를 고칠 도구가 없어요. 이 맥에 Claude Code(claude)나 Codex를 설치하고 로그인해 주세요. `ax-kit setup`의 AI 연결에서 바로 할 수 있어요.');
            return 'handled';
          }
          const id = `sd-${randomUUID().slice(0, 8)}`;
          const sessions = new ParallelSessions({ gate: (runs) => coderGate(ctx, runs), root: opts.root, workDir: opts.workDir, run: opts.run, kv: ctx.kv, directory: ctx.tryUse(Contracts.bots), post: postIn, coder, checkLock: lock, group: GROUP, lead: id, ...(ctx.tryUse(Contracts.workInProgress) !== undefined ? { board: ctx.tryUse(Contracts.workInProgress) as WorkInProgress } : {}), ...(opts.checks !== undefined ? { checks: opts.checks } : {}) });
          const running: Running = { title: message.text.slice(0, 40), controller: new AbortController(), sessions };
          busy = running;
          await say(`시작했어요 (작업 ${id}). 이 비서의 코드를 따로 떼어 고치고, 검사를 다 통과하면 적용하고 다시 켤게요. 나눠서 동시에 하는 게 빠르면 하위 작업 방을 열어 같이 진행해요. 결과는 여기서 알려 드릴게요. (요청은 한 번에 하나씩 받아요)`);
          void work(ctx, opts, coder, id, message.text, post, running, lock).finally(() => (busy = undefined));
          return 'handled';
        },
      };
      ctx.registerHandler(handler);
    },
  };
}

async function work(ctx: PluginContext, opts: SelfDevOptions, coder: Coder, id: string, request: string, post: (text: string) => void, running: Running, lock: ReturnType<typeof createLock>): Promise<void> {
  const board = ctx.tryUse(Contracts.workInProgress);
  const startedAt = ctx.clock.now().toISOString();
  const item = { id, kind: 'dev' as const, title: `ax 개선: ${request.slice(0, 40)}`, startedAt, origin: { channelId: 'channel.app', address: botAddress(SELF_DEV_ROOM) } };
  await board?.upsert({ ...item, status: 'running', updatedAt: startedAt }).catch(() => undefined);
  const controller = running.controller;
  const timer = ctx.clock.setTimeout(() => controller.abort(new Error('timed out')), JOB_TIMEOUT_MS);
  let outcome: SelfDevOutcome;
  try {
    outcome = await runSelfDev(
      { root: opts.root, workDir: opts.workDir, run: opts.run, coder, progress: post, checkLock: lock, apps: (await opts.apps?.().catch(() => [])) ?? [], parallel: (pieces, base) => running.sessions.start(SELF_DEV_ROOM, request, pieces, base, controller.signal), ...(opts.checks !== undefined ? { checks: opts.checks } : {}) },
      id,
      request,
      controller.signal,
    );
  } catch (error) {
    outcome = { status: 'failed', stage: 'prepare', detail: error instanceof Error ? error.message : String(error), needs: '' };
  } finally {
    ctx.clock.clearTimeout(timer);
  }
  if (controller.signal.aborted && outcome.status !== 'applied') outcome = { status: 'failed', stage: 'code', detail: '멈췄어요.', needs: '' };
  await running.sessions.close(outcome.status === 'applied').catch(() => undefined);
  const done = ctx.clock.now().toISOString();
  await board?.upsert({ ...item, status: outcome.status === 'failed' ? 'failed' : 'done', updatedAt: done, summary: line(outcome).slice(0, 600) }).catch(() => undefined);
  if (outcome.status !== 'applied') {
    post(line(outcome));
    return;
  }
  if (outcome.restart === false) {
    post(line(outcome));
    return;
  }
  if (!opts.managed) {
    post(`${line(outcome)}\n\n이 비서는 로그인 서비스로 돌고 있지 않아서 스스로 다시 켤 수 없어요. ax-kit을 다시 실행하면 적용돼요.`);
    return;
  }
  await ctx.kv.set(PENDING_KEY, { id, request: request.slice(0, 200), commit: outcome.commit, summary: outcome.summary, needs: outcome.needs, installed: outcome.installed });
  post(`${line(outcome)}\n\n새 코드로 다시 켤게요. 켜지면 여기서 알려 드릴게요.`);
  ctx.clock.setTimeout(() => opts.restart(), 3_000);
}

/** Parts that were still open when the process ended (a crash, not an applied restart): their rooms say so. */
async function interrupted(ctx: PluginContext, postIn: (room: string, text: string) => void): Promise<void> {
  const records = (await ctx.kv.get<SessionRecord[]>(SESSIONS_KEY)) ?? [];
  const open = records.filter((record) => record.state === 'running' || record.state === 'idle' || record.state === 'failed');
  if (open.length === 0) return;
  for (const record of open) {
    postIn(record.room, `비서가 다시 켜져서 이 작업은 멈췄어요. 한 일은 브랜치 ${record.branch}에 남아 있을 수 있어요. 필요하면 'ax 개선' 방에서 다시 말씀해 주세요.`);
    await ctx.tryUse(Contracts.bots)?.setStatus(record.room, 'idle', '멈춤').catch(() => undefined);
  }
  await ctx.kv.set(SESSIONS_KEY, records.map((record) => (open.includes(record) ? { ...record, state: 'interrupted' as const } : record)));
}

/** "정리": the finished parts' rooms go away (their work is already merged or left on a branch). */
async function tidy(ctx: PluginContext): Promise<string> {
  const records = (await ctx.kv.get<SessionRecord[]>(SESSIONS_KEY)) ?? [];
  const directory = ctx.tryUse(Contracts.bots);
  for (const record of records) await directory?.remove(record.room).catch(() => false);
  await ctx.kv.delete(SESSIONS_KEY);
  const answer = records.length > 0 ? `하위 작업 방 ${records.length}개를 정리했어요.` : '정리할 하위 작업 방이 없어요.';
  return `${answer} (작업 브랜치는 그대로 둬요)`;
}
