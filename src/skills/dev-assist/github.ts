import { z } from 'zod';
import { errorMessage, isRecord } from './text.js';

const API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;
const USER_AGENT = 'ax-kit/0.1 (personal assistant)';

export const GITHUB_TOKEN_MISSING = 'GitHub token missing: run `ax-kit secret set github.token`';

export interface GitHubApiOptions {
  fetch: typeof fetch;
  /** Read lazily: the token is only fetched when a request needs it. */
  token: () => Promise<string | undefined>;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

export interface NewPullRequest {
  slug: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.string(),
  pull_request: z.unknown().optional(),
});

const pullSchema = z.object({ number: z.number().int(), html_url: z.string() });

function pathOf(slug: string): string {
  return slug
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function messageOf(data: unknown, fallback: string): string {
  if (isRecord(data) && typeof data.message === 'string') return data.message.slice(0, 300);
  return fallback;
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Minimal GitHub REST client: issues and draft pull requests only. It has no merge method by design. */
export class GitHubApi {
  private readonly fetchImpl: typeof fetch;
  private readonly token: () => Promise<string | undefined>;

  constructor(options: GitHubApiOptions) {
    this.fetchImpl = options.fetch;
    this.token = options.token;
  }

  async listIssues(slug: string, limit = 20): Promise<GitHubIssue[]> {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 30);
    const data = await this.request('GET', `/repos/${pathOf(slug)}/issues?state=open&per_page=${capped}`);
    if (!Array.isArray(data)) throw new Error('GitHub API returned an unexpected issue list.');
    const issues: GitHubIssue[] = [];
    for (const item of data) {
      const parsed = issueSchema.safeParse(item);
      if (!parsed.success || parsed.data.pull_request !== undefined) continue;
      issues.push({
        number: parsed.data.number,
        title: parsed.data.title,
        body: parsed.data.body ?? '',
        url: parsed.data.html_url,
      });
      if (issues.length >= capped) break;
    }
    return issues;
  }

  async getIssue(slug: string, number: number): Promise<GitHubIssue> {
    if (!Number.isInteger(number) || number <= 0) throw new Error('Issue numbers are positive integers.');
    const data = await this.request('GET', `/repos/${pathOf(slug)}/issues/${number}`);
    const parsed = issueSchema.safeParse(data);
    if (!parsed.success) throw new Error('GitHub API returned an unexpected issue.');
    if (parsed.data.pull_request !== undefined) throw new Error('That number is a pull request, not an issue.');
    return {
      number: parsed.data.number,
      title: parsed.data.title,
      body: parsed.data.body ?? '',
      url: parsed.data.html_url,
    };
  }

  async createPullRequest(pr: NewPullRequest): Promise<PullRequestRef> {
    const data = await this.request('POST', `/repos/${pathOf(pr.slug)}/pulls`, {
      title: pr.title,
      body: pr.body,
      head: pr.head,
      base: pr.base,
      draft: true,
    });
    const parsed = pullSchema.safeParse(data);
    if (!parsed.success) throw new Error('GitHub API returned an unexpected pull request.');
    return { number: parsed.data.number, url: parsed.data.html_url };
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const token = await this.token();
    if (token === undefined || token.trim() === '') throw new Error(GITHUB_TOKEN_MISSING);

    let response: Response;
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${token}`,
          'user-agent': USER_AGENT,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new Error(`GitHub request failed: ${errorMessage(error)}`);
    }

    const data = parseBody(await response.text());
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${messageOf(data, response.statusText)}`);
    }
    return data;
  }
}
