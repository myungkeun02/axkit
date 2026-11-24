import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { runSetup } from '../../src/cli/setup.js';
import type { SetupDeps } from '../../src/cli/setup.js';
import { LLM_PRESETS } from '../../src/cli/setup-llm.js';
import { normalizeTime, parseQuiet } from '../../src/cli/setup-schedule.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function deps(answers: string[], over: Partial<SetupDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'axkit-funnel-'));
  directories.push(dir);
  const prompter = createScriptedPrompter(answers);
  const base: SetupDeps = {
    prompter,
    secrets: new MemorySecretStore(),
    configFile: join(dir, 'config.json'),
    detectTimezone: () => 'Asia/Seoul',
    verifyDiscordToken: async () => {
      throw new Error('Discord is not chosen in these tests');
    },
    connectGoogle: async () => {
      throw new Error('Google is skipped in these tests');
    },
    readFile: async () => '{}',
    fileExists: async () => true,
    openUrl: async () => undefined,
    installService: async () => 0,
    ...over,
  };
  return { prompter, deps: base };
}

const ONBOARDING = { home: '/Users/me', dirExists: async (path: string) => path === '/Users/me/Documents', now: () => new Date('2026-11-23T00:00:00Z') };
const claudeCli = String(LLM_PRESETS.findIndex((preset) => preset.id === 'claude-cli') + 1);

describe('setup funnel', () => {
  it('walks seven numbered steps in order, asks no optional feature, and ends with the summary', async () => {
    const { prompter, deps: setup } = await deps(
      [
        '나비', '1', '', // 1/7 비서
        claudeCli, // 2/7 AI: a subscription, so no budget question
        '1', // 3/7 대화할 곳: app
        '2', // 4/7 Google: later
        '', '', // 5/7 briefing 08:00, quiet 23–07 (defaults)
        '1', '', '', // 6/7 first look now, folders as offered, sources as offered
        '', // 7/7 마무리: 이대로 저장
        '1', // service
      ],
      { onboarding: ONBOARDING },
    );
    const config = await runSetup(setup);
    expect(prompter.remaining()).toBe(0);

    const steps = prompter.said.filter((line) => /^\d\/7 · /.test(line));
    expect(steps).toEqual(['1/7 · 비서', '2/7 · AI 연결', '3/7 · 대화할 곳', '4/7 · 메일·캘린더', '5/7 · 알림', '6/7 · 처음 알아보기', '7/7 · 마무리']);

    const said = prompter.said.join('\n');
    expect(said).not.toMatch(/인재 소개|회사 모드|카톡 PC|선택 기능\(/);
    expect(said).not.toContain('받아쓰기를 이 맥에 설치');
    expect(said).not.toContain('하루 얼마까지');
    expect(said).toContain('■ 이렇게 설정했어요');
    expect(said).toMatch(/✔ AI\s+Claude Code 구독/);
    expect(said).toMatch(/○ 메일·캘린더\s+나중에 연결/);
    expect(said).toMatch(/✔ 늘 실행/);
    expect(said).toContain('ax-kit setup features');
    expect(said).toContain('ax-kit connect google');

    expect(config.channel).toBe('app');
    expect(config.assistant.language).toBe('ko');
    expect(config.assistant.timezone).toBe('Asia/Seoul');
    expect(config.plugins['skill.briefing']).toEqual({ enabled: true, at: '08:00' });
    expect(config.plugins['skill.onboarding']).toMatchObject({ enabled: true, autoStart: true, folders: ['~/Documents'], signals: true });
    expect(config.plugins['skill.talent']).toBeUndefined();
    expect(config.plugins['connector.kakao-desktop']).toBeUndefined();
  });

  it('follows the first look in the terminal after the service starts, only when the owner chose "바로 시작"', async () => {
    const answers = ['나비', '1', '', claudeCli, '1', '2', '', '', '1', '', '', '', '1'];
    const followed: string[] = [];
    const { prompter, deps: setup } = await deps(answers, { onboarding: ONBOARDING, followFirstLook: async (shown) => {
      shown.say('probe-line');
      followed.push(prompter.said.includes('probe-line') ? 'same prompter' : 'other');
    } });
    await runSetup(setup);
    expect(followed).toEqual(['same prompter']);
    expect(prompter.said.at(-2)).toBe('비서가 켜졌어요. 처음 알아보기 진행을 여기서 보여 드릴게요.');

    const later = await deps([...answers.slice(0, 8), '2', '', '', '', '1'], { onboarding: ONBOARDING, followFirstLook: async () => void followed.push('later') });
    await runSetup(later.deps);
    expect(followed).toEqual(['same prompter']);
  });

  it('has six steps when the first look is not offered', async () => {
    const { prompter, deps: setup } = await deps(['나비', '1', '', String(LLM_PRESETS.length + 1), '1', '2', '', '', '', '2']);
    const config = await runSetup(setup);
    expect(prompter.remaining()).toBe(0);
    expect(prompter.said.filter((line) => /^\d\/6 · /.test(line))).toHaveLength(6);
    expect(config.llm.providers).toEqual([]);
    expect(prompter.said.join('\n')).toMatch(/○ AI\s+나중에 연결/);
  });

  it('takes typed answers for the budget, the briefing time and the quiet hours', async () => {
    const { prompter, deps: setup } = await deps(['나비', '3', '대표님', '1', 'sk-key', '2.5', '1', '2', '7:30', '22:30-06:30', '', '2']);
    const config = await runSetup(setup);
    expect(prompter.remaining()).toBe(0);
    expect(config.assistant).toMatchObject({ tone: 'casual', ownerName: '대표님', quietHours: { from: '22:30', to: '06:30' } });
    expect(config.llm.budget).toEqual({ dailyUsd: 2.5, monthlyUsd: 50 });
    expect(config.plugins['skill.briefing']).toEqual({ enabled: true, at: '07:30' });
    expect(prompter.said.join('\n')).toContain('하루 $2.5 · 한 달 최대 $50');
  });

  it('rejects a typed budget that is not a sensible number', async () => {
    const { deps: setup } = await deps(['나비', '1', '', '1', 'sk-key', 'lots']);
    await expect(runSetup(setup)).rejects.toThrow('숫자로');
  });

  it('normalises typed times', () => {
    expect(normalizeTime('7:30')).toBe('07:30');
    expect(normalizeTime('0730')).toBe('07:30');
    expect(normalizeTime('25:00')).toBeUndefined();
    expect(parseQuiet('23:00~7:00')).toEqual({ from: '23:00', to: '07:00' });
    expect(parseQuiet('23:00')).toBeUndefined();
  });
});
