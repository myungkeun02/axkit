import { describe, expect, it } from 'vitest';
import { funnelCommand } from '../../src/cli/funnel.js';
import type { FetchLike, FunnelDeps } from '../../src/cli/funnel.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { parseConfig } from '../../src/core/config/load.js';
import type { Config } from '../../src/core/config/schema.js';
import { DEFAULT_PORT } from '../../src/mobile/config.js';
import type { Exec, ExecResult } from '../../src/cli/tailscale.js';

const DNS = 'box.example.ts.net';
const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const SERVED: ExecResult = {
  code: 0,
  stdout: '# Funnel on:\n|-- /m proxy http://127.0.0.1:47617/m',
  stderr: '',
};

interface Call {
  cmd: string;
  args: readonly string[];
}

interface ExecScenario {
  installed?: boolean;
  running?: boolean;
  dns?: string | undefined;
  funnel?: (calls: readonly Call[]) => ExecResult;
  serve?: ExecResult;
}

function fakeExec(scenario: ExecScenario) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const key = [cmd, ...args].join(' ');
    if (args[0] === 'version') {
      if (scenario.installed === false) throw new Error('ENOENT');
      return OK;
    }
    if (key === 'tailscale status --json') {
      const dnsName = scenario.dns === undefined ? {} : { DNSName: `${scenario.dns}.` };
      const state = scenario.running === false ? 'Stopped' : 'Running';
      return { code: 0, stdout: JSON.stringify({ BackendState: state, Self: dnsName }), stderr: '' };
    }
    if (key === 'tailscale funnel status') {
      return scenario.funnel?.(calls) ?? SERVED;
    }
    if (key === 'tailscale serve status') {
      return scenario.serve ?? OK;
    }
    return OK;
  };
  return { calls, exec };
}

interface FakeFetch {
  urls: string[];
  fetchFn: FetchLike;
}

function fakeFetch(results: Record<string, boolean> = {}): FakeFetch {
  const urls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    urls.push(url);
    return { ok: results[url] ?? false };
  };
  return { urls, fetchFn };
}

function healthyFetch(port = DEFAULT_PORT): FakeFetch {
  return fakeFetch({
    [`http://127.0.0.1:${port}/m/health`]: true,
    [`https://${DNS}/m/health`]: true,
  });
}

function config(port?: number): Config {
  return parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    owner: { discordUserId: '11111111111111111' },
    plugins: { 'bridge.mobile': port === undefined ? { enabled: true } : { enabled: true, port } },
  });
}

interface Harness {
  deps: FunnelDeps;
  calls: Call[];
  said: string[];
  fetcher: FakeFetch;
  prompter: ReturnType<typeof createScriptedPrompter>;
}

function harness(
  input: {
    scenario?: ExecScenario;
    answers?: readonly string[];
    fetcher?: FakeFetch;
    port?: number;
  } = {},
): Harness {
  const scenario: ExecScenario = { dns: DNS, ...input.scenario };
  const { calls, exec } = fakeExec(scenario);
  const fetcher = input.fetcher ?? healthyFetch(input.port);
  const prompter = createScriptedPrompter(input.answers ?? []);
  const said: string[] = [];
  const deps: FunnelDeps = {
    exec,
    fetch: fetcher.fetchFn,
    prompter,
    say: (line) => said.push(line),
    loadConfig: async () => config(input.port),
  };
  return { deps, calls, said, fetcher, prompter };
}

function output(said: readonly string[]): string {
  return said.join('\n');
}

describe('ax-kit phone funnel', () => {
  it('reports every step and exits 0 when the deployment is healthy', async () => {
    const h = harness();

    expect(await funnelCommand({}, h.deps)).toBe(0);

    const text = output(h.said);
    expect(text).toContain('✓ Tailscale 설치');
    expect(text).toContain('✓ MagicDNS 이름');
    expect(text).toContain('✓ HTTPS 인증서');
    expect(text).toContain('✓ 이 기기의 Funnel 권한');
    expect(text).toContain('✓ /m 경로 공개');
    expect(text).toContain('✓ 로컬 브리지 (127.0.0.1:47617)');
    expect(text).toContain(`✓ 공개 주소 (https://${DNS}/m/health)`);
    expect(text).toContain('모두 정상이에요');
    expect(h.fetcher.urls).toEqual([
      'http://127.0.0.1:47617/m/health',
      `https://${DNS}/m/health`,
    ]);
  });

  it('stops at the install fix when Tailscale is missing', async () => {
    const h = harness({ scenario: { installed: false }, fetcher: fakeFetch() });

    expect(await funnelCommand({}, h.deps)).toBe(1);
    expect(output(h.said)).toContain('→ brew install --cask tailscale');
    expect(h.calls.map((call) => call.args.join(' '))).not.toContain('status --json');
  });

  it('asks for a running login when the daemon is stopped', async () => {
    const h = harness({ scenario: { running: false }, fetcher: fakeFetch() });

    expect(await funnelCommand({}, h.deps)).toBe(1);
    expect(output(h.said)).toContain('`tailscale up`');
  });

  it('points at MagicDNS when the node has no DNS name', async () => {
    const h = harness({ scenario: { dns: undefined }, fetcher: fakeFetch() });

    expect(await funnelCommand({}, h.deps)).toBe(1);
    expect(output(h.said)).toContain('MagicDNS를 켜 주세요: https://login.tailscale.com/admin/dns');
    expect(h.fetcher.urls.some((url) => url.startsWith('https://'))).toBe(false);
  });

  it('detects disabled HTTPS certificates from the funnel status error text', async () => {
    const h = harness({
      scenario: { funnel: () => ({ code: 1, stdout: '', stderr: 'failed to enable HTTPS: no certificate' }) },
      fetcher: fakeFetch(),
    });

    expect(await funnelCommand({}, h.deps)).toBe(1);
    const text = output(h.said);
    expect(text).toContain('✗ HTTPS 인증서');
    expect(text).toContain('HTTPS 인증서를 켜 주세요: https://login.tailscale.com/admin/dns');
  });

  it('points at the ACL page when the node may not use Funnel', async () => {
    const h = harness({
      scenario: {
        funnel: () => ({
          code: 1,
          stdout: '',
          stderr: 'funnel is not enabled for this node; nodeAttrs must include funnel',
        }),
      },
      fetcher: fakeFetch(),
    });

    expect(await funnelCommand({}, h.deps)).toBe(1);
    const text = output(h.said);
    expect(text).toContain('✗ 이 기기의 Funnel 권한');
    expect(text).toContain('https://login.tailscale.com/admin/acls');
    expect(text).toContain('nodeAttrs: funnel');
  });

  it('reports /m as not served and gives the exact command', async () => {
    const h = harness({
      scenario: { funnel: () => ({ code: 0, stdout: '|-- /other proxy http://127.0.0.1:47617/m', stderr: '' }) },
    });

    expect(await funnelCommand({}, h.deps)).toBe(1);
    const text = output(h.said);
    expect(text).toContain('✗ /m 경로 공개');
    expect(text).toContain('tailscale funnel --bg --set-path /m http://127.0.0.1:47617/m');
  });

  it('reports a local bridge that does not answer', async () => {
    const h = harness({
      fetcher: fakeFetch({ [`https://${DNS}/m/health`]: true }),
    });

    expect(await funnelCommand({}, h.deps)).toBe(1);
    expect(output(h.said)).toContain('ax-kit start');
  });

  it('says the phone cannot reach the public URL yet', async () => {
    const h = harness({
      fetcher: fakeFetch({ [`http://127.0.0.1:47617/m/health`]: true }),
    });

    expect(await funnelCommand({}, h.deps)).toBe(1);
    expect(output(h.said)).toContain('아직 휴대폰이 이 주소에 닿지 못해요');
  });

  it('uses the configured bridge port', async () => {
    const h = harness({ port: 5000, fetcher: healthyFetch(5000) });

    expect(await funnelCommand({}, h.deps)).toBe(0);
    expect(h.fetcher.urls).toContain('http://127.0.0.1:5000/m/health');
    expect(output(h.said)).toContain('✓ 로컬 브리지 (127.0.0.1:5000)');
  });
});

describe('ax-kit phone funnel --fix', () => {
  function scenarioWithFixablePath() {
    let served = false;
    return {
      scenario: {
        funnel: (calls: readonly Call[]): ExecResult => {
          const fixed = calls.some((call) => call.args.includes('--bg'));
          if (fixed) served = true;
          return served ? SERVED : { code: 0, stdout: '|-- /other proxy http://127.0.0.1:47617/m', stderr: '' };
        },
      } satisfies ExecScenario,
    };
  }

  it('asks first, runs only the /m command and re-checks', async () => {
    const h = harness({ ...scenarioWithFixablePath(), answers: ['1'] });

    expect(await funnelCommand({ fix: true }, h.deps)).toBe(0);

    const fixCall = h.calls.find((call) => call.args.includes('--bg'));
    expect(fixCall?.args).toEqual(['funnel', '--bg', '--set-path', '/m', 'http://127.0.0.1:47617/m']);
    expect(h.prompter.remaining()).toBe(0);
    expect(output(h.said)).toContain('Funnel 경로를 설정했어요. 다시 확인할게요.');
    expect(output(h.said)).toContain('✓ /m 경로 공개');
    expect(output(h.said)).toContain('모두 정상이에요');
  });

  it('keeps the default answer "leave it" and changes nothing', async () => {
    const h = harness({ ...scenarioWithFixablePath(), answers: ['2'] });

    expect(await funnelCommand({ fix: true }, h.deps)).toBe(1);
    expect(h.calls.some((call) => call.args.includes('--bg'))).toBe(false);
    expect(output(h.said)).toContain('그대로 두었어요');
  });

  it('never fixes when another step also fails', async () => {
    const h = harness({
      ...scenarioWithFixablePath(),
      fetcher: fakeFetch({ [`https://${DNS}/m/health`]: true }),
    });

    expect(await funnelCommand({ fix: true }, h.deps)).toBe(1);
    expect(h.calls.some((call) => call.args.includes('--bg'))).toBe(false);
    expect(h.prompter.remaining()).toBe(0);
  });

  it('does nothing without --fix', async () => {
    const h = harness(scenarioWithFixablePath());

    expect(await funnelCommand({}, h.deps)).toBe(1);
    expect(h.calls.some((call) => call.args.includes('--bg'))).toBe(false);
    expect(h.prompter.remaining()).toBe(0);
  });
});
