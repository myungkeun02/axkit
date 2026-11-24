import { describe, expect, it } from 'vitest';
import { browserChecks } from '../../../src/connectors/browser/checks.js';
import type { BrowserCheckDeps } from '../../../src/connectors/browser/checks.js';
import { fakeRunner } from './helpers.js';

function deps(overrides: Partial<BrowserCheckDeps> = {}): BrowserCheckDeps {
  return {
    run: fakeRunner({ stdout: '/usr/bin/my-agent\n' }).run,
    resolvePlaywright: async () => true,
    cacheDirs: async () => ['chromium-1234'],
    config: undefined,
    ...overrides,
  };
}

describe('browserChecks', () => {
  it('checks the Playwright package and a Chromium build by default', async () => {
    const checks = await browserChecks(deps());

    expect(checks).toEqual([
      { id: 'browser.playwright', ok: true, detail: 'The playwright package is installed.' },
      { id: 'browser.chromium', ok: true, detail: 'A Chromium build is installed.' },
    ]);
  });

  it('gives install commands when Playwright is missing', async () => {
    const checks = await browserChecks(
      deps({ resolvePlaywright: async () => false, cacheDirs: async () => [] }),
    );

    const playwright = checks.find((check) => check.id === 'browser.playwright');
    const chromium = checks.find((check) => check.id === 'browser.chromium');
    expect(playwright?.ok).toBe(false);
    expect(playwright?.fix).toContain('pnpm add playwright && npx playwright install chromium');
    expect(chromium?.ok).toBe(false);
    expect(chromium?.fix).toBe('npx playwright install chromium');
  });

  it('checks a browser agent CLI with which', async () => {
    const fake = fakeRunner({ stdout: '/usr/local/bin/my-agent\n' });

    const checks = await browserChecks(
      deps({
        run: fake.run,
        config: { adapter: 'cli', cli: { command: 'my-agent' } },
      }),
    );

    expect(checks).toEqual([{ id: 'browser.cli', ok: true, detail: 'Found my-agent.' }]);
    expect(fake.calls[0]?.cmd).toBe('/usr/bin/which');
    expect(fake.calls[0]?.args).toEqual(['my-agent']);
  });

  it('fails the cli check when which exits non-zero', async () => {
    const checks = await browserChecks(
      deps({
        run: fakeRunner({ code: 1 }).run,
        config: { adapter: 'cli', cli: { command: 'missing-agent' } },
      }),
    );

    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.fix).toContain('connector.browser');
  });

  it('falls back to Playwright when the config is invalid', async () => {
    const checks = await browserChecks(deps({ config: { adapter: 'cli' } }));
    expect(checks.map((check) => check.id)).toEqual(['browser.playwright', 'browser.chromium']);
  });

  it('treats a chromium directory entry as installed and ignores other entries', async () => {
    const checks = await browserChecks(deps({ cacheDirs: async () => ['ffmpeg-1010', 'chromium_headless_shell-1234'] }));
    expect(checks.find((check) => check.id === 'browser.chromium')?.ok).toBe(true);
  });
});
