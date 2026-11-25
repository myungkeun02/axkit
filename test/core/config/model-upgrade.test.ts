import { describe, expect, it } from 'vitest';
import { upgradeModels } from '../../../src/core/config/model-upgrade.js';

const routesOf = (raw: unknown) => ((raw as { llm: { routes: { model: string; tiers: string[] }[] } }).llm.routes).map((route) => `${route.model}:${route.tiers.join('+')}`);

describe('upgradeModels', () => {
  it('gives the Claude subscription deep tier to opus', () => {
    const raw = { llm: { providers: [{ id: 'claude-cli', kind: 'claude-cli' }], routes: [{ providerId: 'claude-cli', model: 'sonnet', tiers: ['standard', 'deep'] }, { providerId: 'claude-cli', model: 'haiku', tiers: ['fast'] }] } };
    expect(routesOf(upgradeModels(raw))).toEqual(['opus:deep', 'sonnet:standard', 'haiku:fast']);
  });

  it('moves old API models to the current ones', () => {
    const raw = { llm: { providers: [{ id: 'anthropic', kind: 'anthropic' }, { id: 'anthropic-haiku', kind: 'anthropic' }], routes: [{ providerId: 'anthropic', model: 'claude-sonnet-4-5', tiers: ['standard', 'deep'] }, { providerId: 'anthropic-haiku', model: 'claude-haiku-4-5', tiers: ['fast'] }] } };
    expect(routesOf(upgradeModels(raw))).toEqual(['claude-opus-5-5:deep', 'claude-sonnet-5-5:standard', 'claude-haiku-5-5:fast']);
  });

  it('leaves a lineup the owner set alone', () => {
    const raw = { llm: { providers: [{ id: 'claude-cli', kind: 'claude-cli' }], routes: [{ providerId: 'claude-cli', model: 'opus', tiers: ['deep'] }, { providerId: 'claude-cli', model: 'sonnet', tiers: ['standard', 'deep'] }] } };
    expect(routesOf(upgradeModels(raw))).toEqual(['opus:deep', 'sonnet:standard+deep']);
  });
});
