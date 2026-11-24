import { describe, expect, it } from 'vitest';
import { GITHUB_TOKEN_MISSING, GitHubApi } from '../../../src/skills/dev-assist/github.js';
import { FakeFetch, TOKEN, issue, json } from './helpers.js';

function api(fake: FakeFetch, token: string | null = TOKEN): GitHubApi {
  return new GitHubApi({ fetch: fake.fetch, token: async () => token ?? undefined });
}

describe('GitHubApi', () => {
  it('sends the bearer token and API version headers', async () => {
    const fake = new FakeFetch();
    fake.handler = () => json([issue(1, 'Bug')]);

    await api(fake).listIssues('owner/example', 5);

    const headers = new Headers(fake.calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('accept')).toBe('application/vnd.github+json');
    expect(headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(fake.calls[0]?.url).toContain('/repos/owner/example/issues?state=open&per_page=5');
  });

  it('drops pull requests from the issue list and caps the limit', async () => {
    const fake = new FakeFetch();
    fake.handler = () =>
      json([issue(1, 'Bug'), { ...issue(2, 'A PR'), pull_request: { url: 'x' } }, issue(3, 'Feature')]);

    const issues = await api(fake).listIssues('owner/example', 99);

    expect(issues.map((entry) => entry.number)).toEqual([1, 3]);
    expect(fake.calls[0]?.url).toContain('per_page=30');
  });

  it('reads one issue and turns a null body into an empty string', async () => {
    const fake = new FakeFetch();
    fake.handler = () => json({ ...issue(7, 'Crash on start'), body: null });

    const found = await api(fake).getIssue('owner/example', 7);

    expect(found).toEqual({
      number: 7,
      title: 'Crash on start',
      body: '',
      url: 'https://github.com/owner/example/issues/7',
    });
  });

  it('refuses a pull request number in getIssue', async () => {
    const fake = new FakeFetch();
    fake.handler = () => json({ ...issue(7, 'A PR'), pull_request: { url: 'x' } });

    await expect(api(fake).getIssue('owner/example', 7)).rejects.toThrow('not an issue');
  });

  it('opens a draft pull request and returns its number and URL', async () => {
    const fake = new FakeFetch();
    fake.handler = () => json({ number: 12, html_url: 'https://github.com/owner/example/pull/12' });

    const pr = await api(fake).createPullRequest({
      slug: 'owner/example',
      head: 'ax-kit/fix-abc123',
      base: 'main',
      title: 'Fix it',
      body: 'Body',
    });

    expect(pr).toEqual({ number: 12, url: 'https://github.com/owner/example/pull/12' });
    const post = fake.posts()[0];
    expect(post?.url).toContain('/repos/owner/example/pulls');
    const body = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ draft: true, head: 'ax-kit/fix-abc123', base: 'main', title: 'Fix it', body: 'Body' });
  });

  it('reports a missing token without calling the network', async () => {
    const fake = new FakeFetch();

    await expect(api(fake, null).listIssues('owner/example')).rejects.toThrow(GITHUB_TOKEN_MISSING);
    expect(fake.calls).toHaveLength(0);
  });

  it('reports a non-2xx status with GitHub\'s message and never the token', async () => {
    const fake = new FakeFetch();
    fake.handler = () => json({ message: 'Not Found' }, 404);

    let message = '';
    try {
      await api(fake).getIssue('owner/example', 99);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('GitHub API 404: Not Found');
    expect(message).not.toContain(TOKEN);
  });

  it('has no merge or delete method', () => {
    const methods = Object.getOwnPropertyNames(GitHubApi.prototype);
    expect(methods).not.toContain('merge');
    expect(methods).not.toContain('delete');
    expect(methods.filter((name) => /merge|delete/i.test(name))).toEqual([]);
  });
});
