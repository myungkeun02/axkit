import { describe, expect, it } from 'vitest';
import { hardwareView } from '../../../src/channels/app/views/hardware.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { api, pairApp, startApp } from './harness.js';

describe('R8 usage per bot and Mac status, R9 server-drawn screens', () => {
  it('lists server-drawn screens in capabilities and answers them as blocks', async () => {
    const h = await startApp();
    try {
      const { token } = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { features: string[]; views: { name: string; ui?: string; title?: string; icon?: string }[] };
      expect(caps.features).toContain('blocks');
      expect(caps.views.find((v) => v.name === 'abilities')).toMatchObject({ ui: 'blocks', title: '할 수 있는 일', icon: 'sparkles' });
      expect(caps.views.find((v) => v.name === 'work-week')).toMatchObject({ ui: 'blocks', title: '이번 주 한 일' });
      expect(caps.views.find((v) => v.name === 'hardware')).toBeDefined();
      const abilities = (await (await api(h, token, 'views/abilities')).json()) as { data: { title: string; blocks: { kind: string; title?: string; rows?: { title: string; detail?: string }[] }[] } };
      expect(abilities.data.title).toBe('할 수 있는 일');
      const off = abilities.data.blocks.find((b) => b.kind === 'list' && b.title === '꺼져 있어요');
      expect(off?.rows?.find((r) => r.title === '캘린더 보기')?.detail).toContain('ax-kit connect google');
      expect(abilities.data.blocks.some((b) => b.kind === 'ask')).toBe(true);

      await h.app.host.capability(Contracts.workLog)?.add({ at: new Date(), title: '견적서 보냄', kind: 'action', bot: { id: 'sales', name: '영업 봇' } });
      const work = (await (await api(h, token, 'views/work-week')).json()) as { data: { blocks: { kind: string; value?: string; rows?: { title: string; trailing?: string }[] }[] } };
      expect(work.data.blocks[0]).toMatchObject({ kind: 'stat', value: '1건' });
      expect(work.data.blocks.find((b) => b.kind === 'list')?.rows?.[0]).toMatchObject({ title: '영업 봇', trailing: '1건' });

      const usage = (await (await api(h, token, 'views/usage')).json()) as { data: { byBot: unknown[] } };
      expect(usage.data.byBot).toEqual([]);
    } finally {
      await h.stop();
    }
  });

  it('describes the Mac in plain words, with warnings when it matters, and caches briefly', async () => {
    const calls: string[] = [];
    const run: ProcessRunner = async (cmd, args) => {
      calls.push(cmd);
      const stdout =
        cmd === 'sysctl' ? 'Mac17,13' : cmd === 'sw_vers' ? '27.2' : args.includes('therm') ? 'CPU_Speed_Limit = 60' : args.includes('batt') ? "Now drawing from 'AC Power'" : '{"BackendState":"Running","Self":{"HostName":"mac-mini"}}';
      return { code: 0, stdout, stderr: '', timedOut: false };
    };
    let now = 1_000_000;
    const ctx = { assistant: { language: 'ko' }, clock: { now: () => new Date(now) }, tryUse: () => undefined } as unknown as PluginContext;
    const view = hardwareView(ctx, { run, version: async () => '0.9.0', probe: { memory: { total: 64 * 1024 ** 3, free: 16 * 1024 ** 3 }, disk: { total: 1000 * 1024 ** 3, free: 10 * 1024 ** 3 }, load: 2, cores: 8 } });
    const data = await view.read(new URLSearchParams());
    expect(data).toMatchObject({
      machine: { model: 'Mac17,13', os: 'macOS 27.2' },
      cpuPercent: 25,
      memory: { used: 48, total: 64, unit: 'GB' },
      disk: { used: 990, total: 1000, unit: 'GB' },
      thermal: 'serious',
      power: '전원 연결됨',
      network: { tailscale: '연결됨 (mac-mini)' },
      server: { version: 'ax-kit 0.9.0', stop: '켜짐' },
    });
    expect(String(data['summary'])).toContain('저장 공간');
    expect(String(data['summary'])).toContain('뜨거워서');
    const before = calls.length;
    now += 5_000;
    await view.read(new URLSearchParams());
    expect(calls.length).toBe(before);
  });

  it('reads this Mac for real without failing', async () => {
    const { nodeProcessRunner } = await import('../../../src/core/process/node-runner.js');
    const ctx = { assistant: { language: 'ko' }, clock: { now: () => new Date() }, tryUse: () => undefined } as unknown as PluginContext;
    const data = await hardwareView(ctx, { run: nodeProcessRunner, version: async () => 'test' }).read(new URLSearchParams());
    expect(data['machine']).toBeDefined();
    expect((data['memory'] as { total: number }).total).toBeGreaterThan(0);
  });
});
