import { describe, expect, it } from 'vitest';
import type { RunnerInput, RunnerResult } from '../../../src/core/contracts/assistant.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { LlmError } from '../../../src/core/llm/types.js';
import { CLAIM_LEASE_MS, runDueFollowUps } from '../../../src/skills/routines/followups.js';
import { isOutage, runRoutine } from '../../../src/skills/routines/run.js';
import type { RoutineDeps } from '../../../src/skills/routines/run.js';
import { FollowUpStore, RoutineStore } from '../../../src/skills/routines/store.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { createTestContext } from '../../support/context.js';

type Answer = RunnerResult | Error | (() => Promise<RunnerResult>);

function setup(answers: Answer[]) {
  const test = createTestContext({ now: new Date('2026-11-23T09:00:00+09:00') });
  const calls: RunnerInput[] = [];
  const posted: string[] = [];
  test.provided.set(Contracts.assistantRunner.id, {
    run: async (input: RunnerInput): Promise<RunnerResult> => {
      calls.push(input);
      const next = answers.shift() ?? { ok: true, text: '끝났어요.' };
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? await next() : next;
    },
  });
  test.bus.on('bots.message', (event) => void posted.push(event.text));
  const kv = new MapKeyValueStore();
  const deps: RoutineDeps = { ctx: test.ctx, store: new RoutineStore(kv), followUps: new FollowUpStore(kv), korean: true };
  return { test, deps, calls, posted };
}

const DUE = '2026-11-23T08:00:00+09:00';
const item = { id: 'f1', bot: 'dev', what: '빌드 결과 확인', dueAt: new Date(DUE).toISOString(), createdAt: new Date(DUE).toISOString() };
const bot = { id: 'dev', name: '개발 봇' };

describe('bot follow-ups survive failures', () => {
  it('removes a follow-up only after its turn ran and was posted', async () => {
    const s = setup([{ ok: true, text: '빌드가 끝났어요.', bot }]);
    await s.deps.followUps.edit((items) => ({ items: [...items, item], result: undefined }));
    await runDueFollowUps(s.deps);
    expect(s.posted).toEqual(['빌드가 끝났어요.']);
    expect(await s.deps.followUps.all()).toEqual([]);
  });

  it('puts a failed follow-up back with a later due time and runs it again then', async () => {
    const s = setup([new Error('the model is down'), { ok: true, text: '이제 됐어요.', bot }]);
    await s.deps.followUps.edit((items) => ({ items: [...items, item], result: undefined }));
    await runDueFollowUps(s.deps);
    const [kept] = await s.deps.followUps.all();
    expect(kept).toMatchObject({ id: 'f1', attempts: 1 });
    expect(kept?.claimedAt).toBeUndefined();
    expect(Date.parse(kept?.dueAt ?? '')).toBe(s.test.clock.now().getTime() + 10 * 60_000);
    await runDueFollowUps(s.deps);
    expect(s.calls).toHaveLength(1);
    await s.test.clock.advance(10 * 60_000);
    await runDueFollowUps(s.deps);
    expect(s.posted).toEqual(['이제 됐어요.']);
    expect(await s.deps.followUps.all()).toEqual([]);
  });

  it('does not run a claimed follow-up twice, and picks up a claim left by a crash after the lease', async () => {
    let release: (value: RunnerResult) => void = () => undefined;
    const slow = (): Promise<RunnerResult> => new Promise((resolve) => (release = resolve));
    const s = setup([slow]);
    await s.deps.followUps.edit((items) => ({ items: [...items, item], result: undefined }));
    const first = runDueFollowUps(s.deps);
    await new Promise((resolve) => setImmediate(resolve));
    await runDueFollowUps(s.deps);
    expect(s.calls).toHaveLength(1);
    release({ ok: true, text: 'ok', bot });
    await first;

    // a crash: the claim is saved but the process died before the run finished
    const crashed = setup([]);
    const claimedAt = crashed.test.clock.now().toISOString();
    await crashed.deps.followUps.edit((items) => ({ items: [...items, { ...item, claimedAt }], result: undefined }));
    await runDueFollowUps(crashed.deps);
    expect(crashed.calls).toHaveLength(0);
    await crashed.test.clock.advance(CLAIM_LEASE_MS);
    await runDueFollowUps(crashed.deps);
    expect(crashed.calls).toHaveLength(1);
    expect(await crashed.deps.followUps.all()).toEqual([]);
  });
});

describe('routine failure counting', () => {
  async function addRoutine(deps: RoutineDeps): Promise<void> {
    await deps.store.edit((routines) => {
      routines.push({ id: 'r1', title: '날씨', instruction: '날씨 알려 줘', schedule: { kind: 'every', hours: 1 }, enabled: true, createdAt: '' });
    });
  }

  it('does not count AI budget or provider outages toward the three-failure pause', async () => {
    const outages: Answer[] = [
      { ok: false, reason: 'over_budget', text: '예산을 다 썼어요.' },
      { ok: false, reason: 'provider_down', text: '모델이 응답하지 않아요.' },
      new LlmError('over_budget', 'Daily budget reached'),
      new Error('fetch failed: getaddrinfo ENOTFOUND api.example.com'),
    ];
    const s = setup(outages);
    await addRoutine(s.deps);
    for (let i = 0; i < 4; i += 1) await runRoutine(s.deps, 'r1', s.test.clock.now()).catch(() => undefined);
    expect(await s.deps.store.get('r1')).toMatchObject({ enabled: true, lastOk: false });
    expect((await s.deps.store.get('r1'))?.failures ?? 0).toBe(0);
  });

  it('still pauses after three real failures', async () => {
    const s = setup([
      { ok: false, reason: 'invalid_plan', text: 'x' },
      new Error('bug'),
      { ok: false, text: 'y' },
    ]);
    await addRoutine(s.deps);
    for (let i = 0; i < 3; i += 1) await runRoutine(s.deps, 'r1', s.test.clock.now()).catch(() => undefined);
    expect(await s.deps.store.get('r1')).toMatchObject({ enabled: false, failures: 3 });
    expect(isOutage(new Error('bug'))).toBe(false);
  });
});
