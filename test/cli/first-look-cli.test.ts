import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FirstLookResult } from '../../src/skills/assistant/first-look.js';
import type { ActionAnswer, FirstLookView, LocalApi } from '../../src/cli/first-look-api.js';
import { localApi } from '../../src/cli/first-look-api.js';
import type { FirstLookCliDeps } from '../../src/cli/first-look-cli.js';
import { followFirstLook, watchFirstLook } from '../../src/cli/first-look-cli.js';
import { progressLines } from '../../src/cli/first-look-render.js';
import { onboardingCommand } from '../../src/cli/onboarding-cmd.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';

const START = Date.parse('2026-11-23T00:00:00.000Z');

function running(percent: number, files: [number, number], sessions: [number, number]): FirstLookView {
  return {
    status: 'running',
    phase: files[0] < files[1] ? 'local' : 'projects',
    phases: [
      { id: 'local', label: '파일', done: files[0], total: files[1], state: files[0] < files[1] ? 'active' : 'done' },
      { id: 'projects', label: '대화 기록', done: sessions[0], total: sessions[1], state: files[0] < files[1] ? 'waiting' : 'active' },
    ],
    counts: { files: files[0] },
    percent,
    startedAt: '2026-11-23T00:00:00.000Z',
  };
}

const RESULT: FirstLookResult = {
  about: '개발자 겸 운영자. ACME를 운영해요',
  companies: [
    {
      name: 'ACME',
      relation: 'own',
      projects: [
        { name: 'BetaLab', purpose: '', team: { kind: 'dev', roles: [{ title: '개발', does: '' }] }, routines: [] },
        { name: 'clipper', purpose: '', team: { kind: 'general', roles: [] }, routines: [{ title: '감사 점검', when: '매주 월 09:00', schedule: { kind: 'weekly', day: 'mon', at: '09:00' } }] },
      ],
    },
  ],
  plan: { id: 'p1', status: 'proposed' },
};
const REVISED: FirstLookResult = {
  ...RESULT,
  companies: [{ name: 'BetaLab', relation: 'own', projects: [RESULT.companies[0]!.projects[0]!, RESULT.companies[0]!.projects[1]!] }],
};
const DONE: FirstLookView = { ...running(100, [400, 400], [40, 40]), status: 'done', phase: 'done', finishedAt: '2026-11-23T00:05:00.000Z', result: RESULT };

function fakeApi(views: FirstLookView[]) {
  const actions: { view: string; action: string; body?: Record<string, unknown> }[] = [];
  const api: LocalApi = {
    async view() {
      return views.length > 1 ? views.shift() : views[0];
    },
    async act(view, action, body): Promise<ActionAnswer> {
      actions.push({ view, action, ...(body !== undefined ? { body } : {}) });
      if (action === 'revise') return { ok: true, data: { text: '이렇게 바꿨어요: BetaLab → BetaLab (따로 나눔), clipper → BetaLab 아래로.', result: REVISED } };
      if (action === 'apply') return { ok: true, data: { teams: 2, routines: 1 } };
      return { ok: true, data: {} };
    },
  };
  return { api, actions };
}

function deps(views: FirstLookView[], answers: string[], tty = false) {
  const prompter = createScriptedPrompter(answers);
  const written: string[] = [];
  let clock = START + 30_000;
  const { api, actions } = fakeApi(views);
  const cli: FirstLookCliDeps = {
    prompter,
    api,
    out: { tty, write: (text) => void written.push(text), columns: () => 80 },
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    onInterrupt: () => () => undefined,
  };
  return { cli, prompter, written, actions };
}

describe('first look in the terminal', () => {
  it('shows the bar until done, then the result, takes a correction in words and builds it', async () => {
    const { cli, prompter, written, actions } = deps([running(30, [120, 400], [0, 40]), running(70, [400, 400], [12, 40]), DONE], ['말로 고치기', 'ACME랑 BetaLab은 따로야. clipper은 BetaLab 아래', '이대로 만들기']);
    expect(await followFirstLook(cli, { start: true })).toBe('built');
    expect(written).toEqual([
      '처음 알아보기 30% · 파일 읽는 중 · 파일 120/400 · 대화 기록 0/40 · 30초\n',
      '처음 알아보기 70% · 대화 기록 읽는 중 · 파일 400/400 · 대화 기록 12/40 · 31초\n',
      '처음 알아보기 100% · 끝 · 파일 400/400 · 대화 기록 40/40 · 5분 0초\n',
    ]);
    const said = prompter.said.join('\n');
    expect(said).toContain('당신은 이런 사람이군요: 개발자 겸 운영자. ACME를 운영해요');
    expect(said).toContain('이런 조직 분류가 필요해 보여요:\n■ ACME (내 사업)\n  · BetaLab — 개발팀: 개발\n  · clipper — 팀\n      ↻ 매주 월 09:00 감사 점검');
    expect(said).toContain('이렇게 바꿨어요: BetaLab → BetaLab (따로 나눔), clipper → BetaLab 아래로.\n\n■ BetaLab (내 사업)');
    expect(said).toContain('팀 2개와 루틴 1개를 만들었어요.');
    expect(actions).toEqual([
      { view: 'first-look', action: 'revise', body: { text: 'ACME랑 BetaLab은 따로야. clipper은 BetaLab 아래' } },
      { view: 'team-plan', action: 'apply' },
    ]);
    expect(prompter.remaining()).toBe(0);
  });

  it('starts an idle first look, and offers the background when it will take long', async () => {
    const idle: FirstLookView = { ...running(0, [0, 0], [0, 0]), status: 'idle', startedAt: null };
    const { cli, prompter, actions } = deps([idle, running(5, [20, 400], [0, 0])], ['백그라운드로 두고 끝내기']);
    const watched = await watchFirstLook(cli, { start: true });
    expect(watched.end).toBe('background');
    expect(actions[0]).toEqual({ view: 'first-look', action: 'start' });
    expect(prompter.said.at(-1)).toContain('ax-kit onboarding status');
  });

  it('draws three lines in place on a terminal', async () => {
    const { cli, written } = deps([running(42, [168, 400], [0, 40]), DONE], ['앱에서 나중에'], true);
    expect(await followFirstLook(cli, { start: false })).toBe('later');
    expect(written[0]).toContain('█');
    expect(written[0]?.split('\n')).toHaveLength(4);
    expect(written[1]?.startsWith('\u001b[3A')).toBe(true);
    const lines = progressLines(running(42, [168, 400], [0, 40]), { width: 60, nowMs: START + 192_000 });
    expect(lines[0]).toBe('처음 알아보기 · 파일 읽는 중');
    expect(lines[1]).toMatch(/^ {2}█+░+ {2}42% · 3분 12초$/);
    expect(lines[2]).toBe('  파일 168/400 · 대화 기록 0/40');
  });

  it('`ax-kit onboarding status` on a pipe prints plain lines and the result', async () => {
    const { cli, prompter } = deps([DONE], []);
    expect(await onboardingCommand('status', { home: '/nowhere', firstLook: cli })).toBe(0);
    expect(prompter.said[0]).toBe('처음 알아보기 100% · 끝 · 파일 400/400 · 대화 기록 40/40 · 5분 0초');
    expect(prompter.said).toContain('■ ACME (내 사업)');
    expect(prompter.said.at(-1)).toBe('고치거나 만들려면: ax-kit onboarding review');
  });

  it('says when the assistant is not reachable', async () => {
    const { cli, prompter } = deps([], []);
    const empty: LocalApi = { view: async () => undefined, act: async () => ({ ok: false }) };
    expect(await onboardingCommand('review', { home: '/nowhere', firstLook: { ...cli, api: empty } })).toBe(1);
    expect(prompter.said.at(-1)).toContain('비서에 연결하지 못했어요');
  });
});

describe('local API client', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ax-fl-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('reads views/first-look and posts actions with the local token', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      if (url.endsWith('/revise')) return new Response(JSON.stringify({ ok: false, error: 'shape', message: '고칠 팀 구조 제안이 없어요.' }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, view: 'first-look', version: 1, data: DONE }), { status: 200 });
    }) as typeof fetch;
    const api = localApi(home, fake);
    expect(await api.view()).toBeUndefined();
    await writeFile(join(home, 'desktop.token'), JSON.stringify({ v: 1, baseUrl: 'http://127.0.0.1:47617', token: 'tok', issuedAt: '' }));
    expect((await api.view())?.status).toBe('done');
    expect(calls[0]?.url).toBe('http://127.0.0.1:47617/m/v1/app/views/first-look');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(await api.act('first-look', 'revise', { text: 'x' })).toEqual({ ok: false, message: '고칠 팀 구조 제안이 없어요.' });
    expect(calls[1]?.init?.method).toBe('POST');
  });
});
