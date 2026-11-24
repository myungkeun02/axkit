import { describe, expect, it } from 'vitest';
import { Git, branchName, isManagedBranch, kebabTitle } from '../../../src/skills/dev-assist/git.js';
import { FakeRunner, TOKEN } from './helpers.js';

describe('branch names', () => {
  it('builds ax-kit/<kebab>-<hex>', () => {
    expect(branchName('Fix the login bug', 'abc123')).toBe('ax-kit/fix-the-login-bug-abc123');
  });

  it('clips the kebab part to 40 characters', () => {
    const long = 'A very long title that keeps going and going past the limit';
    expect(kebabTitle(long).length).toBeLessThanOrEqual(40);
    expect(branchName(long, 'abc123').length).toBeLessThanOrEqual(7 + 40 + 1 + 6);
  });

  it('falls back to task when the title has no usable characters', () => {
    expect(branchName('한글 제목', 'abc123')).toBe('ax-kit/task-abc123');
    expect(branchName('!!!', 'abc123')).toBe('ax-kit/task-abc123');
  });

  it('rejects a bad suffix', () => {
    expect(() => branchName('Fix', 'xyz')).toThrow('six hex');
    expect(() => branchName('Fix', 'ABC123')).toThrow('six hex');
  });

  it('only manages ax-kit branches', () => {
    expect(isManagedBranch('ax-kit/fix-abc123')).toBe(true);
    expect(isManagedBranch('feature/fix')).toBe(false);
    expect(isManagedBranch('main')).toBe(false);
    expect(isManagedBranch('ax-kit/../evil')).toBe(false);
  });
});

describe('Git', () => {
  it('fetches the base and creates a worktree from origin/<base>', async () => {
    const runner = new FakeRunner();

    await new Git(runner.run).worktreeAdd('/repos/example', '/work/job_1', 'ax-kit/fix-abc123', 'main');

    expect(runner.calls.map((call) => call.args)).toEqual([
      ['-C', '/repos/example', 'remote', 'get-url', 'origin'],
      ['-C', '/repos/example', 'fetch', 'origin', 'main'],
      ['-C', '/repos/example', 'worktree', 'add', '-b', 'ax-kit/fix-abc123', '/work/job_1', 'origin/main'],
    ]);
  });

  it('starts from the local base branch for a project with no origin (it lives only on this Mac)', async () => {
    const runner = new FakeRunner().on((_cmd, args) => args.includes('get-url'), { code: 2, stderr: 'error: No such remote' });

    await new Git(runner.run).worktreeAdd('/repos/local', '/work/job_2', 'ax-kit/fix-abc123', 'main');

    expect(runner.calls.map((call) => call.args)).toEqual([
      ['-C', '/repos/local', 'remote', 'get-url', 'origin'],
      ['-C', '/repos/local', 'worktree', 'add', '-b', 'ax-kit/fix-abc123', '/work/job_2', 'main'],
    ]);
  });

  it('parses porcelain status, including untracked and renamed files', async () => {
    const runner = new FakeRunner().on(
      (_cmd, args) => args.includes('--porcelain'),
      { stdout: ' M src/a.ts\n?? test/b.test.ts\nR  old.ts -> new.ts\n' },
    );

    expect(await new Git(runner.run).changedFiles('/work/job_1')).toEqual([
      'src/a.ts',
      'test/b.test.ts',
      'new.ts',
    ]);
  });

  it('stages everything, commits and returns the sha', async () => {
    const runner = new FakeRunner().on((_cmd, args) => args.includes('rev-parse'), { stdout: 'deadbeef\n' });

    const sha = await new Git(runner.run).commitAll('/work/job_1', 'Fix it\n\nRequested via ax-kit');

    expect(sha).toBe('deadbeef');
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['-C', '/work/job_1', 'add', '-A'],
      ['-C', '/work/job_1', 'commit', '-m', 'Fix it\n\nRequested via ax-kit'],
      ['-C', '/work/job_1', 'rev-parse', 'HEAD'],
    ]);
  });

  it('truncates the diff to the requested size', async () => {
    const runner = new FakeRunner().on((_cmd, args) => args.includes('diff'), { stdout: 'x'.repeat(500) });

    expect(await new Git(runner.run).diff('/work/job_1', 10)).toHaveLength(10);
  });

  it('pushes only the job branch, without --force and with the token out of argv', async () => {
    const runner = new FakeRunner();

    await new Git(runner.run).push('/work/job_1', 'ax-kit/fix-abc123', TOKEN);

    const call = runner.calls[0];
    expect(call?.args).toEqual(['-C', '/work/job_1', 'push', 'origin', 'ax-kit/fix-abc123:ax-kit/fix-abc123']);
    expect(call?.args).not.toContain('--force');
    expect(call?.args.join(' ')).not.toContain(TOKEN);

    const env = call?.opts.env;
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
    });
    const header = env?.GIT_CONFIG_VALUE_1 ?? '';
    const prefix = 'AUTHORIZATION: basic ';
    expect(header.startsWith(prefix)).toBe(true);
    expect(Buffer.from(header.slice(prefix.length), 'base64').toString('utf8')).toBe(`x-access-token:${TOKEN}`);
  });

  it('refuses to push a branch it does not own', async () => {
    const runner = new FakeRunner();
    await expect(new Git(runner.run).push('/work/job_1', 'main', TOKEN)).rejects.toThrow('Invalid branch');
    expect(runner.calls).toHaveLength(0);
  });

  it('removes the worktree and deletes only ax-kit branches', async () => {
    const runner = new FakeRunner();
    const git = new Git(runner.run);

    await expect(git.worktreeRemove('/repos/example', '/work/job_1', 'main')).rejects.toThrow('Refusing');
    expect(runner.calls).toHaveLength(0);

    await git.worktreeRemove('/repos/example', '/work/job_1', 'ax-kit/fix-abc123');
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['-C', '/repos/example', 'worktree', 'remove', '--force', '/work/job_1'],
      ['-C', '/repos/example', 'branch', '-D', 'ax-kit/fix-abc123'],
    ]);
  });

  it('masks credentials in git error output', async () => {
    const runner = new FakeRunner().on(() => true, { code: 1, stderr: `failed for ${TOKEN}` });

    let message = '';
    try {
      await new Git(runner.run).changedFiles('/work/job_1');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('[masked]');
    expect(message).not.toContain(TOKEN);
  });
});
