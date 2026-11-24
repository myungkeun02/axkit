import { describe, expect, it } from 'vitest';
import { CliBrowserAgent } from '../../../src/connectors/browser/cli-agent.js';
import { fakeRunner } from './helpers.js';

const BASE = { command: 'my-agent', timeoutMs: 60_000 };

describe('CliBrowserAgent', () => {
  it('substitutes {prompt} in the arguments instead of using stdin', async () => {
    const { run, calls } = fakeRunner({ stdout: 'RESULT: found it' });
    const agent = new CliBrowserAgent({ ...BASE, run, args: ['--prompt', '{prompt}'] });

    const result = await agent.run({ goal: 'Find the price', startUrl: 'https://example.com/item' });

    expect(result).toEqual({ status: 'done', summary: 'found it' });
    expect(calls[0]?.args).toHaveLength(2);
    expect(calls[0]?.args[0]).toBe('--prompt');
    expect(calls[0]?.args[1]).toContain('Task: Find the price');
    expect(calls[0]?.opts.input).toBeUndefined();
  });

  it('sends the prompt on stdin when there is no placeholder', async () => {
    const { run, calls } = fakeRunner({ stdout: 'RESULT: ok' });
    const agent = new CliBrowserAgent({ ...BASE, run, args: ['--quiet'] });

    await agent.run({ goal: 'Open the notice' });

    expect(calls[0]?.args).toEqual(['--quiet']);
    expect(calls[0]?.opts.input).toContain('Task: Open the notice');
    expect(calls[0]?.opts.input).toContain('HANDOFF: <login|payment|consent|captcha|other> <url>');
  });

  it('turns a HANDOFF line into needs_human', async () => {
    const { run } = fakeRunner({ stdout: 'HANDOFF: login https://example.com/login\n' });
    const agent = new CliBrowserAgent({ ...BASE, run, args: [] });

    const result = await agent.run({ goal: 'Check the order', startUrl: 'https://example.com/' });

    expect(result.status).toBe('needs_human');
    expect(result.handoff).toEqual({ reason: 'login', url: 'https://example.com/login' });
    expect(result.url).toBe('https://example.com/login');
  });

  it('treats an unknown handoff reason as other', async () => {
    const { run } = fakeRunner({ stdout: 'HANDOFF: magic https://example.com/\n' });
    const agent = new CliBrowserAgent({ ...BASE, run, args: [] });

    const result = await agent.run({ goal: 'Check the order', startUrl: 'https://example.com/' });

    expect(result.status).toBe('needs_human');
    expect(result.handoff).toEqual({ reason: 'other', url: 'https://example.com/' });
  });

  it('joins RESULT lines', async () => {
    const { run } = fakeRunner({ stdout: 'working\nRESULT: first line\nRESULT: second line\n' });
    const agent = new CliBrowserAgent({ ...BASE, run, args: [] });

    const result = await agent.run({ goal: 'Check', startUrl: 'https://example.com/' });

    expect(result).toEqual({ status: 'done', summary: 'first line\nsecond line' });
  });

  it('falls back to the last 3000 characters when there is no RESULT line', async () => {
    const { run } = fakeRunner({ stdout: 'a'.repeat(4000) });
    const agent = new CliBrowserAgent({ ...BASE, run, args: [] });

    const result = await agent.run({ goal: 'Check', startUrl: 'https://example.com/' });

    expect(result.status).toBe('done');
    expect(result.summary).toHaveLength(3000);
    expect(result.summary.startsWith('a')).toBe(true);
  });

  it('fails with the last 500 characters of stderr', async () => {
    const { run } = fakeRunner({ code: 2, stderr: 'b'.repeat(900) });
    const agent = new CliBrowserAgent({ ...BASE, run, args: [] });

    const result = await agent.run({ goal: 'Check', startUrl: 'https://example.com/' });

    expect(result.status).toBe('failed');
    expect(result.summary).toHaveLength(500);
  });

  it('fails on a timeout', async () => {
    const { run } = fakeRunner({ timedOut: true, stderr: 'took too long' });
    const agent = new CliBrowserAgent({ ...BASE, run, args: [] });

    const result = await agent.run({ goal: 'Check', startUrl: 'https://example.com/' });

    expect(result).toEqual({ status: 'failed', summary: 'took too long' });
  });

  it('reads through the fixed read goal', async () => {
    const { run, calls } = fakeRunner({ stdout: 'RESULT: page text' });
    const agent = new CliBrowserAgent({ ...BASE, run, args: [] });

    const result = await agent.read('https://example.com/notice');

    expect(result).toEqual({ status: 'done', summary: 'page text' });
    expect(calls[0]?.opts.input).toContain(
      'Open this page and report its visible text without clicking anything.',
    );
    expect(calls[0]?.opts.input).toContain('https://example.com/notice');
  });

  it('refuses a non-http read without running the CLI', async () => {
    const { run, calls } = fakeRunner();
    const agent = new CliBrowserAgent({ ...BASE, run, args: [] });

    const result = await agent.read('file:///etc/passwd');

    expect(result.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('opens a page with the macOS open command', async () => {
    const { run, calls } = fakeRunner();
    const agent = new CliBrowserAgent({ ...BASE, run, args: [] });

    await agent.openForHuman('https://example.com/login');

    expect(calls[0]?.cmd).toBe('open');
    expect(calls[0]?.args).toEqual(['https://example.com/login']);
  });

  it('throws when the open command fails', async () => {
    const { run } = fakeRunner({ code: 1 });
    const agent = new CliBrowserAgent({ ...BASE, run, args: [] });

    await expect(agent.openForHuman('https://example.com/login')).rejects.toThrow('Could not open');
  });

  it('labels itself with the command by default', () => {
    const { run } = fakeRunner();
    expect(new CliBrowserAgent({ ...BASE, run, args: [] }).label).toBe('my-agent');
  });
});
