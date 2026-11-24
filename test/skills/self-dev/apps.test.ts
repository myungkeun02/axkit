import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeProcessRunner } from '../../../src/core/process/node-runner.js';
import type { Coder } from '../../../src/skills/dev-assist/coder.js';
import type { AppRepo } from '../../../src/skills/self-dev/apps.js';
import { appsReport, detectApps } from '../../../src/skills/self-dev/apps.js';
import { runSelfDev } from '../../../src/skills/self-dev/job.js';

async function gitRepo(dir: string, file: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  sh('init', '-q', '-b', 'main');
  await writeFile(join(dir, file), 'one\n');
  await writeFile(join(dir, '.gitignore'), 'node_modules\n');
  sh('add', '-A');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
}

async function setup(checks: AppRepo['checks']) {
  const base = await mkdtemp(join(tmpdir(), 'axk-apps-'));
  const root = join(base, 'ax-kit');
  await gitRepo(root, 'server.txt');
  await mkdir(join(root, 'node_modules'));
  const desktop = join(base, 'ax-kit-desktop');
  await gitRepo(desktop, 'app.txt');
  const app: AppRepo = { name: 'desktop', label: '맥 데스크톱 앱', path: desktop, stack: 'Tauri', checks, env: {}, install: '업무용 맥에 새 버전을 깔려면 …' };
  return { base, root, desktop, app };
}

/** A coder that changes only the desktop app (the first extra folder it was given). */
const appCoder: Coder = {
  write: async ({ dir, extraDirs, instructions }) => {
    const target = instructions.includes('fixing the') ? dir : (extraDirs?.[0] ?? dir);
    await writeFile(join(target, 'app.txt'), 'two\n');
    return { ok: true, log: '요약: 데스크톱 앱 문구를 바꿨어요\n사람이 할 일: 없음' };
  },
};

describe('the ax 개선 room changes the apps too', () => {
  it('checks, merges an app-only change into the app repo and does not restart the server', async () => {
    const { base, root, desktop, app } = await setup([['true']]);
    const outcome = await runSelfDev({ root, workDir: join(base, 'work'), run: nodeProcessRunner, coder: appCoder, checks: [['true']], boot: false, apps: [app] }, 'sd-app1', '데스크톱 앱 문구 바꿔 줘');
    expect(outcome).toMatchObject({ status: 'applied', restart: false, commit: '' });
    expect(await readFile(join(desktop, 'app.txt'), 'utf8')).toBe('two\n');
    expect(await readFile(join(root, 'server.txt'), 'utf8')).toBe('one\n');
    if (outcome.status === 'applied') expect(appsReport(outcome.apps ?? [])).toContain('맥 데스크톱 앱: 적용했어요');
    expect(execFileSync('git', ['branch', '--list', 'ax-self/*'], { cwd: desktop }).toString().trim()).toBe('');
  });

  it('keeps an app change that fails its checks on its branch, unmerged', async () => {
    const { base, root, desktop, app } = await setup([['false']]);
    const outcome = await runSelfDev({ root, workDir: join(base, 'work'), run: nodeProcessRunner, coder: appCoder, checks: [['true']], boot: false, apps: [app] }, 'sd-app2', '데스크톱 앱 고쳐');
    expect(outcome.status).toBe('applied');
    if (outcome.status === 'applied') expect(outcome.apps?.[0]?.status).toBe('failed');
    expect(await readFile(join(desktop, 'app.txt'), 'utf8')).toBe('one\n');
    expect(execFileSync('git', ['branch', '--list', 'ax-self/*'], { cwd: desktop }).toString()).toContain('ax-self/sd-app2');
  });

  it('finds no apps where there are none', async () => {
    expect(await detectApps(nodeProcessRunner, await mkdtemp(join(tmpdir(), 'axk-noapps-')))).toEqual([]);
  });
});

describe('a stop in the ax 개선 room is a stop', () => {
  it('stopped while coding or checking: nothing is applied, the work stays on its branch, the worktree goes', async () => {
    const { base, root, desktop, app } = await setup([['true']]);
    const controller = new AbortController();
    const coder: Coder = {
      write: async ({ dir }) => {
        await writeFile(join(dir, 'server.txt'), 'two\n');
        controller.abort();
        return { ok: true, log: '요약: 바꿨어요' };
      },
    };
    const outcome = await runSelfDev({ root, workDir: join(base, 'work'), run: nodeProcessRunner, coder, checks: [['true']], boot: false, apps: [app] }, 'sd-stop', '바꿔 줘', controller.signal);
    expect(outcome.status).toBe('failed');
    expect(await readFile(join(root, 'server.txt'), 'utf8')).toBe('one\n');
    expect(execFileSync('git', ['worktree', 'list'], { cwd: root }).toString()).not.toContain('sd-stop');
    expect(execFileSync('git', ['worktree', 'list'], { cwd: desktop }).toString()).not.toContain('sd-stop');
  });
});
