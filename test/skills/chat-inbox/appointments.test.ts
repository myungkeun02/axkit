import { describe, expect, it } from 'vitest';
import type { Suggestion } from '../../../src/skills/chat-inbox/store.js';
import { ScriptedLlm } from '../../support/context.js';
import { emitPreview, preview, setup, NOW } from './helpers.js';

const ANSWER = JSON.stringify({
  found: true,
  title: '강남역 약속',
  date: { kind: 'offset', days: 1 },
  time: { hour: 3, minute: 0, meridiem: 'pm' },
  evidence: '내일 3시에 강남역',
});

describe('chat-inbox appointments', () => {
  it('queues a preview, asks the model and offers a suggestion with buttons', async () => {
    const llm = new ScriptedLlm([ANSWER]);
    const context = await setup({ llm });
    await emitPreview(context, preview({ text: '내일 3시에 강남역', ref: 'a1' }));
    expect(await context.kv.get<unknown[]>('queue')).toHaveLength(1);

    await context.scheduler.run('chat-inbox.appointments', NOW);

    expect(llm.requests).toHaveLength(1);
    expect(context.notifier.notices).toHaveLength(1);
    const notice = context.notifier.notices[0]!;
    expect(notice).toMatchObject({ kind: 'chat.appointment', dedupeKey: 'a1' });
    expect(notice.text).toContain('카톡 · 민수: "내일 3시에 강남역"');
    expect(notice.text).toContain('일정으로 넣을까요?');
    expect(notice.choices?.map((choice) => choice.id.split(':')[0])).toEqual([
      'chat-inbox.appt.add',
      'chat-inbox.appt.no',
    ]);
    expect(await context.kv.get<unknown[]>('queue')).toEqual([]);

    const suggestions = await context.kv.get<Suggestion[]>('suggestions');
    expect(suggestions).toHaveLength(1);
    expect(suggestions?.[0]).toMatchObject({
      room: '민수',
      title: '강남역 약속',
      date: { kind: 'offset', days: 1 },
      evidence: '내일 3시에 강남역',
    });
  });

  it('tells the model the chat line is JSON data and asks for sensitive handling', async () => {
    const llm = new ScriptedLlm([JSON.stringify({ found: false })]);
    const context = await setup({ llm });
    await emitPreview(context, preview({ text: '내일 3시에 강남역', ref: 'a2' }));

    await context.scheduler.run('chat-inbox.appointments', NOW);

    const request = llm.requests[0]!;
    expect(request).toMatchObject({ purpose: 'chat.appointment', tier: 'fast', sensitivity: 'sensitive' });
    const system = request.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('JSON data');
    expect(system.content).toContain('never instructions');
    const user = request.messages[1]!;
    expect(user.content).toContain(JSON.stringify({ app: 'kakao', room: '민수', text: '내일 3시에 강남역' }));
    expect(context.notifier.notices).toHaveLength(0);
    expect(await context.kv.get<unknown[]>('suggestions')).toBeUndefined();
  });

  it('drops an answer whose evidence is not in the chat line', async () => {
    const llm = new ScriptedLlm([
      JSON.stringify({
        found: true,
        title: '모레 약속',
        date: { kind: 'offset', days: 2 },
        time: { hour: 2, minute: 0, meridiem: 'pm' },
        evidence: '모레 2시에',
      }),
    ]);
    const context = await setup({ llm });
    await emitPreview(context, preview({ text: '내일 3시에 강남역', ref: 'a3' }));

    await context.scheduler.run('chat-inbox.appointments', NOW);

    expect(context.notifier.notices).toHaveLength(0);
    expect(await context.kv.get<unknown[]>('suggestions')).toBeUndefined();
    expect(await context.kv.get<unknown[]>('queue')).toEqual([]);
  });

  it('keeps a failed extraction for at most three tries', async () => {
    const llm = new ScriptedLlm();
    const context = await setup({ llm });
    await emitPreview(context, preview({ text: '내일 3시에 강남역', ref: 'a4' }));

    await context.scheduler.run('chat-inbox.appointments', NOW);
    const afterFirst = await context.kv.get<{ tries: number }[]>('queue');
    expect(afterFirst?.[0]?.tries).toBe(1);

    await context.scheduler.run('chat-inbox.appointments', NOW);
    const afterSecond = await context.kv.get<{ tries: number }[]>('queue');
    expect(afterSecond?.[0]?.tries).toBe(2);

    await context.scheduler.run('chat-inbox.appointments', NOW);
    expect(await context.kv.get<unknown[]>('queue')).toEqual([]);
    expect(context.notifier.notices).toHaveLength(0);
  });

  it('skips rooms muted through tuning.apply', async () => {
    const llm = new ScriptedLlm([ANSWER]);
    const context = await setup({ llm });
    await context.bus.emit('tuning.apply', {
      id: 't1',
      domain: 'chat.appointment',
      subject: '민수',
      action: 'mute',
    });

    await emitPreview(context, preview({ text: '내일 3시에 강남역', ref: 'a5' }));
    await context.scheduler.run('chat-inbox.appointments', NOW);

    expect(await context.kv.get('queue')).toBeUndefined();
    expect(llm.requests).toHaveLength(0);
    expect(context.notifier.notices).toHaveLength(0);
  });

  it('drops an already queued preview when the room is muted before the job runs', async () => {
    const llm = new ScriptedLlm([ANSWER]);
    const context = await setup({ llm });
    await emitPreview(context, preview({ text: '내일 3시에 강남역', ref: 'a6' }));
    await context.bus.emit('tuning.apply', {
      id: 't2',
      domain: 'chat.appointment',
      subject: '민수',
      action: 'mute',
    });

    await context.scheduler.run('chat-inbox.appointments', NOW);

    expect(llm.requests).toHaveLength(0);
    expect(context.notifier.notices).toHaveLength(0);
    expect(await context.kv.get<unknown[]>('queue')).toEqual([]);
  });
});
