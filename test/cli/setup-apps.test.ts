import { describe, expect, it } from 'vitest';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import type { AppStepDeps } from '../../src/cli/setup-apps.js';
import { appLinksFromEnv, askApps } from '../../src/cli/setup-apps.js';

function fake(over: Partial<AppStepDeps> = {}): AppStepDeps & { pairs: string[]; funnels: boolean[] } {
  const pairs: string[] = [];
  const funnels: boolean[] = [];
  return {
    pairs,
    funnels,
    pair: async (platform, name) => (pairs.push(`${platform}:${name}`), 0),
    funnel: async (fix) => (funnels.push(fix), 0),
    desktopInstalled: async () => true,
    links: {},
    ...over,
  };
}

describe('askApps', () => {
  it('pairs the picked phone right after it is installed and notes the Mac app', async () => {
    const deps = fake({ links: { ios: 'https://testflight.apple.com/join/abc' } });
    const prompter = createScriptedPrompter(['1,3', '']);
    expect(await askApps(prompter, deps)).toEqual(['this-mac', 'ios']);
    expect(deps.pairs).toEqual(['ios:아이폰']);
    const said = prompter.said.join('\n');
    expect(said).toContain('설치: https://testflight.apple.com/join/abc');
    expect(said).toContain('짝 맞추기 없이 바로');
    expect(said).toContain('연결 코드는 10분 동안 한 번만 쓸 수 있어요. 앱 설정에서도 다시 연결할 수 있어요.');
  });

  it('pairs another Mac with a link and skips a phone the owner did not install', async () => {
    const deps = fake();
    const prompter = createScriptedPrompter(['2,4', '건너뛰기', '']);
    expect(await askApps(prompter, deps)).toEqual(['other-mac']);
    expect(deps.pairs).toEqual(['desktop:다른 맥']);
  });

  it('offers to fix the address first and stops pairing when it stays unreachable', async () => {
    const deps = fake({ funnel: async () => 1 });
    const prompter = createScriptedPrompter(['1', '2']);
    expect(await askApps(prompter, deps)).toEqual([]);
    expect(prompter.said.join('\n')).toContain('ax-kit phone pair --app');
  });

  it('does nothing when no app is picked', async () => {
    const deps = fake();
    const prompter = createScriptedPrompter(['none']);
    expect(await askApps(prompter, deps)).toEqual([]);
    expect(deps.funnels).toEqual([]);
    expect(prompter.said).toContain('앱은 나중에 연결할 수 있어요: ax-kit phone pair --app 데스크톱·휴대폰 앱의 설정에서도 연결할 수 있어요.');
  });
});

describe('appLinksFromEnv', () => {
  it('reads install links when set', () => {
    expect(appLinksFromEnv({ AX_KIT_IOS_INSTALL_URL: ' https://x ', AX_KIT_ANDROID_INSTALL_URL: '' })).toEqual({ ios: 'https://x' });
  });
});
