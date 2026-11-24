import { describe, expect, it } from 'vitest';
import type { BacklogReader, BacklogSnapshot } from '../../../src/core/contracts/index.js';
import { backlogCheck, backlogReader } from '../../../src/skills/company/backlog.js';
import { reportTexts } from '../../../src/skills/company/locale-intake.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { KvTaskRepository } from '../../../src/skills/company/store.js';
import { companyConfig, DAY_MS, HOUR_MS, NOW, task } from './helpers.js';

const TEXTS = reportTexts('ko');

async function repoWith(tasks: ReturnType<typeof task>[]): Promise<KvTaskRepository> {
  const kv = new MapKeyValueStore();
  await kv.set('tasks', tasks);
  return new KvTaskRepository(kv, () => NOW);
}

function readerOf(snapshot: BacklogSnapshot): BacklogReader {
  return { async snapshot() { return snapshot; } };
}

const OK_SNAPSHOT: BacklogSnapshot = {
  open: 1,
  stale: 0,
  createdInWeek: 4,
  doneInWeek: 4,
  autoClosedInWeek: 0,
  openLimit: 6,
};

describe('backlogReader', () => {
  it('counts open, stale, weekly makes and shipments, and auto-closes', async () => {
    const at = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();
    const repo = await repoWith([
      task({ id: 'aaaaaaaa', status: 'queued', createdAt: at(40 * HOUR_MS), updatedAt: at(40 * HOUR_MS) }),
      task({ id: 'bbbbbbbb', status: 'awaiting_accept', createdAt: at(HOUR_MS), updatedAt: at(HOUR_MS) }),
      task({ id: 'cccccccc', status: 'done', createdAt: at(2 * DAY_MS), updatedAt: at(DAY_MS), finishedAt: at(DAY_MS) }),
      task({
        id: 'dddddddd',
        status: 'closed',
        closedReason: 'stale',
        createdAt: at(3 * DAY_MS),
        updatedAt: at(2 * DAY_MS),
        finishedAt: at(2 * DAY_MS),
      }),
      task({
        id: 'eeeeeeee',
        status: 'closed',
        closedReason: 'declined',
        createdAt: at(3 * DAY_MS),
        updatedAt: at(2 * DAY_MS),
        finishedAt: at(2 * DAY_MS),
      }),
      task({
        id: 'ffffffff',
        status: 'done',
        createdAt: at(10 * DAY_MS),
        updatedAt: at(8 * DAY_MS),
        finishedAt: at(8 * DAY_MS),
      }),
    ]);
    const reader = backlogReader(repo, async () => companyConfig().limits);

    expect(await reader.snapshot(NOW)).toEqual({
      open: 2,
      stale: 1,
      createdInWeek: 5,
      doneInWeek: 1,
      autoClosedInWeek: 1,
      openLimit: 6,
    });
  });

  it('uses the effective open limit supplied at run time', async () => {
    const repo = await repoWith([]);
    const reader = backlogReader(repo, async () => ({ ...companyConfig().limits, maxOpen: 3 }));

    expect((await reader.snapshot(NOW)).openLimit).toBe(3);
  });
});

describe('backlogCheck', () => {
  it('is ok when the backlog is small, fresh and shipping', async () => {
    const findings = await backlogCheck(readerOf(OK_SNAPSHOT), TEXTS).run(NOW);

    expect(findings).toEqual([
      { id: 'company.backlog', area: 'backlog', ok: true, line: TEXTS.backlogLine(OK_SNAPSHOT) },
    ]);
  });

  it('is not ok at the open cap', async () => {
    const [finding] = await backlogCheck(readerOf({ ...OK_SNAPSHOT, open: 6 }), TEXTS).run(NOW);

    expect(finding?.ok).toBe(false);
  });

  it('is not ok when anything is stale', async () => {
    const [finding] = await backlogCheck(readerOf({ ...OK_SNAPSHOT, stale: 1 }), TEXTS).run(NOW);

    expect(finding?.ok).toBe(false);
  });

  it('is not ok when made work is not shipped at half rate', async () => {
    const [finding] = await backlogCheck(
      readerOf({ ...OK_SNAPSHOT, createdInWeek: 5, doneInWeek: 2 }),
      TEXTS,
    ).run(NOW);

    expect(finding?.ok).toBe(false);
  });

  it('is ok when five or more items were made and at least half shipped', async () => {
    const [finding] = await backlogCheck(
      readerOf({ ...OK_SNAPSHOT, createdInWeek: 6, doneInWeek: 3 }),
      TEXTS,
    ).run(NOW);

    expect(finding?.ok).toBe(true);
  });
});
