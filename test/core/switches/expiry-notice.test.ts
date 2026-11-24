import { describe, expect, it } from 'vitest';
import type { Notice, NoticeResult, Notifier } from '../../../src/core/contracts/notify.js';
import type { FeatureSwitches, PauseState } from '../../../src/core/contracts/switches.js';
import { pauseExpiryJob } from '../../../src/core/switches/expiry-notice.js';

const HOUR_MS = 3_600_000;
const NOW = new Date('2026-11-17T09:00:00.000Z');

class FakeSwitches implements FeatureSwitches {
  constructor(private readonly states: PauseState[]) {}
  async pause(): Promise<PauseState> {
    throw new Error('unused');
  }
  async resume(): Promise<void> {}
  async pausedState(feature: string): Promise<PauseState | undefined> {
    return this.states.find((state) => state.feature === feature);
  }
  async list(): Promise<PauseState[]> {
    return this.states;
  }
}

class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

function state(feature: string, untilMs: number): PauseState {
  return {
    feature,
    reason: '메일 서버 점검',
    until: new Date(untilMs).toISOString(),
    byKind: 'user',
    by: 'owner',
    createdAt: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    auto: false,
  };
}

describe('pauseExpiryJob', () => {
  it('runs daily at 09:00 and reminds about pauses ending within 24 hours', async () => {
    const inTwelve = state('skill.mail', NOW.getTime() + 12 * HOUR_MS);
    const exactlyOneDay = state('skill.calendar', NOW.getTime() + 24 * HOUR_MS);
    const switches = new FakeSwitches([
      state('skill.watch', NOW.getTime() - HOUR_MS),
      inTwelve,
      state('skill.files', NOW.getTime() + 48 * HOUR_MS),
      exactlyOneDay,
    ]);
    const notifier = new RecordingNotifier();
    const job = pauseExpiryJob({
      switches,
      notifier: () => notifier,
      now: () => NOW,
      text: (pause) => `${pause.feature} 일시정지가 곧 끝나요`,
    });

    expect(job.name).toBe('core.pause-expiry');
    expect(job.schedule).toEqual({ kind: 'daily', at: '09:00' });

    await job.run(NOW);

    expect(notifier.notices).toEqual([
      {
        kind: 'core.pause-expiry',
        dedupeKey: `skill.mail:${inTwelve.until}`,
        text: 'skill.mail 일시정지가 곧 끝나요',
      },
      {
        kind: 'core.pause-expiry',
        dedupeKey: `skill.calendar:${exactlyOneDay.until}`,
        text: 'skill.calendar 일시정지가 곧 끝나요',
      },
    ]);
  });

  it('does nothing when no notifier is available', async () => {
    const switches = new FakeSwitches([state('skill.mail', NOW.getTime() + HOUR_MS)]);
    const job = pauseExpiryJob({
      switches,
      notifier: () => undefined,
      now: () => NOW,
      text: (pause) => pause.feature,
    });

    await expect(job.run(NOW)).resolves.toBeUndefined();
  });
});
