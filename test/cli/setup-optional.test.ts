import { describe, expect, it } from 'vitest';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { FEATURES, askOptionalFeatures, GITHUB_TOKEN_SECRET } from '../../src/cli/setup-optional.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';

/** 1-based checklist numbers by plugin id (line-of-work packs are not in the list). */
const n = (id: string): string => String(FEATURES.filter((feature) => feature.pack !== true).findIndex((feature) => feature.ids.includes(id)) + 1);

describe('askOptionalFeatures (ax-kit setup features)', () => {
  it('starts from the defaults: Enter keeps OCR and self-tuning on, after one confirmation each', async () => {
    const prompter = createScriptedPrompter(['', '', '']);
    const plugins = await askOptionalFeatures({ prompter, secrets: new MemorySecretStore() });

    expect(plugins['connector.macos-ocr']).toEqual({ enabled: true });
    expect(plugins['skill.tuning']).toEqual({ enabled: true });
    for (const id of ['connector.kakao-desktop', 'connector.discord-app', 'connector.browser', 'skill.browser', 'skill.errands', 'skill.dev-assist', 'skill.company', 'connector.mac-apps', 'connector.apple-reminders']) {
      expect(plugins[id]).toEqual({ enabled: false });
    }
    expect(plugins['skill.todo']).toBeUndefined();
    // a pack for one line of work (recruiting) is not asked of everyone
    expect(plugins['skill.talent']).toBeUndefined();
    expect(prompter.said.join('\n')).not.toContain('인재 소개 팩');
    expect(prompter.remaining()).toBe(0);
  });

  it('lists a line-of-work pack only once it is on, so it can be turned off', async () => {
    const prompter = createScriptedPrompter(['none']);
    const plugins = await askOptionalFeatures({ prompter, secrets: new MemorySecretStore(), existing: { plugins: { 'skill.talent': { enabled: true } } } as never });
    expect(plugins['skill.talent']).toEqual({ enabled: false });
  });

  it('turns everything off with "none" and shows no notice', async () => {
    const prompter = createScriptedPrompter(['none']);
    const plugins = await askOptionalFeatures({ prompter, secrets: new MemorySecretStore() });
    expect(Object.values(plugins).every((entry) => entry['enabled'] === false)).toBe(true);
    expect(prompter.said.join('\n')).not.toContain('■');
  });

  it('shows the full risk notice before turning a risky reader on, and the owner can still say no', async () => {
    const prompter = createScriptedPrompter([`${n('connector.kakao-desktop')},${n('connector.discord-app')},${n('connector.mac-apps')},${n('connector.apple-reminders')}`, '2', '1', '1', '1']);
    const plugins = await askOptionalFeatures({ prompter, secrets: new MemorySecretStore() });

    expect(plugins['connector.kakao-desktop']).toEqual({ enabled: false });
    expect(plugins['connector.discord-app']).toEqual({ enabled: true });
    expect(plugins['connector.mac-apps']).toEqual({ enabled: true });
    const said = prompter.said.join('\n');
    expect(said).toContain('읽음 표시가 가지 않아요');
    expect(said).toContain('셀프봇이 아니에요');
    expect(said).toContain('정지될 수 있어요');
    expect(said).toContain('비밀번호 칸은 읽지도 입력하지도 않아요');
    expect(said).toContain('미리 알림 접근을 묻는 창');
    expect(prompter.remaining()).toBe(0);
  });

  it('does not ask again about a feature that is on already', async () => {
    const prompter = createScriptedPrompter([n('connector.kakao-desktop')]);
    const plugins = await askOptionalFeatures({
      prompter,
      secrets: new MemorySecretStore(),
      existing: { plugins: { 'connector.kakao-desktop': { enabled: true, extra: 1 } } } as never,
    });
    expect(plugins['connector.kakao-desktop']).toEqual({ enabled: true, extra: 1 });
    expect(prompter.said.join('\n')).not.toContain('■');
    expect(prompter.remaining()).toBe(0);
  });

  it('collects a repository and stores the GitHub token only in the secret store', async () => {
    const secrets = new MemorySecretStore();
    const picks = [n('connector.kakao-desktop'), n('skill.dev-assist'), n('skill.company')].join(',');
    const prompter = createScriptedPrompter([picks, '1', '1', 'example/app', '/Users/me/code/app', '', 'github_pat_example', '1']);
    const plugins = await askOptionalFeatures({ prompter, secrets });

    expect(plugins['connector.kakao-desktop']).toEqual({ enabled: true });
    expect(plugins['skill.dev-assist']).toEqual({
      enabled: true,
      repos: [{ slug: 'example/app', path: '/Users/me/code/app', test: ['pnpm', 'test'] }],
    });
    expect(await secrets.get(GITHUB_TOKEN_SECRET)).toBe('github_pat_example');
    // no ready-made teams: they come from the first look's plan
    expect(plugins['skill.company']).toEqual({ enabled: true });
    expect(JSON.stringify(plugins)).not.toContain('github_pat_example');
    expect(prompter.said.join('\n')).not.toContain('github_pat_example');
    expect(prompter.remaining()).toBe(0);
  });

  it('turns the browser on with the errands, even when the browser alone was left off', async () => {
    const prompter = createScriptedPrompter([n('skill.errands'), '1']);
    const plugins = await askOptionalFeatures({ prompter, secrets: new MemorySecretStore() });
    expect(plugins['skill.errands']).toEqual({ enabled: true });
    expect(plugins['connector.browser']).toEqual({ enabled: true });
    expect(plugins['skill.browser']).toEqual({ enabled: true });
    expect(prompter.said.join('\n')).toContain('10분보다 자주 조회하지 않고');
    expect(prompter.remaining()).toBe(0);
  });

  it('pins the to-do list to Apple Reminders when its sync is turned on, and unpins it when turned off', async () => {
    const on = await askOptionalFeatures({
      prompter: createScriptedPrompter([n('connector.apple-reminders'), '1']),
      secrets: new MemorySecretStore(),
    });
    expect(on['connector.apple-reminders']).toEqual({ enabled: true });
    expect(on['skill.todo']).toEqual({ source: 'apple-reminders' });

    const off = await askOptionalFeatures({
      prompter: createScriptedPrompter(['none']),
      secrets: new MemorySecretStore(),
      existing: {
        plugins: { 'skill.todo': { enabled: true, source: 'apple-reminders' }, 'connector.apple-reminders': { enabled: true } },
      } as never,
    });
    expect(off['connector.apple-reminders']).toEqual({ enabled: false });
    expect(off['skill.todo']).toEqual({ enabled: true });
  });
});
