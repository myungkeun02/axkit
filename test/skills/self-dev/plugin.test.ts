import { describe, expect, it } from 'vitest';
import type { IncomingMessage, OutgoingMessage } from '../../../src/core/conversation/types.js';
import { SELF_DEV_ROOM, selfDevPlugin } from '../../../src/skills/self-dev/plugin.js';
import { createTestContext } from '../../support/context.js';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function setup(coder = true) {
  const context = createTestContext();
  const posted: string[] = [];
  context.bus.on('bots.message', ({ text }) => void posted.push(text));
  const plugin = selfDevPlugin({
    root: '/nonexistent/ax-kit',
    workDir: '/nonexistent/work',
    managed: true,
    restart: () => undefined,
    run: async () => ({ code: 1, stdout: '', stderr: 'not a git repo', timedOut: false }),
    coder: () => (coder ? { write: async () => ({ ok: true, log: '' }) } : undefined),
  });
  return { context, posted, plugin };
}

const message = (address: string, text: string): IncomingMessage => ({
  id: `m-${text}`,
  conversation: { channelId: 'channel.app', address },
  authorId: 'app:d1',
  fromOwner: true,
  text,
  receivedAt: new Date(),
});

describe('the ax 개선 room', () => {
  it('takes requests only in its room, answers at once, and reports where it stopped', async () => {
    const { context, posted, plugin } = setup();
    await plugin.setup(context.ctx);
    const handler = context.handlers[0];
    const replies: OutgoingMessage[] = [];
    const replier = { reply: async (_to: unknown, out: OutgoingMessage) => void replies.push(out) };
    expect(await handler?.handle(message('owner', '안녕'), replier)).toBe('pass');
    expect(await handler?.handle(message(`bot:${SELF_DEV_ROOM}`, '알림 문구를 바꿔줘'), replier)).toBe('handled');
    expect(replies[0]?.text).toContain('시작했어요');
    expect(replies[0]?.text).toMatch(/\(요청은 한 번에 하나씩 받아요\)$/);
    await settle();
    expect(posted.at(-1)).toContain('준비 단계에서 멈췄어요');
  });

  it('says it works alone when asked for "상태" with no parts open', async () => {
    const { context, plugin } = setup();
    await plugin.setup(context.ctx);
    const replies: OutgoingMessage[] = [];
    const replier = { reply: async (_to: unknown, out: OutgoingMessage) => void replies.push(out) };
    await context.handlers[0]?.handle(message(`bot:${SELF_DEV_ROOM}`, '알림 문구를 바꿔줘'), replier);
    await context.handlers[0]?.handle(message(`bot:${SELF_DEV_ROOM}`, '상태'), replier);
    expect(replies[1]?.text).toBe("'알림 문구를 바꿔줘'을(를) 하고 있어요. 하위 작업 없이 혼자 하고 있어요.");
    await settle();
  });

  it('answers in a part’s room after its job ended, and tidies part rooms on "정리"', async () => {
    const { context, plugin } = setup();
    await context.kv.set('sessions', [{ id: 'sd-a', room: 'ax-dev-aaaaaa', title: 'A', parent: 'ax-dev', state: 'closed', branch: 'ax-self/sd-a' }]);
    await plugin.setup(context.ctx);
    const replies: OutgoingMessage[] = [];
    const replier = { reply: async (_to: unknown, out: OutgoingMessage) => void replies.push(out) };
    expect(await context.handlers[0]?.handle(message('bot:ax-dev-aaaaaa', '더 해줘'), replier)).toBe('handled');
    expect(replies[0]?.text).toContain('이미 끝났어요');
    await context.handlers[0]?.handle(message(`bot:${SELF_DEV_ROOM}`, '정리'), replier);
    expect(replies[1]?.text).toContain('1개를 정리했어요');
    expect(replies[1]?.text).toMatch(/ \(작업 브랜치는 그대로 둬요\)$/);
    await context.handlers[0]?.handle(message(`bot:${SELF_DEV_ROOM}`, '정리'), replier);
    expect(replies[2]?.text).toBe('정리할 하위 작업 방이 없어요. (작업 브랜치는 그대로 둬요)');
    expect(await context.kv.get('sessions')).toBeUndefined();
  });

  it('says how to get a coding agent when there is none', async () => {
    const { context, plugin } = setup(false);
    await plugin.setup(context.ctx);
    const replies: OutgoingMessage[] = [];
    await context.handlers[0]?.handle(message(`bot:${SELF_DEV_ROOM}`, '고쳐줘'), { reply: async (_to, out) => void replies.push(out) });
    expect(replies[0]?.text).toContain('Claude Code');
  });

  it('reports in the room after the restart that applied the change', async () => {
    const { context, posted, plugin } = setup();
    await context.kv.set('pending-report', { id: 'sd-1', request: 'x', commit: 'abc1234', summary: '알림을 고쳤어요', needs: '', installed: false });
    await plugin.setup(context.ctx);
    await context.bus.emit('app.started', {} as never);
    await settle();
    expect(posted[0]).toContain('다시 켰어요 ✓ 새 코드(abc1234)');
    expect(await context.kv.get('pending-report')).toBeUndefined();
  });
});
