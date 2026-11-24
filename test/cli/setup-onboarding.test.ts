import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { askOnboarding } from '../../src/cli/setup-onboarding.js';

const HOME = '/Users/me';
const NOW = new Date('2026-11-18T09:00:00+09:00');
const EXISTING = new Set([`${HOME}/Documents`, `${HOME}/Downloads`, `${HOME}/projects`, '/Volumes/work']);
const dirExists = async (path: string): Promise<boolean> => EXISTING.has(path);

describe('askOnboarding', () => {
  it('offers only folders that exist, drops the ones the owner removes and adds typed ones', async () => {
    // now; keep 1 and 3 of the offered folders and type two more; Drive and recent activity as checked
    const prompter = createScriptedPrompter(['1', '1,3,+/Volumes/work,+~/missing', '']);

    const entry = await askOnboarding({ prompter, home: HOME, dirExists, driveConnected: true, now: () => NOW });

    expect(entry).toEqual({
      enabled: true,
      autoStart: true,
      folders: ['~/Documents', '~/projects', '/Volumes/work'],
      projects: [],
      sessions: true,
      depth: 'deep',
      drive: true,
      signals: true,
      consentAt: NOW.toISOString(),
    });
    expect(prompter.said).toContain('어느 폴더를 훑어볼까요?');
    expect(prompter.said).toContain('폴더를 찾지 못해 건너뛸게요: ~/missing');
    expect(prompter.remaining()).toBe(0);
  });

  it('does not ask about Drive when Drive is not connected, and "later" keeps the scan from starting', async () => {
    const prompter = createScriptedPrompter(['2', '', 'none']);

    const entry = await askOnboarding({ prompter, home: HOME, dirExists, driveConnected: false, now: () => NOW });

    expect(entry).toMatchObject({ enabled: true, autoStart: false, drive: false, signals: false });
    expect(entry['folders']).toEqual(['~/Documents', '~/Downloads', '~/projects']);
  });

  it('turns the scan off and keeps earlier settings', async () => {
    const existing = parseConfig({
      version: 1,
      assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
      owner: { discordUserId: '11111111111111111' },
      plugins: { 'skill.onboarding': { enabled: true, folders: ['~/notes'] } },
    });
    const prompter = createScriptedPrompter(['3']);

    const entry = await askOnboarding({ prompter, home: HOME, dirExists, driveConnected: true, existing, now: () => NOW });

    expect(entry).toEqual({ enabled: false, folders: ['~/notes'] });
  });

  it('rejects numbers that are not in the list and typed folders that are not a path', async () => {
    await expect(
      askOnboarding({ prompter: createScriptedPrompter(['1', '9']), home: HOME, dirExists, driveConnected: false, now: () => NOW }),
    ).rejects.toThrow('목록에 있는 번호로');
    await expect(
      askOnboarding({ prompter: createScriptedPrompter(['1', '+relative/path']), home: HOME, dirExists, driveConnected: false, now: () => NOW }),
    ).rejects.toThrow('/ 또는 ~/로 시작하는 경로');
  });

  it('asks about Claude·Codex logs only when projects were picked', async () => {
    const discover = async () => [
      { path: '/Users/me/projects/app', display: '~/projects/app', name: 'app', company: '개인', lastActive: NOW.toISOString(), claude: 3, codex: 0, inFolders: true },
    ];
    // now, folders as offered, the project as checked (all personal: no question about companies), then turn the session logs off
    const prompter = createScriptedPrompter(['1', '', '', '2,3']);
    const entry = await askOnboarding({ prompter, home: HOME, dirExists, driveConnected: true, now: () => NOW, discover });
    expect(entry).toMatchObject({ sessions: false, drive: true, signals: true, projects: [{ path: '/Users/me/projects/app', name: 'app', company: '개인' }] });
    expect(prompter.remaining()).toBe(0);
  });
});
