import { z } from 'zod';

export const DEFAULT_PORT = 47617;
export const DEFAULT_HOST = '127.0.0.1';

const ALL_INTERFACES = new Set(['0.0.0.0', '::', '[::]']);

const mobileConfigSchema = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(DEFAULT_PORT),
  host: z.string().trim().min(1).default(DEFAULT_HOST),
  publicUrl: z.preprocess((value) => (value === '' ? undefined : value), z.url().optional()),
});

export interface ResolvedMobileConfig {
  port: number;
  host: string;
  publicUrl?: string;
  /** The config asked for every interface; the bridge listens on loopback instead. */
  forcedLoopback: boolean;
  /** The config was invalid and defaults were used. */
  usedDefaults: boolean;
}

/** The bridge never listens on 0.0.0.0: a tunnel (Tailscale Funnel) is the only public path. */
export function resolveMobileConfig(raw: Readonly<Record<string, unknown>>): ResolvedMobileConfig {
  const parsed = mobileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { port: DEFAULT_PORT, host: DEFAULT_HOST, forcedLoopback: false, usedDefaults: true };
  }
  const forcedLoopback = ALL_INTERFACES.has(parsed.data.host);
  return {
    port: parsed.data.port,
    host: forcedLoopback ? DEFAULT_HOST : parsed.data.host,
    ...(parsed.data.publicUrl !== undefined ? { publicUrl: parsed.data.publicUrl } : {}),
    forcedLoopback,
    usedDefaults: false,
  };
}

/** The link a QR code encodes. `publicUrl` is the tunnel address; otherwise the local address is shown. */
export function pairingUrl(config: Pick<ResolvedMobileConfig, 'host' | 'port' | 'publicUrl'>, nonce: string): string {
  const base = config.publicUrl ?? `http://${config.host}:${config.port}`;
  return `${base.replace(/\/+$/, '')}/m/p/${encodeURIComponent(nonce)}`;
}
