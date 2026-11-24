import { describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../../src/cli/service.js';
import { LAUNCHD_LABEL, logPaths, serviceInstall, serviceStatus, serviceUninstall } from '../../src/cli/service.js';

const HOME = '/Users/alex/.ax-kit';
const LAUNCH_AGENTS = '/Users/alex/Library/LaunchAgents';
const PLIST = `${LAUNCH_AGENTS}/${LAUNCHD_LABEL}.plist`;
const TARGET = `gui/501/${LAUNCHD_LABEL}`;

interface FakeResult {
  code?: number;
  stdout?: string;
  stderr?: string;
}

function fakeDeps() {
  const execCalls: { cmd: string; args: string[] }[] = [];
  const written: { path: string; text: string }[] = [];
  const removed: string[] = [];
  const made: string[] = [];
  const said: string[] = [];
  const results = new Map<string, FakeResult>();

  const deps: ServiceDeps = {
    home: HOME,
    launchAgentsDir: LAUNCH_AGENTS,
    uid: 501,
    nodePath: '/opt/node/bin/node',
    entry: '/Users/alex/projects/ax-kit/bin/ax-kit.mjs',
    async exec(cmd, args) {
      execCalls.push({ cmd, args });
      const result = results.get(args[0] ?? '') ?? {};
      return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    async writeFile(path, text) {
      written.push({ path, text });
    },
    async removeFile(path) {
      removed.push(path);
    },
    async mkdir(path) {
      made.push(path);
    },
    say(line) {
      said.push(line);
    },
  };

  return { deps, execCalls, written, removed, made, said, results };
}

describe('logPaths', () => {
  it('keeps both logs under the home logs directory', () => {
    expect(logPaths(HOME)).toEqual({
      dir: `${HOME}/logs`,
      out: `${HOME}/logs/ax-kit.out.log`,
      err: `${HOME}/logs/ax-kit.err.log`,
    });
  });
});

describe('serviceInstall', () => {
  it('writes the plist, reloads the agent and prints tips', async () => {
    const { deps, execCalls, written, made, said } = fakeDeps();

    await expect(serviceInstall(deps)).resolves.toBe(0);

    expect(made).toEqual([`${HOME}/logs`, LAUNCH_AGENTS]);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toBe(PLIST);
    expect(written[0]?.text).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(execCalls).toEqual([
      { cmd: 'launchctl', args: ['bootout', TARGET] },
      { cmd: 'launchctl', args: ['bootstrap', 'gui/501', PLIST] },
      { cmd: 'launchctl', args: ['kickstart', '-k', TARGET] },
    ]);
    expect(said.join('\n')).toContain(`${HOME}/logs/ax-kit.out.log`);
    expect(said.join('\n')).toContain('잠자기 끄기');
    expect(said.join('\n')).toContain('FileVault');
  });

  it('ignores a failing bootout before installing', async () => {
    const { deps, results, written } = fakeDeps();
    results.set('bootout', { code: 3, stderr: 'Boot-out failed: 3: No such process' });

    await expect(serviceInstall(deps)).resolves.toBe(0);
    expect(written).toHaveLength(1);
  });

  it('reports bootstrap stderr and fails', async () => {
    const { deps, results, said } = fakeDeps();
    results.set('bootstrap', { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' });

    await expect(serviceInstall(deps)).resolves.toBe(1);
    expect(said.join('\n')).toContain('Bootstrap failed: 5: Input/output error');
  });

  it('reports a failed kickstart and fails', async () => {
    const { deps, results, said } = fakeDeps();
    results.set('kickstart', { code: 1, stderr: 'Could not kickstart service' });

    await expect(serviceInstall(deps)).resolves.toBe(1);
    expect(said.join('\n')).toContain('Could not kickstart service');
  });
});

describe('serviceUninstall', () => {
  it('boots the agent out and removes the plist even when it was not loaded', async () => {
    const { deps, execCalls, removed, results } = fakeDeps();
    results.set('bootout', { code: 3, stderr: 'No such process' });

    await expect(serviceUninstall(deps)).resolves.toBe(0);
    expect(execCalls).toEqual([{ cmd: 'launchctl', args: ['bootout', TARGET] }]);
    expect(removed).toEqual([PLIST]);
  });
});

describe('serviceStatus', () => {
  it('prints the state, pid and log paths when loaded', async () => {
    const { deps, said, results } = fakeDeps();
    results.set('print', {
      stdout: `gui/501/${LAUNCHD_LABEL} = {\n\tstate = running\n\tpid = 123\n}\n`,
    });

    await expect(serviceStatus(deps)).resolves.toBe(0);
    const text = said.join('\n');
    expect(text).toContain('상태: running');
    expect(text).toContain('PID: 123');
    expect(text).toContain(`${HOME}/logs/ax-kit.err.log`);
  });

  it('says it is not loaded when launchctl print fails', async () => {
    const { deps, said, results, execCalls } = fakeDeps();
    results.set('print', { code: 113, stderr: 'Could not find service' });

    await expect(serviceStatus(deps)).resolves.toBe(1);
    expect(execCalls).toEqual([{ cmd: 'launchctl', args: ['print', TARGET] }]);
    expect(said.join('\n')).toContain('설치되어 있지 않거나 실행 중이 아니에요');
  });
});
