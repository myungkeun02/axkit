import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/build.js';
import { opsChecks } from '../../src/app/ops-checks.js';
import { parseConfig } from '../../src/core/config/load.js';
import { Caps } from '../../src/core/plugin/types.js';
import { Contracts } from '../../src/core/contracts/index.js';
import type { OutgoingMessage } from '../../src/core/conversation/types.js';
import type { EventBus } from '../../src/core/events/types.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import type { Plugin } from '../../src/core/plugin/types.js';
import type { ProcessRunner } from '../../src/core/process/types.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';

const OWNER = '11111111111111111';
const config = parseConfig({
  version: 1,
  assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
  owner: { discordUserId: OWNER },
});

const cleanGit: ProcessRunner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false });
const dirtyGit: ProcessRunner = async () => ({ code: 0, stdout: ' M a.ts\n?? b.ts\n', stderr: '', timedOut: false });

function probe(sent: OutgoingMessage[]): { plugin: Plugin; bus: () => EventBus } {
  let bus: EventBus | undefined;
  return {
    bus: () => bus!,
    plugin: {
      manifest: { id: 'channel.probe', kind: 'channel', title: 'probe' },
      setup(ctx) {
        bus = ctx.bus;
        ctx.use(Caps.channels).register({
          id: 'channel.probe',
          replier: { reply: async () => undefined },
          owner: { send: async (message) => void sent.push(message) },
        });
      },
    },
  };
}

describe('core services', () => {
  it('provides switches, breaker, docs, health, usage and notice stats', async () => {
    const sent: OutgoingMessage[] = [];
    const { plugin } = probe(sent);
    const app = await buildApp({ config, secrets: new MemorySecretStore(), log: silentLogger, plugins: [plugin], storePath: ':memory:', run: dirtyGit });
    await app.start();
    try {
      expect(app.host.capability(Contracts.docs)).toBeDefined();
      expect(app.host.capability(Contracts.usage)).toBeDefined();
      expect(app.host.capability(Contracts.noticeStats)).toBeDefined();
      const health = app.host.capability(Contracts.featureHealth)!;
      for (let i = 0; i < 4; i += 1) expect(await health.recordFailure({ feature: 'skill.demo', signature: 'timeout' })).toBe('counted');
      expect(await health.recordFailure({ feature: 'skill.demo', signature: 'timeout' })).toBe('paused');
      expect(await app.host.capability(Contracts.switches)!.pausedState('skill.demo')).toMatchObject({ auto: true });
      expect(sent.at(-1)?.text).toContain('5번 연달아 실패');

      const findings = await app.host.capability(Contracts.health)!.runAll(new Date());
      expect(findings.find((f) => f.id === 'ops.uncommitted')).toMatchObject({ ok: false });
      expect(findings.some((f) => f.id === 'switch.auto:skill.demo' && !f.ok)).toBe(true);
    } finally {
      await app.stop('test');
    }
  });

  it('flags documents that relied on a fact when the fact ends, and tells the owner once', async () => {
    const sent: OutgoingMessage[] = [];
    const { plugin, bus } = probe(sent);
    const app = await buildApp({ config, secrets: new MemorySecretStore(), log: silentLogger, plugins: [plugin], storePath: ':memory:', run: cleanGit });
    await app.start();
    try {
      const docs = app.host.capability(Contracts.docs)!;
      await docs.upsert({
        id: 'company:policies',
        kind: 'company',
        scope: 'company',
        title: '회사 규칙',
        body: '출시 전이라 외부 발송 검토를 생략한다',
        author: { kind: 'user', id: 'owner' },
        basedOnFacts: ['f1'],
      });
      await bus().emit('memory.fact_expired', { id: 'f1', subject: 'owner', text: '아직 출시 전', reason: 'event' });
      expect((await docs.get('company:policies'))?.needsReview).toBe(true);
      expect(sent.filter((m) => m.text.includes('회사 규칙'))).toHaveLength(1);
    } finally {
      await app.stop('test');
    }
  });
});

describe('opsChecks (doctor)', () => {
  it('reads pauses and documents from the database and reports uncommitted code', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ax-kit-ops-'));
    try {
      mkdirSync(join(home, 'data'));
      const app = await buildApp({ config, secrets: new MemorySecretStore(), log: silentLogger, plugins: [], storePath: join(home, 'data', 'ax-kit.db'), run: cleanGit });
      await app.start();
      const switches = app.host.capability(Contracts.switches)!;
      await switches.pause('connector.mail', {
        reason: '잠깐 멈춤',
        until: new Date(Date.now() + 20 * 86_400_000),
        by: { kind: 'user', id: 'owner' },
      });
      await app.stop('test');

      const later = new Date(Date.now() + 9 * 86_400_000);
      const checks = await opsChecks({ config, home, now: later, run: dirtyGit, codeDir: home });
      expect(checks.find((c) => c.id === 'ops.switch.long:connector.mail')).toMatchObject({ ok: false });
      expect(checks.find((c) => c.id === 'ops.ops.uncommitted')).toMatchObject({ ok: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still checks the code when there is no database yet', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ax-kit-ops-'));
    try {
      const checks = await opsChecks({ config, home, now: new Date(), run: cleanGit, codeDir: home });
      expect(checks).toEqual([expect.objectContaining({ id: 'ops.ops.uncommitted', ok: true })]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
