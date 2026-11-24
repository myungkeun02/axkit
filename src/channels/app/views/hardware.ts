import { statfs } from 'node:fs/promises';
import { cpus, freemem, hostname, loadavg, totalmem, uptime } from 'node:os';
import { Contracts } from '../../../core/contracts/index.js';
import type { AppView } from '../../../core/contracts/device-api.js';
import type { PluginContext } from '../../../core/plugin/types.js';
import type { ProcessRunner } from '../../../core/process/types.js';

/**
 * View "hardware" (R8): how the Mac that runs the assistant is doing, in words a person reads. The app polls it every
 * 15 seconds while the screen is open, so answers are cached briefly and each probe has a short timeout.
 */
const CACHE_MS = 10_000;
const GB = 1024 ** 3;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function duration(seconds: number, korean: boolean): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (korean) return days > 0 ? `${days}일 ${hours}시간` : hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`;
  return days > 0 ? `${days} d ${hours} h` : hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

export interface HardwareDeps {
  run: ProcessRunner;
  version: () => Promise<string>;
  /** Tests fix the numbers. */
  probe?: {
    memory?: { total: number; free: number };
    disk?: { total: number; free: number };
    load?: number;
    cores?: number;
  };
}

export function hardwareView(ctx: PluginContext, deps: HardwareDeps): AppView {
  const korean = ctx.assistant.language !== 'en';
  let cached: { at: number; data: Record<string, unknown> } | undefined;
  const out = async (cmd: string, args: readonly string[]): Promise<string | undefined> => {
    const result = await deps.run(cmd, args, { timeoutMs: 3_000 }).catch(() => undefined);
    return result !== undefined && result.code === 0 ? result.stdout.trim() : undefined;
  };
  return {
    name: 'hardware',
    version: 1,
    async read() {
      const now = ctx.clock.now().getTime();
      if (cached !== undefined && now - cached.at < CACHE_MS) return cached.data;
      const cores = deps.probe?.cores ?? cpus().length;
      const cpuPercent = Math.min(100, Math.round(((deps.probe?.load ?? loadavg()[0] ?? 0) / Math.max(1, cores)) * 100));
      const mem = deps.probe?.memory ?? { total: totalmem(), free: freemem() };
      const fs = deps.probe?.disk ?? (await statfs('/').then((info) => ({ total: info.blocks * info.bsize, free: info.bavail * info.bsize })).catch(() => undefined));
      const [model, os, therm, batt, tailscale] = await Promise.all([
        out('sysctl', ['-n', 'hw.model']),
        out('sw_vers', ['-productVersion']),
        out('pmset', ['-g', 'therm']),
        out('pmset', ['-g', 'batt']),
        out('tailscale', ['status', '--json']).then(async (text) => text ?? (await out('/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['status', '--json']))),
      ]);
      const thermal = therm === undefined ? undefined : /CPU_Speed_Limit\s*=\s*(\d+)/.exec(therm)?.[1] ?? '100';
      const thermalState = thermal === undefined ? undefined : Number(thermal) >= 100 ? 'nominal' : Number(thermal) >= 80 ? 'fair' : Number(thermal) >= 50 ? 'serious' : 'critical';
      const power = batt === undefined ? undefined : /AC Power/.test(batt) ? (korean ? '전원 연결됨' : 'On power') : `${korean ? '배터리' : 'Battery'} ${/(\d+)%/.exec(batt)?.[1] ?? '?'}%`;
      let tailnet: string | undefined;
      if (tailscale !== undefined) {
        try {
          const parsed = JSON.parse(tailscale) as { BackendState?: string; Self?: { HostName?: string } };
          tailnet = parsed.BackendState === 'Running' ? `${korean ? '연결됨' : 'Connected'} (${parsed.Self?.HostName ?? hostname()})` : korean ? '꺼져 있어요' : 'Off';
        } catch {
          tailnet = undefined;
        }
      }
      const stopped = (await ctx.tryUse(Contracts.killSwitch)?.state().catch(() => undefined))?.stopped ?? false;
      const memUsed = round((mem.total - mem.free) / GB);
      const diskFree = fs === undefined ? undefined : fs.free / GB;
      const warnings: string[] = [];
      if (diskFree !== undefined && diskFree < 20) warnings.push(korean ? '저장 공간이 얼마 안 남았어요' : 'Disk is nearly full');
      if (thermalState === 'serious' || thermalState === 'critical') warnings.push(korean ? '맥이 뜨거워서 느려졌어요' : 'The Mac is hot and slowed down');
      if (cpuPercent >= 90) warnings.push(korean ? '맥이 아주 바빠요' : 'The Mac is very busy');
      const data: Record<string, unknown> = {
        checkedAt: new Date(now).toISOString(),
        machine: { name: hostname().replace(/\.local$/, ''), ...(model !== undefined ? { model } : {}), ...(os !== undefined ? { os: `macOS ${os}` } : {}), uptimeSec: Math.round(uptime()) },
        cpuPercent,
        memory: { used: memUsed, total: round(mem.total / GB), unit: 'GB' },
        ...(fs !== undefined ? { disk: { used: round((fs.total - fs.free) / GB), total: round(fs.total / GB), unit: 'GB' } } : {}),
        ...(thermalState !== undefined ? { thermal: thermalState } : {}),
        ...(power !== undefined ? { power } : {}),
        ...(tailnet !== undefined ? { network: { tailscale: tailnet } } : {}),
        server: {
          version: `ax-kit ${await deps.version().catch(() => '?')}`,
          uptime: duration(process.uptime(), korean),
          stop: stopped ? (korean ? '전체 정지 중' : 'Stopped') : korean ? '켜짐' : 'Running',
        },
        summary: warnings.length > 0 ? warnings.join(' · ') : korean ? '맥이 건강해요.' : 'The Mac is healthy.',
      };
      cached = { at: now, data };
      return data;
    },
  };
}
