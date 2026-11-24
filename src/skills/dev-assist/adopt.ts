import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { KnowledgeLine } from '../../core/contracts/knowledge.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ProcessRunner } from '../../core/process/types.js';
import type { DevConfig, RepoConfig } from './config.js';

const ADOPTED_KEY = 'adopted';
const GITHUB = /^github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

const AdoptedSchema = z.array(z.object({ slug: z.string(), path: z.string(), base: z.string(), test: z.array(z.string()).optional(), project: z.string().optional() }));

export interface AdoptCandidate {
  /** "github.com/owner/repo". */
  remote: string;
  /** The knowledge project it came from. */
  project: string;
}

export function slugOf(remote: string): string | undefined {
  const match = GITHUB.exec(remote.trim());
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The repository's own way to run its tests, from the files it has; undefined when there is no clear one. */
export async function detectTest(dir: string): Promise<string[] | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string>; packageManager?: string };
    if (pkg.scripts?.['test'] !== undefined) {
      const manager = pkg.packageManager?.split('@')[0] ?? ((await exists(join(dir, 'pnpm-lock.yaml'))) ? 'pnpm' : (await exists(join(dir, 'yarn.lock'))) ? 'yarn' : 'npm');
      return [manager, 'test'];
    }
  } catch {
    // not a node project
  }
  if (await exists(join(dir, 'go.mod'))) return ['go', 'test', './...'];
  if (await exists(join(dir, 'Cargo.toml'))) return ['cargo', 'test'];
  if ((await exists(join(dir, 'pyproject.toml'))) || (await exists(join(dir, 'pytest.ini')))) return ['python3', '-m', 'pytest', '-q'];
  if (await exists(join(dir, 'Package.swift'))) return ['swift', 'test'];
  return undefined;
}

/** Development projects from the first look that have a GitHub origin and are not set up here yet. */
export function adoptCandidates(projects: readonly KnowledgeLine[], config: DevConfig): AdoptCandidate[] {
  const known = new Set(config.repos.map((repo) => repo.slug.toLowerCase()));
  const out: AdoptCandidate[] = [];
  for (const line of projects) {
    if (line.key !== 'remote') continue;
    const kind = projects.find((other) => other.topic === line.topic && other.key === 'kind')?.text;
    const slug = slugOf(line.text);
    if (kind === 'general' || slug === undefined || known.has(slug.toLowerCase()) || out.some((item) => item.remote === line.text)) continue;
    out.push({ remote: line.text, project: line.topic });
  }
  return out;
}

/** Repositories set up by the assistant itself, kept next to the ones written in config. */
export async function loadAdopted(ctx: PluginContext, config: DevConfig): Promise<void> {
  const parsed = AdoptedSchema.safeParse(await ctx.kv.get<unknown>(ADOPTED_KEY));
  if (!parsed.success) return;
  for (const repo of parsed.data) {
    if (config.repos.some((item) => item.slug === repo.slug)) continue;
    config.repos.push({ slug: repo.slug, path: repo.path, base: repo.base, ...(repo.test !== undefined ? { test: repo.test } : {}), testTimeoutSeconds: 900 } as RepoConfig);
  }
}

/**
 * Clones one repository into ~/.ax-kit/repos/<owner>/<name> with this Mac's own git credentials (never a token the
 * assistant holds), works out its test command and adds it to the development helper. Git hooks are off for the clone.
 */
export async function adoptRepo(ctx: PluginContext, config: DevConfig, run: ProcessRunner, candidate: AdoptCandidate, root = join(homedir(), '.ax-kit', 'repos')): Promise<{ slug: string; path: string; status: 'cloned' | 'present' | 'failed'; detail?: string }> {
  const slug = slugOf(candidate.remote);
  if (slug === undefined) return { slug: candidate.remote, path: '', status: 'failed', detail: 'GitHub 저장소만 받아 올 수 있어요' };
  const path = join(root, ...slug.split('/'));
  let status: 'cloned' | 'present' = 'present';
  if (!(await exists(join(path, '.git')))) {
    const result = await run('git', [...SAFE, 'clone', '--quiet', `https://github.com/${slug}.git`, path], { timeoutMs: 600_000, env: { GIT_TERMINAL_PROMPT: '0' } }).catch((error: unknown) => ({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : 'git failed', timedOut: false }));
    if (result.code !== 0) return { slug, path, status: 'failed', detail: result.stderr.split('\n').find((line) => line.trim() !== '')?.slice(0, 200) ?? 'git clone failed' };
    status = 'cloned';
  }
  const head = await run('git', ['-C', path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: 10_000 }).catch(() => undefined);
  const base = head?.code === 0 ? head.stdout.trim().replace(/^origin\//, '') || 'main' : 'main';
  const test = await detectTest(path);
  const entry = { slug, path, base, ...(test !== undefined ? { test } : {}), project: candidate.project };
  const stored = AdoptedSchema.safeParse(await ctx.kv.get<unknown>(ADOPTED_KEY));
  await ctx.kv.set(ADOPTED_KEY, [...(stored.success ? stored.data.filter((item) => item.slug !== slug) : []), entry]);
  if (!config.repos.some((item) => item.slug === slug)) config.repos.push({ slug, path, base, ...(test !== undefined ? { test } : {}), testTimeoutSeconds: 900 } as RepoConfig);
  return { slug, path, status };
}

/**
 * After the first look: development projects with a GitHub origin are offered once — "이 맥에 받아서 여기서 개발할까요?"
 * — and on yes cloned and registered, so the dev teams can work on them here.
 */
export function registerAdoption(ctx: PluginContext, config: DevConfig, run: ProcessRunner): void {
  ctx.bus.on('knowledge.scanned', async (scan) => {
    await offer(ctx, config, run, scan.projects);
  });
  // turned on after the first look (from its suggestions): the projects it already found are offered on start
  ctx.bus.on('app.started', () => {
    void (async () => {
      const lines = await ctx.tryUse(Contracts.knowledgeProfile)?.projectLines?.().catch(() => undefined);
      if (lines !== undefined) await offer(ctx, config, run, lines);
    })();
  });
}

async function offer(ctx: PluginContext, config: DevConfig, run: ProcessRunner, projects: readonly KnowledgeLine[]): Promise<void> {
  {
    const candidates = adoptCandidates(projects, config).slice(0, 10);
    if (candidates.length === 0) return;
    const questions = ctx.tryUse(Contracts.questions);
    if (questions === undefined) return;
    const korean = ctx.assistant.language !== 'en';
    const list = candidates.map((item) => `• ${item.project} (${item.remote})`).join('\n');
    const answer = await questions
      .ask({
        topic: `dev:adopt:${candidates.map((item) => item.remote).sort().join(',').slice(0, 120).replace(/[^A-Za-z0-9:._/,-]/g, '-')}`,
        summary: korean ? `개발하던 프로젝트 ${candidates.length}개를 이 맥에 받아서 여기서 개발할까요?` : `Set up ${candidates.length} development projects on this Mac?`,
        note: korean ? `${list}\n이 맥의 git 로그인으로 받아요. 받은 뒤 개발팀이 여기서 브랜치·커밋·초안 PR까지 하고, 병합은 하지 않아요.` : `${list}\nCloned with this Mac's git login; dev teams then work here up to draft PRs.`,
        choices: [
          { id: 'yes', label: korean ? '받아서 여기서 개발' : 'Set them up', tone: 'primary', means: 'approved' },
          { id: 'no', label: korean ? '괜찮아요' : 'No thanks', means: 'denied' },
        ],
        effects: ['write'],
        askedBy: 'skill.dev-assist',
      })
      .catch(() => undefined);
    if (answer?.status !== 'answered' || answer.means !== 'approved' || answer.reused) return;
    const results = [];
    for (const candidate of candidates) results.push(await adoptRepo(ctx, config, run, candidate));
    const ok = results.filter((item) => item.status !== 'failed');
    const failed = results.filter((item) => item.status === 'failed');
    const text = korean
      ? `저장소 ${ok.length}개를 이 맥에 준비했어요${ok.length > 0 ? `: ${ok.map((item) => item.slug).join(', ')}` : ''}.${failed.length > 0 ? `\n받지 못한 것: ${failed.map((item) => `${item.slug} (${item.detail ?? ''})`).join(', ')}. 이 맥에서 \`gh auth login\` 후 \`gh auth setup-git\`을 해 주세요.` : ''}`
      : `Set up ${ok.length} repositories here.${failed.length > 0 ? ` Failed: ${failed.map((item) => item.slug).join(', ')} — run \`gh auth login\` and \`gh auth setup-git\`.` : ''}`;
    await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'dev.adopt', text }).catch(() => undefined);
  }
}
