import { describe, expect, it } from 'vitest';
import { DiscordConfirmer } from '../../../src/channels/discord/confirm.js';
import { confirmTexts } from '../../../src/channels/discord/locale.js';
import { flush } from '../../core/helpers.js';
import { FakeDiscordPort } from './fake-port.js';

function timerHarness() {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    timers,
    setTimer(fn: () => void): unknown {
      next += 1;
      timers.set(next, fn);
      return next;
    },
    clearTimer(handle: unknown): void {
      if (typeof handle === 'number') timers.delete(handle);
    },
    async fire(): Promise<void> {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
      await flush();
      await flush();
    },
  };
}

async function settle(): Promise<void> {
  await flush();
  await flush();
  await flush();
}

function makeConfirmer(port: FakeDiscordPort) {
  const timers = timerHarness();
  const confirmer = new DiscordConfirmer({
    port,
    ownerUserId: 'owner-1',
    expiresMs: 60_000,
    texts: confirmTexts('ko'),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    newId: () => 'abc',
  });
  return { confirmer, timers };
}

const request = { summary: '메일을 보냅니다', effects: ['send'] as const, toolName: 'mail.send' };

async function press(
  confirmer: DiscordConfirmer,
  customId: string,
  userId: string,
): Promise<{ handled: boolean; acks: number }> {
  let acks = 0;
  const handled = await confirmer.handleButton({
    customId,
    userId,
    channelId: 'dm-owner-1',
    messageId: 'msg-1',
    ack: async () => {
      acks += 1;
    },
  });
  return { handled, acks };
}

describe('DiscordConfirmer', () => {
  it('approves when the owner presses the approve button', async () => {
    const port = new FakeDiscordPort();
    const { confirmer, timers } = makeConfirmer(port);
    const answer = confirmer.confirm({ ...request, effects: [...request.effects] });
    await settle();

    expect(port.dms).toEqual(['owner-1']);
    const buttons = port.sent[0]?.payload.buttons ?? [];
    expect(buttons.map((button) => button.label)).toEqual(['승인', '거절']);

    const result = await press(confirmer, buttons[0]?.customId ?? '', 'owner-1');
    expect(result).toEqual({ handled: true, acks: 1 });
    await expect(answer).resolves.toBe('approved');
    expect(port.edits[0]?.note).toBe('승인했어요.');
    expect(timers.timers.size).toBe(0);
  });

  it('denies when the owner presses the deny button', async () => {
    const port = new FakeDiscordPort();
    const { confirmer } = makeConfirmer(port);
    const answer = confirmer.confirm({ ...request, effects: [...request.effects] });
    await settle();

    const buttons = port.sent[0]?.payload.buttons ?? [];
    await press(confirmer, buttons[1]?.customId ?? '', 'owner-1');
    await expect(answer).resolves.toBe('denied');
    expect(port.edits[0]?.note).toBe('거절했어요.');
  });

  it('acknowledges but ignores presses from anyone but the owner', async () => {
    const port = new FakeDiscordPort();
    const { confirmer } = makeConfirmer(port);
    let settled = false;
    const answer = confirmer.confirm({ ...request, effects: [...request.effects] });
    void answer.then(() => {
      settled = true;
    });
    await settle();

    const customId = port.sent[0]?.payload.buttons?.[0]?.customId ?? '';
    const stranger = await press(confirmer, customId, 'someone-else');
    expect(stranger).toEqual({ handled: true, acks: 1 });
    await settle();
    expect(settled).toBe(false);
    expect(port.edits).toHaveLength(0);

    await press(confirmer, customId, 'owner-1');
    await expect(answer).resolves.toBe('approved');
  });

  it('expires after the deadline and removes the buttons', async () => {
    const port = new FakeDiscordPort();
    const { confirmer, timers } = makeConfirmer(port);
    const answer = confirmer.confirm({ ...request, effects: [...request.effects] });
    await settle();

    await timers.fire();
    await expect(answer).resolves.toBe('expired');
    expect(port.edits[0]?.note).toBe('시간이 지나 취소됐어요.');
    expect(timers.timers.size).toBe(0);
  });

  it('is one-time: later presses are acknowledged and ignored', async () => {
    const port = new FakeDiscordPort();
    const { confirmer } = makeConfirmer(port);
    const answer = confirmer.confirm({ ...request, effects: [...request.effects] });
    await settle();

    const customId = port.sent[0]?.payload.buttons?.[0]?.customId ?? '';
    await press(confirmer, customId, 'owner-1');
    await expect(answer).resolves.toBe('approved');

    const again = await press(confirmer, customId, 'owner-1');
    expect(again).toEqual({ handled: true, acks: 1 });
    expect(port.edits).toHaveLength(1);
  });

  it('shows the why-note on its own line and omits it when absent', async () => {
    const port = new FakeDiscordPort();
    const { confirmer } = makeConfirmer(port);
    const withNote = confirmer.confirm({
      summary: '내일 오후 3시에 일정을 만듭니다',
      effects: ['write'],
      toolName: 'calendar.create',
      note: '날짜를 추측했어요',
    });
    await settle();

    const content = port.sent[0]?.payload.content ?? '';
    expect(content.split('\n').at(-1)).toBe('확인이 필요한 이유: 날짜를 추측했어요');
    await press(confirmer, port.sent[0]?.payload.buttons?.[0]?.customId ?? '', 'owner-1');
    await expect(withNote).resolves.toBe('approved');

    const withoutNote = confirmer.confirm({ summary: '할 일을 추가합니다', effects: ['write'], toolName: 'todo.add' });
    await settle();
    expect(port.sent[1]?.payload.content).not.toContain('확인이 필요한 이유');
    await press(confirmer, port.sent[1]?.payload.buttons?.[1]?.customId ?? '', 'owner-1');
    await expect(withoutNote).resolves.toBe('denied');
  });

  it('ignores unknown confirm ids and non-confirm buttons', async () => {
    const port = new FakeDiscordPort();
    const { confirmer } = makeConfirmer(port);

    const stale = await press(confirmer, 'confirm:missing:yes', 'owner-1');
    expect(stale).toEqual({ handled: true, acks: 1 });

    const choice = await press(confirmer, 'choice:next', 'owner-1');
    expect(choice).toEqual({ handled: false, acks: 0 });
    expect(port.edits).toHaveLength(0);
  });
});
