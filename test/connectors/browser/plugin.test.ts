import { describe, expect, it } from 'vitest';
import { CliBrowserAgent } from '../../../src/connectors/browser/cli-agent.js';
import { browserConnector } from '../../../src/connectors/browser/plugin.js';
import { PlaywrightAgent } from '../../../src/connectors/browser/playwright-agent.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { BrowserAgent } from '../../../src/core/contracts/index.js';
import { createTestContext } from '../../support/context.js';
import { fakeRunner } from './helpers.js';

async function capabilityFor(
  options: Parameters<typeof browserConnector>[0],
  config: Record<string, unknown>,
): Promise<BrowserAgent> {
  const context = createTestContext({ config });
  await browserConnector(options).setup(context.ctx);
  const capability = context.provided.get(Contracts.browser.id);
  if (capability === undefined) throw new Error('browser capability was not provided');
  return capability as BrowserAgent;
}

describe('browserConnector', () => {
  it('provides Playwright by default', async () => {
    const agent = await capabilityFor({}, {});
    expect(agent).toBeInstanceOf(PlaywrightAgent);
    expect(agent.label).toBe('Playwright');
  });

  it('provides a browser agent CLI when configured', async () => {
    const fake = fakeRunner({ stdout: 'RESULT: ok' });

    const agent = await capabilityFor(
      { run: fake.run },
      { adapter: 'cli', cli: { command: 'my-agent', timeoutSeconds: 120 } },
    );

    expect(agent).toBeInstanceOf(CliBrowserAgent);
    expect(agent.label).toBe('my-agent');
    await agent.read('https://example.com/');
    expect(fake.calls[0]?.cmd).toBe('my-agent');
    expect(fake.calls[0]?.opts.timeoutMs).toBe(120_000);
  });
});
