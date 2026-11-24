import type { Config } from '../core/config/schema.js';
import { DEFAULT_PORT, resolveMobileConfig } from '../mobile/config.js';
import type { Prompter } from './prompter.js';
import { funnelStatus, servesPath, tailscaleStatus } from './tailscale.js';
import type { Exec } from './tailscale.js';

const PUBLIC_TIMEOUT_MS = 10_000;
const DNS_ADMIN = 'https://login.tailscale.com/admin/dns';
const ACL_ADMIN = 'https://login.tailscale.com/admin/acls';
const HTTPS_ERROR = /https|certificate|cert\b/i;
const FUNNEL_ERROR = /nodeAttrs|funnel[^.\n]{0,60}(?:not enabled|not allowed|disabled|denied)/i;
const INSTALL_FIX = 'brew install --cask tailscale';
const RUN_FIX = 'Tailscale 앱을 열고 `tailscale up`을 실행해 주세요.';

export interface FetchResponseLike {
  ok: boolean;
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<FetchResponseLike>;

export interface FunnelDeps {
  exec: Exec;
  fetch: FetchLike;
  prompter: Prompter;
  say(line: string): void;
  loadConfig(): Promise<Config | undefined>;
}

export interface FunnelFlags {
  fix?: boolean;
}

type StepId = 'installed' | 'running' | 'dns' | 'https' | 'funnel' | 'path' | 'local' | 'public';

interface Step {
  id: StepId;
  ok: boolean;
  label: string;
  fix?: string;
  /** The one failure `--fix` may repair: status works but /m is not routed. */
  fixable?: boolean;
}

interface Diagnosis {
  steps: Step[];
  bin?: string;
  port: number;
}

function configuredPort(config: Config | undefined): number {
  const parsed = resolveMobileConfig(config?.plugins['bridge.mobile'] ?? {});
  return parsed.port > 0 ? parsed.port : DEFAULT_PORT;
}

/** One health request with the public-URL timeout; any error (including abort) means "not answering". */
async function answers(fetchFn: FetchLike, url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetchFn(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function diagnose(deps: FunnelDeps): Promise<Diagnosis> {
  const port = configuredPort(await deps.loadConfig());
  const status = await tailscaleStatus(deps.exec);
  const funnel = status.installed && status.running ? await funnelStatus(deps.exec) : { ok: false, text: '' };
  const dns = status.dnsName;
  const ready = status.installed && status.running;
  const prerequisite = !status.installed ? INSTALL_FIX : !status.running ? RUN_FIX : undefined;
  const withPrerequisite = (fix: string): string => prerequisite ?? fix;
  const pathCommand = `tailscale funnel --bg --set-path /m http://127.0.0.1:${port}/m`;
  const pathServed = ready && funnel.ok && servesPath(funnel.text, '/m');

  const steps: Step[] = [
    {
      id: 'installed',
      ok: status.installed,
      label: 'Tailscale 설치',
      ...(status.installed ? {} : { fix: INSTALL_FIX }),
    },
    {
      id: 'running',
      ok: status.running,
      label: 'Tailscale 실행·로그인',
      ...(status.running ? {} : { fix: status.installed ? RUN_FIX : INSTALL_FIX }),
    },
    {
      id: 'dns',
      ok: dns !== undefined,
      label: 'MagicDNS 이름',
      ...(dns === undefined ? { fix: withPrerequisite(`MagicDNS를 켜 주세요: ${DNS_ADMIN}`) } : {}),
    },
    {
      id: 'https',
      ok: ready && (funnel.ok || !HTTPS_ERROR.test(funnel.text)),
      label: 'HTTPS 인증서',
      ...(ready && (funnel.ok || !HTTPS_ERROR.test(funnel.text))
        ? {}
        : { fix: withPrerequisite(`HTTPS 인증서를 켜 주세요: ${DNS_ADMIN}`) }),
    },
    {
      id: 'funnel',
      ok: ready && (funnel.ok || !FUNNEL_ERROR.test(funnel.text)),
      label: '이 기기의 Funnel 권한',
      ...(ready && (funnel.ok || !FUNNEL_ERROR.test(funnel.text))
        ? {}
        : { fix: withPrerequisite(`이 기기에 funnel 권한을 주세요: ${ACL_ADMIN} (nodeAttrs: funnel)`) }),
    },
    {
      id: 'path',
      ok: pathServed,
      label: '/m 경로 공개',
      ...(pathServed ? {} : { fix: withPrerequisite(pathCommand) }),
      ...(ready && funnel.ok && !pathServed ? { fixable: true } : {}),
    },
    {
      id: 'local',
      ok: false,
      label: `로컬 브리지 (127.0.0.1:${port})`,
      fix: `ax-kit가 127.0.0.1:${port}에서 응답하게 해 주세요: ax-kit start`,
    },
    {
      id: 'public',
      ok: false,
      label: dns === undefined ? '공개 주소 (/m/health)' : `공개 주소 (https://${dns}/m/health)`,
      fix:
        dns === undefined
          ? `MagicDNS를 켜 주세요: ${DNS_ADMIN}`
          : '아직 휴대폰이 이 주소에 닿지 못해요. 잠시 뒤 다시 확인해 주세요: ax-kit phone funnel',
    },
  ];

  const local = steps.find((step) => step.id === 'local');
  const publicStep = steps.find((step) => step.id === 'public');
  if (local !== undefined) local.ok = await answers(deps.fetch, `http://127.0.0.1:${port}/m/health`);
  if (publicStep !== undefined && dns !== undefined) {
    publicStep.ok = await answers(deps.fetch, `https://${dns}/m/health`);
  }
  return { steps, port, ...(funnel.bin !== undefined ? { bin: funnel.bin } : {}) };
}

function printSteps(deps: FunnelDeps, steps: readonly Step[]): void {
  let lastFix: string | undefined;
  for (const step of steps) {
    deps.say(`${step.ok ? '✓' : '✗'} ${step.label}`);
    if (step.ok || step.fix === undefined) continue;
    // Later steps that wait on the same earlier fix would only repeat it.
    deps.say(step.fix === lastFix ? '  → 앞 단계를 먼저 고쳐 주세요.' : `  → ${step.fix}`);
    lastFix = step.fix;
  }
  deps.say(
    steps.every((step) => step.ok)
      ? '모두 정상이에요. 휴대폰에서 QR 링크를 열어 주세요.'
      : '문제가 남아 있어요. 위의 → 줄을 하나씩 따라 해 주세요.',
  );
}

async function offerPathFix(deps: FunnelDeps, diagnosis: Diagnosis): Promise<Diagnosis> {
  const failures = diagnosis.steps.filter((step) => !step.ok);
  const onlyPath = failures.length === 1 && failures[0]?.fixable === true;
  if (onlyPath !== true || diagnosis.bin === undefined) return diagnosis;
  const answer = await deps.prompter.choose(
    '/m 경로가 아직 공개되지 않았어요. Tailscale Funnel로 지금 설정할까요? (Tailscale의 다른 설정은 바꾸지 않아요.)',
    [
      { value: 'yes', label: '지금 설정' },
      { value: 'no', label: '그대로 두기' },
    ],
    1,
  );
  if (answer !== 'yes') {
    deps.say(
      `그대로 두었어요. 나중에 \`tailscale funnel --bg --set-path /m http://127.0.0.1:${diagnosis.port}/m\`로 설정할 수 있어요.`,
    );
    return diagnosis;
  }
  const result = await deps.exec(diagnosis.bin, [
    'funnel',
    '--bg',
    '--set-path',
    '/m',
    `http://127.0.0.1:${diagnosis.port}/m`,
  ]);
  deps.say(
    result.code === 0
      ? 'Funnel 경로를 설정했어요. 다시 확인할게요.'
      : 'Funnel 설정이 실패했어요. `tailscale funnel status`로 상태를 확인해 주세요.',
  );
  return await diagnose(deps);
}

/** `ax-kit phone funnel [--fix]`: read-only diagnosis with an optional, opt-in /m path fix. */
export async function funnelCommand(flags: FunnelFlags, deps: FunnelDeps): Promise<number> {
  let diagnosis = await diagnose(deps);
  if (flags.fix === true) diagnosis = await offerPathFix(deps, diagnosis);
  printSteps(deps, diagnosis.steps);
  return diagnosis.steps.every((step) => step.ok) ? 0 : 1;
}
