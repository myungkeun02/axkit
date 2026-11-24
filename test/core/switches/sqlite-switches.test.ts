import { describe, expect, it } from 'vitest';
import { openSqliteStore } from '../../../src/core/store/sqlite.js';
import { SWITCH_MIGRATIONS, SqliteSwitches } from '../../../src/core/switches/sqlite-switches.js';
import { FakeClock } from '../helpers.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const START = new Date('2026-11-17T09:00:00+09:00');

async function make() {
  const store = openSqliteStore(':memory:');
  expect(await store.migrate(SWITCH_MIGRATIONS)).toEqual(['core/003-switches']);
  const clock = new FakeClock(START);
  const switches = new SqliteSwitches(store.sql, () => clock.now());
  return { store, clock, switches };
}

function pauseInput(until: Date, reason = '메일 서버 점검') {
  return { reason, until, by: { kind: 'user' as const, id: 'owner' } };
}

describe('SqliteSwitches', () => {
  it('stores a pause with its reason, owner and end', async () => {
    const { switches, clock } = await make();
    const state = await switches.pause('skill.mail', pauseInput(new Date(START.getTime() + 2 * HOUR_MS), '  메일 서버 점검  '));

    expect(state).toEqual({
      feature: 'skill.mail',
      reason: '메일 서버 점검',
      until: new Date(START.getTime() + 2 * HOUR_MS).toISOString(),
      byKind: 'user',
      by: 'owner',
      createdAt: clock.now().toISOString(),
      auto: false,
    });
    expect(await switches.pausedState('skill.mail')).toEqual(state);
  });

  it('requires a reason, a future end within 30 days and a valid feature name', async () => {
    const { switches } = await make();
    const now = START.getTime();

    await expect(switches.pause('skill.mail', pauseInput(new Date(now + HOUR_MS), '   '))).rejects.toThrow(
      'Pause reason is required',
    );
    await expect(switches.pause('Skill.Mail', pauseInput(new Date(now + HOUR_MS)))).rejects.toThrow('Invalid feature name');
    await expect(switches.pause('skill.mail', pauseInput(new Date(now)))).rejects.toThrow(
      'Pause end must be in the future',
    );
    await expect(switches.pause('skill.mail', pauseInput(new Date(now + 31 * DAY_MS)))).rejects.toThrow(
      'Pause end must be within 30 days',
    );
    await expect(switches.pause('skill.mail', pauseInput(new Date(now + 30 * DAY_MS)))).resolves.toMatchObject({
      feature: 'skill.mail',
    });
  });

  it('replaces an existing pause', async () => {
    const { switches } = await make();
    const now = START.getTime();
    await switches.pause('skill.mail', pauseInput(new Date(now + HOUR_MS), 'first'));
    const replaced = await switches.pause('skill.mail', pauseInput(new Date(now + 3 * HOUR_MS), 'second'));

    expect(replaced.reason).toBe('second');
    expect(replaced.until).toBe(new Date(now + 3 * HOUR_MS).toISOString());
    expect(await switches.list()).toHaveLength(1);
  });

  it('marks breaker pauses as automatic policy decisions', async () => {
    const { switches, clock } = await make();
    const state = await switches.pauseAuto('connector.gmail', 'timeout x5', new Date(START.getTime() + HOUR_MS));

    expect(state).toMatchObject({
      feature: 'connector.gmail',
      reason: 'timeout x5',
      auto: true,
      byKind: 'policy',
      by: 'breaker',
    });
    await expect(switches.pauseAuto('connector.gmail', 'x', clock.now())).rejects.toThrow(
      'Pause end must be in the future',
    );
    await expect(switches.pauseAuto('Bad', 'x', new Date(START.getTime() + HOUR_MS))).rejects.toThrow(
      'Invalid feature name',
    );
  });

  it('drops an expired pause when asked and from list()', async () => {
    const { switches, clock, store } = await make();
    const now = START.getTime();
    await switches.pause('skill.mail', pauseInput(new Date(now + HOUR_MS)));

    await clock.advance(HOUR_MS + 1);
    expect(await switches.pausedState('skill.mail')).toBeUndefined();
    const row = store.sql.get('SELECT COUNT(*) AS count FROM feature_pauses');
    expect(Number(row?.count)).toBe(0);
  });

  it('lists active pauses sorted by end, pruning expired ones', async () => {
    const { switches, clock } = await make();
    const now = START.getTime();
    await switches.pause('feature.late', pauseInput(new Date(now + 10 * HOUR_MS)));
    await switches.pause('feature.soon', pauseInput(new Date(now + 2 * HOUR_MS)));

    expect((await switches.list()).map((state) => state.feature)).toEqual(['feature.soon', 'feature.late']);

    await clock.advance(3 * HOUR_MS);
    expect((await switches.list()).map((state) => state.feature)).toEqual(['feature.late']);
  });

  it('resumes by deleting the pause', async () => {
    const { switches } = await make();
    await switches.pause('skill.mail', pauseInput(new Date(START.getTime() + HOUR_MS)));
    await switches.resume('skill.mail');

    expect(await switches.pausedState('skill.mail')).toBeUndefined();
    expect(await switches.list()).toEqual([]);
  });
});
