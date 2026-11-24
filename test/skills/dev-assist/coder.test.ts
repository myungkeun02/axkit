import { describe, expect, it } from 'vitest';
import { ClaudeCliCoder, CodexCliCoder } from '../../../src/skills/dev-assist/coder.js';
import { FakeRunner, TOKEN } from './helpers.js';

const PROMPT = 'Owner request:\nFix the bug';

describe('CLI coders', () => {
  it('runs Claude Code with edit tools only and feeds the prompt through stdin', async () => {
    const runner = new FakeRunner();

    const result = await new ClaudeCliCoder({ run: runner.run, timeoutMs: 60_000 }).write({
      dir: '/work/job_1',
      instructions: PROMPT,
    });

    expect(result.ok).toBe(true);
    const call = runner.calls[0];
    expect(call?.cmd).toBe('claude');
    expect(call?.args).toEqual([
      '-p',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read Edit Write Grep Glob',
      '--disallowedTools',
      'Bash WebFetch WebSearch',
      '--strict-mcp-config',
      '--no-session-persistence',
    ]);
    expect(call?.args).not.toContain('Bash');
    expect(call?.opts.cwd).toBe('/work/job_1');
    expect(call?.opts.input).toBe(PROMPT);
    expect(call?.opts.timeoutMs).toBe(60_000);
  });

  it('runs Codex CLI sandboxed to the workspace with the prompt through stdin', async () => {
    const runner = new FakeRunner();

    await new CodexCliCoder({ run: runner.run, timeoutMs: 30_000 }).write({
      dir: '/work/job_1',
      instructions: PROMPT,
    });

    const call = runner.calls[0];
    expect(call?.cmd).toBe('codex');
    expect(call?.args).toEqual(['exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-']);
    expect(call?.opts.cwd).toBe('/work/job_1');
    expect(call?.opts.input).toBe(PROMPT);
  });

  it('accepts a configured command', async () => {
    const runner = new FakeRunner();

    await new ClaudeCliCoder({ run: runner.run, command: '/opt/claude', timeoutMs: 1_000 }).write({
      dir: '/work/job_1',
      instructions: PROMPT,
    });

    expect(runner.calls[0]?.cmd).toBe('/opt/claude');
  });

  it('reports a non-zero exit and masks the log', async () => {
    const runner = new FakeRunner().on(() => true, {
      code: 2,
      stdout: 'partial',
      stderr: `token ${TOKEN} rejected`,
    });

    const result = await new ClaudeCliCoder({ run: runner.run, timeoutMs: 1_000 }).write({
      dir: '/work/job_1',
      instructions: PROMPT,
    });

    expect(result.ok).toBe(false);
    expect(result.log).toContain('[masked]');
    expect(result.log).not.toContain(TOKEN);
  });

  it('keeps only the last 4000 characters of the log', async () => {
    const runner = new FakeRunner().on(() => true, { stdout: 'a'.repeat(10_000) });

    const result = await new ClaudeCliCoder({ run: runner.run, timeoutMs: 1_000 }).write({
      dir: '/work/job_1',
      instructions: PROMPT,
    });

    expect(result.log).toHaveLength(4_000);
  });

  it('treats a timeout as a failure', async () => {
    const runner = new FakeRunner().on(() => true, { code: 0, timedOut: true });

    const result = await new CodexCliCoder({ run: runner.run, timeoutMs: 1_000 }).write({
      dir: '/work/job_1',
      instructions: PROMPT,
    });

    expect(result.ok).toBe(false);
  });
});
