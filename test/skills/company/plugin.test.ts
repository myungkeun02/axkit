import { describe, expect, it } from 'vitest';
import type { BacklogReader, HealthCheck, HealthFinding, HealthRegistry } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { KvDocStore } from '../../../src/core/docs/kv-doc-store.js';
import type { PluginInstance } from '../../../src/core/plugin/types.js';
import { companySkill } from '../../../src/skills/company/plugin.js';
import { KvTaskRepository } from '../../../src/skills/company/store.js';
import { createTestContext } from '../../support/context.js';
import { NOW } from './helpers.js';
import { DedupeNotifier } from './work-helpers.js';

const RAW_TEAMS = [
  { id: 'dev', name: '개발', role: '개발 work', scope: ['개발', '버그'], kind: 'dev', repo: 'owner/app' },
  { id: 'marketing', name: '마케팅', role: '마케팅 work', scope: ['마케팅'] },
];

function healthRegistry(checks: HealthCheck[]): HealthRegistry {
  return {
    register(check) {
      checks.push(check);
    },
    async runAll(): Promise<HealthFinding[]> {
      return [];
    },
  };
}

describe('companySkill', () => {
  it('registers handlers, jobs, tools, backlog and health for two teams', async () => {
    const checks: HealthCheck[] = [];
    const notifier = new DedupeNotifier();
    const context = createTestContext({
      now: NOW,
      config: { teams: RAW_TEAMS, mailIntake: { enabled: false, query: '', everyMinutes: 30 } },
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.health.id]: healthRegistry(checks) },
    });
    const docs = new KvDocStore(context.kv, () => context.clock.now());
    context.provided.set(Contracts.docs.id, docs);
    const plugin = companySkill();

    expect(plugin.manifest).toEqual({
      id: 'skill.company',
      kind: 'skill',
      title: 'Company mode (team bots with work caps; optional)',
    });
    const instance = (await plugin.setup(context.ctx)) as PluginInstance;

    expect(context.handlers.map((handler) => handler.id).sort()).toEqual(['company.decision', 'company.intake']);
    expect([...context.scheduler.jobs.keys()].sort()).toEqual(['company.report', 'company.team-docs', 'company.tick']);
    expect(context.registry.list().map((tool) => tool.name).sort()).toEqual([
      'company.docs',
      'company.profile',
      'company.submit',
    ]);
    expect(context.provided.has(Contracts.backlog.id)).toBe(true);
    expect(checks.map((check) => check.id)).toEqual(['company.backlog']);

    const reader = context.provided.get(Contracts.backlog.id) as BacklogReader;
    expect(await reader.snapshot(NOW)).toMatchObject({ open: 0, openLimit: 6 });

    await instance.start?.();
    expect(await docs.get('company:team:dev')).toBeDefined();
    expect(await docs.get('company:team:marketing')).toBeDefined();
    expect(notifier.notices.map((notice) => notice.kind)).toContain('company.onboarding');

    await context.bus.emit('company.intake', { request: '버그를 고쳐 주세요', ref: 'mail:1' });
    const tasks = new KvTaskRepository(context.kv, () => context.clock.now());
    expect(await tasks.all()).toHaveLength(1);

    await instance.stop?.();
    await context.bus.emit('company.intake', { request: '버그를 하나 더', ref: 'mail:2' });
    expect(await tasks.all()).toHaveLength(1);
  });

  it('registers only the profile tools when there are no teams', async () => {
    const context = createTestContext({ now: NOW, config: {} });
    const docs = new KvDocStore(context.kv, () => context.clock.now());
    context.provided.set(Contracts.docs.id, docs);
    const plugin = companySkill();

    const instance = (await plugin.setup(context.ctx)) as PluginInstance;

    expect(context.handlers).toHaveLength(0);
    expect(context.scheduler.jobs.size).toBe(0);
    expect(context.registry.list().map((tool) => tool.name).sort()).toEqual(['company.docs', 'company.profile']);
    expect(context.provided.has(Contracts.backlog.id)).toBe(false);
    expect(instance.start).toBeUndefined();
  });
});
