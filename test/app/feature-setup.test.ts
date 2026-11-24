import { describe, expect, it } from 'vitest';
import { featureSetupPlugin } from '../../src/app/feature-setup.js';
import type { Config, ConfigInput } from '../../src/core/config/schema.js';
import { parseConfig } from '../../src/core/config/load.js';
import { Contracts } from '../../src/core/contracts/index.js';
import type { FeatureSetup } from '../../src/core/contracts/feature-setup.js';
import { createTestContext } from '../support/context.js';

function store(initial: ConfigInput): { load: (path: string) => Promise<Config>; save: (path: string, config: ConfigInput) => Promise<void>; saved: ConfigInput[] } {
  let current = parseConfig(initial);
  const saved: ConfigInput[] = [];
  return {
    load: async () => current,
    save: async (_path, config) => {
      saved.push(config);
      current = parseConfig(config);
    },
    saved,
  };
}

const BASE: ConfigInput = {
  version: 1,
  assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
  owner: { discordUserId: '123456789012345678' },
  plugins: { 'skill.onboarding': { enabled: true, folders: ['~/Documents'] } },
} as ConfigInput;

async function setup(managed: boolean) {
  const files = store(BASE);
  const scheduled: number[] = [];
  let restarts = 0;
  const context = createTestContext();
  await featureSetupPlugin({
    configFile: '/x/config.json',
    managed,
    restart: () => {
      restarts += 1;
    },
    load: files.load,
    save: files.save,
    schedule: (run, ms) => {
      scheduled.push(ms);
      run();
    },
  }).setup(context.ctx);
  return { setup: context.provided.get(Contracts.featureSetup.id) as FeatureSetup, files, scheduled, restarts: () => restarts };
}

describe('turning a feature on from chat', () => {
  it('writes enabled into the config, keeps the rest and restarts a service once', async () => {
    const { setup: features, files, scheduled, restarts } = await setup(true);
    expect(features.isOn('skill.talent')).toBe(false);
    expect(await features.turnOn(['skill.talent'])).toEqual({ restart: 'soon' });
    expect(features.isOn('skill.talent')).toBe(true);
    expect(files.saved[0]?.plugins?.['skill.onboarding']).toEqual({ enabled: true, folders: ['~/Documents'] });
    expect(restarts()).toBe(1);
    expect(scheduled).toEqual([8_000]);
  });

  it('asks for a manual restart outside the service and refuses plugins that need setup', async () => {
    const { setup: features, restarts } = await setup(false);
    expect(await features.turnOn(['connector.macos-ocr'])).toEqual({ restart: 'manual' });
    expect(restarts()).toBe(0);
    await expect(features.turnOn(['connector.kakao-desktop'])).rejects.toThrow('switchable');
  });
});
