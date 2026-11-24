import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { KnowledgeLine } from '../../../src/core/contracts/knowledge.js';
import type { QuestionRequest } from '../../../src/core/policy/questions.js';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { adoptCandidates, adoptRepo, detectTest, loadAdopted, registerAdoption, slugOf } from '../../../src/skills/dev-assist/adopt.js';
import { devConfigSchema } from '../../../src/skills/dev-assist/config.js';
import { createTestContext } from '../../support/context.js';

const line = (topic: string, key: string, text: string): KnowledgeLine => ({ area: 'project', topic, key, text, sources: [], at: '' });

describe('setting up repositories found in the first look', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ax-adopt-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('picks development projects with a GitHub origin that are not set up yet', () => {
    const config = devConfigSchema.parse({ repos: [{ slug: 'acme/known', path: '/x' }] });
    const projects = [
      line('web', 'remote', 'github.com/acme/acme-web'),
      line('web', 'kind', 'dev'),
      line('known', 'remote', 'github.com/acme/known'),
      line('brand', 'remote', 'github.com/studio/brand'),
      line('brand', 'kind', 'general'),
      line('lab', 'remote', 'gitlab.com/x/y'),
    ];
    expect(adoptCandidates(projects, config)).toEqual([{ remote: 'github.com/acme/acme-web', project: 'web' }]);
    expect(slugOf('github.com/acme/acme-web')).toBe('acme/acme-web');
    expect(slugOf('gitlab.com/x/y')).toBeUndefined();
  });

  it('works out the test command from the repository’s files', async () => {
    await mkdir(join(root, 'node'));
    await writeFile(join(root, 'node', 'package.json'), JSON.stringify({ scripts: { test: 'vitest' }, packageManager: 'pnpm@10.0.0' }));
    await mkdir(join(root, 'go'));
    await writeFile(join(root, 'go', 'go.mod'), 'module x');
    await mkdir(join(root, 'none'));
    expect(await detectTest(join(root, 'node'))).toEqual(['pnpm', 'test']);
    expect(await detectTest(join(root, 'go'))).toEqual(['go', 'test', './...']);
    expect(await detectTest(join(root, 'none'))).toBeUndefined();
  });

  it('clones with hooks off, registers it, keeps it across restarts and reports a failed clone', async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('clone')) {
        const target = args.at(-1) ?? '';
        if (target.includes('private')) return { code: 128, stdout: '', stderr: 'fatal: could not read Username', timedOut: false };
        await mkdir(join(target, '.git'), { recursive: true });
        await writeFile(join(target, 'go.mod'), 'module x');
      }
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'origin/develop\n', stderr: '', timedOut: false };
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    };
    const context = createTestContext();
    const config = devConfigSchema.parse({});
    const ok = await adoptRepo(context.ctx, config, run, { remote: 'github.com/acme/acme-web', project: 'web' }, root);
    expect(ok).toMatchObject({ slug: 'acme/acme-web', status: 'cloned', path: join(root, 'acme', 'acme-web') });
    expect(calls[0]).toEqual(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'clone', '--quiet', 'https://github.com/acme/acme-web.git', join(root, 'acme', 'acme-web')]);
    expect(config.repos).toEqual([{ slug: 'acme/acme-web', path: join(root, 'acme', 'acme-web'), base: 'develop', test: ['go', 'test', './...'], testTimeoutSeconds: 900 }]);
    expect((await adoptRepo(context.ctx, config, run, { remote: 'github.com/acme/acme-web', project: 'web' }, root)).status).toBe('present');
    const failed = await adoptRepo(context.ctx, config, run, { remote: 'github.com/acme/private-api', project: 'api' }, root);
    expect(failed).toMatchObject({ status: 'failed', detail: 'fatal: could not read Username' });
    const fresh = devConfigSchema.parse({});
    await loadAdopted(context.ctx, fresh);
    expect(fresh.repos.map((repo) => repo.slug)).toEqual(['acme/acme-web']);
  });

  it('asks once after the first look and sets up on yes', async () => {
    const asked: QuestionRequest[] = [];
    const notices: string[] = [];
    const context = createTestContext({
      capabilities: {
        [Contracts.questions.id]: { ask: async (request: QuestionRequest) => (asked.push(request), { status: 'answered', choice: 'yes', means: 'approved', reused: false }) },
        [Contracts.notifier.id]: { notify: async (notice: { text: string }) => void notices.push(notice.text) },
      },
    });
    const run: ProcessRunner = async () => ({ code: 128, stdout: '', stderr: 'fatal: no network', timedOut: false });
    registerAdoption(context.ctx, devConfigSchema.parse({}), run);
    await context.bus.emit('knowledge.scanned', { profile: [], projects: [line('web', 'remote', 'github.com/acme/acme-web'), line('web', 'kind', 'dev')] });
    expect(asked[0]?.summary).toBe('개발하던 프로젝트 1개를 이 맥에 받아서 여기서 개발할까요?');
    expect(notices[0]).toContain('gh auth login');
  });
});
