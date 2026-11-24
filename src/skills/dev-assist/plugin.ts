import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LlmGateway } from '../../core/llm/types.js';
import type { Plugin } from '../../core/plugin/types.js';
import { Contracts } from '../../core/contracts/index.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { ProcessRunner } from '../../core/process/types.js';
import { ClaudeCliCoder, CodexCliCoder } from './coder.js';
import type { Coder } from './coder.js';
import { readDevConfig } from './config.js';
import type { DevConfig } from './config.js';
import type { DevToolDeps } from './deps.js';
import { Git } from './git.js';
import { GitHubApi } from './github.js';
import { JobStore } from './jobs.js';
import { devTexts } from './locale.js';
import { LlmCoder } from './llm-coder.js';
import { DevRunner } from './background.js';
import type { FinishedTask } from './run-task.js';
import { devIssuesTool, devJobsTool, devReposTool, devResumeTool, devStartTool } from './tools.js';
import { devDiscardTool, devKeepTool, devOpenPrTool } from './tools-pr.js';
import { nodeCoderFs } from './workspace.js';
import { loadAdopted, registerAdoption } from './adopt.js';
import { Autopilot, autopilotTool } from './autopilot.js';
import { findLocalProjects } from './find-projects.js';
import type { LocalProject } from './find-projects.js';
import { devContextSection, devReadiness } from './readiness.js';
import { addRepoTool } from './repo-add.js';
import { serviceListTool, serviceLogsTool } from './services.js';

export interface DevAssistOptions {
  /** Root for job worktrees; defaults to ~/.ax-kit/dev. */
  workDir?: string;
  run?: ProcessRunner;
  fetch?: typeof fetch;
  /** Called with each finished job (tests wait on it). */
  onFinished?: (result: FinishedTask) => void;
  findProjects?: () => Promise<LocalProject[]>;
}

function createCoder(config: DevConfig, run: ProcessRunner, llm: LlmGateway): Coder {
  const timeoutMs = config.coderTimeoutSeconds * 1000;
  const command = config.coderCommand !== undefined ? { command: config.coderCommand } : {};
  switch (config.coder) {
    case 'codex-cli':
      return new CodexCliCoder({ run, timeoutMs, ...command });
    case 'llm':
      return new LlmCoder({ llm, run, fs: nodeCoderFs });
    case 'claude-cli':
      return new ClaudeCliCoder({ run, timeoutMs, ...command });
  }
}

/** Request or issue to a local branch and commit; a separate confirmed tool opens the draft PR. */
export function devAssistSkill(options: DevAssistOptions = {}): Plugin {
  return {
    manifest: {
      id: 'skill.dev-assist',
      kind: 'skill',
      title: 'Developer helper (branch, commit, draft PR; never merges)',
      secrets: ['github.token'],
    },
    async setup(ctx) {
      const config = readDevConfig(ctx);
      // repositories the assistant set up itself (from the first look) join the ones in config
      await loadAdopted(ctx, config);
      const texts = devTexts(ctx.assistant.language);
      const run = options.run ?? nodeProcessRunner;
      const store = new JobStore(ctx.kv, ctx.log);
      // jobs left running or queued by a crash or restart become "interrupted"; the owner hears it once
      await store.load(ctx.clock.now().toISOString());

      const deps: DevToolDeps = {
        ctx,
        config,
        texts,
        store,
        git: new Git(run),
        github: new GitHubApi({
          fetch: options.fetch ?? globalThis.fetch,
          token: () => ctx.secrets.get('github.token'),
        }),
        coder: createCoder(config, run, ctx.llm),
        run,
        workDir: options.workDir ?? join(homedir(), '.ax-kit', 'dev'),
        findProjects: options.findProjects ?? (() => findLocalProjects(run)),
      };

      ctx.registerTool(devReposTool(deps));
      ctx.registerTool(devIssuesTool(deps));
      // the coder plus the slowest test run, plus a few minutes for git
      const timeoutMs =
        (config.coderTimeoutSeconds + Math.max(0, ...config.repos.map((repo) => repo.testTimeoutSeconds)) + 300) * 1000;
      // the autopilot needs the runner, and hears about the runner's finished jobs
      const finished: { to?: (result: FinishedTask) => Promise<void> } = {};
      const runner = new DevRunner(deps, {
        timeoutMs,
        onFinished: (result) => {
          options.onFinished?.(result);
          void finished.to?.(result).catch(() => undefined);
        },
      });
      const pilot = new Autopilot({ deps, runner });
      finished.to = (result) => pilot.finished(result);
      ctx.registerTool(autopilotTool(pilot, deps));
      ctx.scheduler.add({ name: 'dev.autopilot', label: ctx.assistant.language === 'en' ? 'Dev teams work by themselves' : '개발 팀 스스로 개발', schedule: { kind: 'every', seconds: 300 }, run: (now) => pilot.tick(now) });

      ctx.registerTool(devStartTool(deps, runner));
      ctx.registerTool(devResumeTool(deps, runner));
      ctx.registerTool(devJobsTool(deps));
      ctx.registerTool(devOpenPrTool(deps));
      ctx.registerTool(devDiscardTool(deps));
      ctx.registerTool(devKeepTool(deps));
      ctx.registerTool(addRepoTool(ctx, config, run));
      ctx.registerTool(serviceListTool(run));
      ctx.registerTool(serviceLogsTool(run));
      ctx.tryUse(Contracts.health)?.register(devReadiness(ctx, config));
      // the assistant plugin may start after this one: add the section once everything is up
      ctx.bus.on('app.started', () => ctx.tryUse(Contracts.assistantContext)?.addSection('dev.readiness', devContextSection(ctx, config)));
      registerAdoption(ctx, config, run);
    },
  };
}
