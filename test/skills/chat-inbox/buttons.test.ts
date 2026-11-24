import { describe, expect, it } from 'vitest';
import type { Suggestion } from '../../../src/skills/chat-inbox/store.js';
import { ScriptedLlm } from '../../support/context.js';
import { collectFeedback, emitPreview, press, preview, setup, NOW } from './helpers.js';
import type { SetupOptions } from './helpers.js';

const ANSWER = JSON.stringify({
  found: true,
  title: '강남역 약속',
  date: { kind: 'offset', days: 1 },
  time: { hour: 3, minute: 0, meridiem: 'pm' },
  evidence: '내일 3시에 강남역',
});

async function suggest(options: SetupOptions = {}) {
  const llm = new ScriptedLlm([ANSWER]);
  const context = await setup({ ...options, llm });
  await emitPreview(context, preview({ text: '내일 3시에 강남역', ref: 'appt-1' }));
  await context.scheduler.run('chat-inbox.appointments', NOW);
  const suggestions = await context.kv.get<Suggestion[]>('suggestions');
  const suggestion = suggestions?.[0];
  if (suggestion === undefined) throw new Error('no suggestion was stored');
  return { context, suggestion };
}

describe('chat-inbox buttons', () => {
  it('adds the event through calendar.add_event with the chat line as grounding', async () => {
    const { context, suggestion } = await suggest();
    const feedback = collectFeedback(context);

    const { result, replies } = await press(context, `(choice: chat-inbox.appt.add:${suggestion.id})`);

    expect(result).toBe('handled');
    expect(context.calendar.calls).toHaveLength(1);
    const call = context.calendar.calls[0]!;
    expect(call.input).toMatchObject({
      title: '강남역 약속',
      date: { kind: 'offset', days: 1 },
      time: { hour: 3, minute: 0, meridiem: 'pm' },
      evidence: '내일 3시에 강남역',
    });
    expect(call.grounding).toEqual(['내일 3시에 강남역']);
    expect(feedback[0]).toMatchObject({
      domain: 'chat.appointment',
      subject: '민수',
      verdict: 'accepted',
      label: '민수',
    });
    expect(replies[0]).toContain('일정에 넣었어요');
    expect(await context.kv.get<unknown[]>('suggestions')).toEqual([]);
  });

  it('refuses a relative date once the day has changed', async () => {
    const { context, suggestion } = await suggest();
    await context.clock.advance(24 * 3_600_000);

    const { replies } = await press(context, `(choice: chat-inbox.appt.add:${suggestion.id})`);

    expect(context.calendar.calls).toHaveLength(0);
    expect(replies[0]).toContain('날짜가 바뀌었어요');
  });

  it('records a rejection when the owner says no', async () => {
    const { context, suggestion } = await suggest();
    const feedback = collectFeedback(context);

    const { result, replies } = await press(context, `(choice: chat-inbox.appt.no:${suggestion.id})`);

    expect(result).toBe('handled');
    expect(context.calendar.calls).toHaveLength(0);
    expect(feedback[0]).toMatchObject({ domain: 'chat.appointment', verdict: 'rejected' });
    expect(replies[0]).toContain('일정에 넣지 않을게요');
    expect(await context.kv.get<unknown[]>('suggestions')).toEqual([]);
  });

  it('says the calendar is not connected when the tool is missing', async () => {
    const { context, suggestion } = await suggest({ calendar: false });

    const { result, replies } = await press(context, `(choice: chat-inbox.appt.add:${suggestion.id})`);

    expect(result).toBe('handled');
    expect(replies[0]).toContain('캘린더가 연결되어 있지 않아요');
    expect(await context.kv.get<unknown[]>('suggestions')).toEqual([]);
  });

  it('mutes the reply digest through core.notice-mute and records feedback', async () => {
    const context = await setup();
    const feedback = collectFeedback(context);

    const { result, replies } = await press(context, '(choice: chat-inbox.mute:replies)');

    expect(result).toBe('handled');
    expect(context.muter.kinds.has('chat.replies')).toBe(true);
    expect(feedback[0]).toMatchObject({ domain: 'notice', subject: 'chat.replies', verdict: 'rejected' });
    expect(replies[0]).toContain('더 보내지 않을게요');
  });

  it('removes a pending room when the owner says it was answered', async () => {
    const context = await setup();
    await emitPreview(context, preview({ room: '민수' }));

    const { result, replies } = await press(context, '(choice: chat-inbox.done:kakao:민수)');

    expect(result).toBe('handled');
    expect(replies[0]).toContain('민수에 답한 걸로 할게요');
    expect(await context.kv.get<unknown[]>('pending')).toEqual([]);
  });

  it('answers an unknown id and ignores a non-owner press', async () => {
    const context = await setup();

    const unknown = await press(context, '(choice: chat-inbox.appt.add:missing)');
    expect(unknown.result).toBe('handled');
    expect(unknown.replies[0]).toContain('이미 처리했거나 오래된 버튼이에요');

    const stranger = await press(context, '(choice: chat-inbox.mute:replies)', false);
    expect(stranger.result).toBe('pass');
    expect(stranger.replies).toHaveLength(0);
    expect(context.muter.kinds.size).toBe(0);
  });
});
