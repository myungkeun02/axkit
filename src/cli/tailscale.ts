export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, args: readonly string[]) => Promise<ExecResult>;

/** The CLI inside the macOS app bundle is the same binary as the one Homebrew links onto PATH. */
export const TAILSCALE_APP_PATH = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  dnsName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function run(exec: Exec, cmd: string, args: readonly string[]): Promise<ExecResult | undefined> {
  try {
    return await exec(cmd, args);
  } catch {
    return undefined;
  }
}

/** Read-only probe: returns the binary that responded, never changes tailscale settings. */
export async function findTailscale(exec: Exec): Promise<string | undefined> {
  const onPath = await run(exec, 'tailscale', ['version']);
  if (onPath?.code === 0) return 'tailscale';
  const inApp = await run(exec, TAILSCALE_APP_PATH, ['version']);
  return inApp?.code === 0 ? TAILSCALE_APP_PATH : undefined;
}

export async function tailscaleStatus(exec: Exec): Promise<TailscaleStatus> {
  const bin = await findTailscale(exec);
  if (bin === undefined) return { installed: false, running: false };
  const result = await run(exec, bin, ['status', '--json']);
  if (result === undefined || result.code !== 0) return { installed: true, running: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { installed: true, running: false };
  }
  const root = asRecord(parsed);
  const self = asRecord(root?.Self);
  const rawName = self?.DNSName;
  const dnsName = typeof rawName === 'string' ? rawName.replace(/\.$/, '') : '';
  return {
    installed: true,
    running: root?.BackendState === 'Running',
    ...(dnsName.length > 0 ? { dnsName } : {}),
  };
}

/** True when a `tailscale funnel status` line routes exactly this path (and not merely a prefix). */
export function servesPath(text: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\s)${escaped}/?(?=\\s|$)`);
  return text.split(/\r?\n/).some((line) => pattern.test(line.trim()));
}

export interface FunnelStatus {
  bin?: string;
  /** `tailscale funnel status` exited 0. */
  ok: boolean;
  /** stdout and stderr of both funnel and serve status, joined for error-text checks. */
  text: string;
}

export async function funnelStatus(exec: Exec): Promise<FunnelStatus> {
  const bin = await findTailscale(exec);
  if (bin === undefined) return { ok: false, text: '' };
  const [funnel, serve] = await Promise.all([
    run(exec, bin, ['funnel', 'status']),
    run(exec, bin, ['serve', 'status']),
  ]);
  const text = [funnel, serve]
    .flatMap((result) => (result === undefined ? [] : [result.stdout, result.stderr]))
    .filter((part) => part.trim().length > 0)
    .join('\n');
  return { bin, ok: funnel !== undefined && funnel.code === 0, text };
}

export async function funnelServesPath(exec: Exec, path: string): Promise<boolean> {
  const status = await funnelStatus(exec);
  return status.ok && servesPath(status.text, path);
}
