import { describe, expect, it } from 'vitest';
import { builtinPlugins } from '../../src/app/plugins.js';
import { todoSource } from '../../src/app/plugins-workspace.js';
import { optionalChecks } from '../../src/app/optional-checks.js';
import type { ConfigInput } from '../../src/core/config/schema.js';
import { parseConfig } from '../../src/core/config/load.js';
import { Contracts } from '../../src/core/contracts/index.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import type { ProcessRunner } from '../../src/core/process/types.js';
import type { MacAppsClient } from '../../src/connectors/mac-apps/client.js';
import type { RemindersClient } from '../../src/connectors/apple-reminders/client.js';

function config(plugins: NonNullable<ConfigInput['plugins']> = {}) {
  return parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    owner: { discordUserId: '11111111111111111' },
    plugins,
  });
}

const ids = (cfg: ReturnType<typeof config>): string[] => builtinPlugins(cfg).map((plugin) => plugin.manifest.id);

describe('맥 확장 wiring', () => {
  it('adds neither connector until the owner opts in', () => {
    expect(ids(config())).not.toContain('connector.mac-apps');
    expect(ids(config())).not.toContain('connector.apple-reminders');
  });

  it('adds app control when opted in', () => {
    expect(ids(config({ 'connector.mac-apps': { enabled: true } }))).toContain('connector.mac-apps');
  });

  it('syncs the to-do list with Apple Reminders when its connector is on', () => {
    const cfg = config({ 'connector.apple-reminders': { enabled: true } });
    expect(todoSource(cfg)).toBe('synced');
    expect(ids(cfg)).toContain('connector.apple-reminders');
    const todo = builtinPlugins(cfg).find((plugin) => plugin.manifest.id === 'skill.todo');
    expect(todo?.manifest.needs).toEqual([Contracts.todoSync]);
  });

  it('keeps Google Tasks first unless the owner pinned Apple Reminders', () => {
    const both = { 'connector.apple-reminders': { enabled: true }, 'connector.google-tasks': { enabled: true } };
    expect(todoSource(config(both))).toBe('backend');
    expect(ids(config(both))).not.toContain('connector.apple-reminders');
    const pinned = config({ ...both, 'skill.todo': { enabled: true, source: 'apple-reminders' } });
    expect(todoSource(pinned)).toBe('synced');
    expect(ids(pinned)).not.toContain('connector.google-tasks');
    expect(todoSource(config({ ...both, 'skill.todo': { enabled: true, source: 'local' } }))).toBe('local');
    // A pin to a connector that is off falls back to the old rules.
    expect(todoSource(config({ 'skill.todo': { enabled: true, source: 'apple-reminders' } }))).toBe('local');
  });

  it('adds doctor lines for both without reading any app or reminder', async () => {
    const calls: string[] = [];
    const run: ProcessRunner = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { code: 0, stdout: 'swift-driver version: 1.0\n', stderr: '', timedOut: false };
    };
    const macApps = { trusted: async () => false } as unknown as MacAppsClient;
    const reminders = { status: async () => 'denied' } as unknown as RemindersClient;
    const checks = await optionalChecks({
      config: config({ 'connector.mac-apps': { enabled: true }, 'connector.apple-reminders': { enabled: true } }),
      home: '/tmp/ax-kit-test-home',
      secrets: new MemorySecretStore(),
      run,
      macApps,
      reminders,
    });
    expect(checks.map((check) => [check.id, check.ok])).toEqual([
      ['mac-apps.swiftc', true],
      ['mac-apps.accessibility', false],
      ['reminders.access', false],
    ]);
    expect(checks[1]?.fix).toContain('Accessibility');
    expect(checks[2]?.fix).toContain('Reminders');
    expect(calls).toEqual(['swiftc --version']);
  });
});
