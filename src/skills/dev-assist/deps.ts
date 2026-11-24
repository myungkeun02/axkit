import type { LocalProject } from './find-projects.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ProcessRunner } from '../../core/process/types.js';
import type { Coder } from './coder.js';
import type { DevConfig } from './config.js';
import type { Git } from './git.js';
import type { GitHubApi } from './github.js';
import type { JobStore } from './jobs.js';
import type { DevTexts } from './locale.js';

export interface DevToolDeps {
  ctx: PluginContext;
  config: DevConfig;
  texts: DevTexts;
  store: JobStore;
  git: Git;
  github: GitHubApi;
  coder: Coder;
  run: ProcessRunner;
  workDir: string;
  /** Git projects on this Mac, for "not registered yet" in dev.repos. */
  findProjects?: () => Promise<LocalProject[]>;
}
