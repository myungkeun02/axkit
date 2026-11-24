import { describe, expect, it } from 'vitest';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import type { AsideInstall } from '../../src/cli/setup-google-aside-install.js';
import { installAside } from '../../src/cli/setup-google-aside-install.js';

function fake(state: { app: boolean; cli: boolean; appAfterEnter?: boolean }): AsideInstall & { installs: number; opened: string[] } {
  const out = {
    installs: 0,
    opened: [] as string[],
    appInstalled: async () => state.app,
    runner: () => (state.cli ? async () => ({ ok: true, answer: '' }) : undefined),
    installCli: async () => {
      out.installs += 1;
      state.cli = true;
      return 0;
    },
    openUrl: async (url: string) => {
      out.opened.push(url);
      if (state.appAfterEnter === true) state.app = true;
    },
  };
  return out;
}

describe('installAside', () => {
  it('opens the app site, waits for the owner, then installs the CLI', async () => {
    const deps = fake({ app: false, cli: false, appAfterEnter: true });
    const runner = await installAside(createScriptedPrompter(['', '1']), deps);
    expect(runner).toBeDefined();
    expect(deps.opened).toEqual(['https://aside.com']);
    expect(deps.installs).toBe(1);
  });

  it('gives up on 건너뛰기 and when the owner declines the CLI', async () => {
    expect(await installAside(createScriptedPrompter(['건너뛰기']), fake({ app: false, cli: false }))).toBeUndefined();
    const deps = fake({ app: true, cli: false });
    expect(await installAside(createScriptedPrompter(['2']), deps)).toBeUndefined();
    expect(deps.installs).toBe(0);
  });

  it('is ready at once when both are there', async () => {
    expect(await installAside(createScriptedPrompter([]), fake({ app: true, cli: true }))).toBeDefined();
  });
});
