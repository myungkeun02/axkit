import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { events, pairApp, startApp } from './harness.js';

describe('app notices carry kind and live', () => {
  it('logs a background browser.task notice with its kind and the take-over handoff', async () => {
    const h = await startApp();
    try {
      const { token } = await pairApp(h);
      const notifier = h.app.host.capability(Contracts.notifier);
      const live = { view: 'browser-live', reason: 'login', url: 'https://example.com/login' } as const;
      expect(
        await notifier?.notify({ kind: 'browser.task', urgent: true, text: "브라우저 심부름 '주문 내역 보기'이 직접 하실 단계에서 멈췄어요.", live }),
      ).toBe('sent');
      expect((await events(h, token)).at(-1)).toMatchObject({ type: 'notice', kind: 'browser.task', live });
    } finally {
      await h.stop();
    }
  });

  it('logs a plain notice without a live field', async () => {
    const h = await startApp();
    try {
      const { token } = await pairApp(h);
      await h.app.host.capability(Contracts.notifier)?.notify({ kind: 'todo.reminder', urgent: true, text: '할 일이 남았어요' });
      const last = (await events(h, token)).at(-1);
      expect(last).toMatchObject({ type: 'notice', kind: 'todo.reminder' });
      expect(last).not.toHaveProperty('live');
    } finally {
      await h.stop();
    }
  });
});
