import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp as makeTemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { nodeProcessRunner } from '../../../src/core/process/node-runner.js';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { devConfigSchema } from '../../../src/skills/dev-assist/config.js';
import { findLocalProjects } from '../../../src/skills/dev-assist/find-projects.js';
import { devContextSection, devReadiness } from '../../../src/skills/dev-assist/readiness.js';
import { addRepoTool, localSlug, remoteOf } from '../../../src/skills/dev-assist/repo-add.js';
import { parseLaunchctlList, serviceLogsTool, tailLines } from '../../../src/skills/dev-assist/services.js';
import { createTestContext } from '../../support/context.js';

const made: string[] = [];
/** Temp folders inside the real home (dev.add_repo only takes folders there), removed after the tests. */
const mkdtemp = async (prefix: string): Promise<string> => {
  const dir = await makeTemp(prefix);
  made.push(dir);
  return dir;
};
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd }).toString();

async function project(name: string, commit: boolean, origin?: string): Promise<string> {
  // inside the real home: dev.add_repo only takes folders there
  const base = await mkdtemp(join(homedir(), '.axk-test-'));
  const dir = join(base, name);
  await mkdir(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  if (commit) {
    sh(dir, 'add', '-A');
    sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  }
  if (origin !== undefined) sh(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

describe('the dev teams get set up by the assistant', () => {
  it('registers a folder already on this Mac in place, local-only or from GitHub', async () => {
    const context = createTestContext({});
    const config = devConfigSchema.parse({});
    const tool = addRepoTool(context.ctx, config, nodeProcessRunner);
    const local = await project('betalab-email-crm', true);
    const out = await tool.run({ path: local.replace(homedir(), '~') }, { grounding: [] } as never);
    expect(out).toMatchObject({ slug: 'local/betalab-email-crm', base: 'main', test: ['npm', 'test'] });
    expect(config.repos.map((repo) => repo.slug)).toEqual(['local/betalab-email-crm']);
    const github = await project('clipper', true, 'git@github.com:betalab-lab/clipper.git');
    expect((await tool.run({ path: github }, { grounding: [] } as never)).slug).toBe('betalab-lab/clipper');
    // a folder that was never committed has nothing to branch from: said plainly
    await expect(tool.run({ path: await project('empty', false) }, { grounding: [] } as never)).rejects.toThrow('no commits yet');
    await expect(tool.run({ path: '/etc' }, { grounding: [] } as never)).rejects.toThrow('home folder');
    expect(remoteOf('https://github.com/betalab-lab/workboard.git')).toBe('github.com/betalab-lab/workboard');
    expect(localSlug('/x/영수증 정리')).toMatch(/^local\//);
  });

  it('finds git projects in the usual folders, telling which have no commits', async () => {
    const home = await mkdtemp(join(homedir(), '.axk-home-'));
    for (const [name, commit] of [['a', true], ['b', false]] as const) {
      const dir = join(home, 'Documents', name);
      await mkdir(dir, { recursive: true });
      sh(dir, 'init', '-q', '-b', 'main');
      if (commit) sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
    }
    const found = await findLocalProjects(nodeProcessRunner, home);
    expect(found.map((item) => [item.name, item.hasCommits]).sort()).toEqual([['a', true], ['b', false]]);
  });

  it('tells every turn when dev teams have nothing to work on, and doctor says it too', async () => {
    const context = createTestContext({ capabilities: { [Contracts.bots.id]: { teams: async () => [{ id: 'team-crm', name: '메일 CRM 개발', kind: 'dev' }] } } });
    const config = devConfigSchema.parse({});
    expect(await devContextSection(context.ctx, config)('')).toContain('연결된 프로젝트: 없음');
    expect(await devReadiness(context.ctx, config).run(new Date())).toMatchObject([{ ok: false, fix: expect.stringContaining('연결해 줘') }]);
    const none = createTestContext({ capabilities: { [Contracts.bots.id]: { teams: async () => [] } } });
    expect(await devContextSection(none.ctx, config)('')).toBeUndefined();
  });
});

describe('service status and logs', () => {
  it('reads launchctl rows and the newest log lines, masking secrets', async () => {
    expect(parseLaunchctlList('PID\tStatus\tLabel\n12833\t143\tcom.betalab.web-v2\n-\t0\tcom.betalab.d1-backup\n')).toEqual(
      new Map([['com.betalab.web-v2', { pid: 12833, lastExit: 143 }], ['com.betalab.d1-backup', { lastExit: 0 }]]),
    );
    const dir = await mkdtemp(join(homedir(), '.axk-logs-'));
    const log = join(dir, 'server.log');
    await writeFile(log, ['start', 'GET / 200', 'ERROR db timeout token=sk-ant-abcdefghijklmnopqrstuvwxyz0123', 'GET /x 500'].join('\n'));
    expect(await tailLines(log, 2)).toEqual([expect.stringContaining('ERROR db timeout'), 'GET /x 500']);
    expect((await tailLines(log, 5, 'error'))[0]).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    const run: ProcessRunner = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false });
    const tool = serviceLogsTool(run, async () => [{ label: 'com.betalab.workboard', logs: [log] }]);
    expect(await tool.run({ service: 'workboard', lines: 1 }, { grounding: [] } as never)).toEqual({ logs: [{ service: 'com.betalab.workboard', path: log, lines: ['GET /x 500'] }] });
    expect((await tool.run({ service: 'nothing', lines: 5 }, { grounding: [] } as never)).message).toContain('No service');
  });
});
