import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/core/config/load.js';
import type { LlmRequest } from '../../src/core/llm/types.js';
import type { CliRunOptions, CliRunResult, CliRunner } from '../../src/core/llm/providers/cli.js';
import { createCliProvider } from '../../src/core/llm/providers/cli.js';

interface RunnerCall {
  cmd: string;
  args: readonly string[];
  stdin: string;
  opts: CliRunOptions;
}

function fakeRunner(result: Partial<CliRunResult> = {}): { run: CliRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const run: CliRunner = async (cmd, args, stdin, opts) => {
    calls.push({ cmd, args, stdin, opts });
    return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { run, calls };
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    purpose: 'assistant.turn',
    tier: 'standard',
    sensitivity: 'sensitive',
    messages: [
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'again' },
    ],
    ...overrides,
  };
}

function claudeResult(text: string, inputTokens = 12, outputTokens = 7): string {
  return JSON.stringify({ result: text, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
}

const CLAUDE_ARGS = [
  '-p',
  '--output-format',
  'json',
  '--model',
  'sonnet',
  '--tools',
  '',
  '--strict-mcp-config',
  '--setting-sources',
  'project',
  '--no-session-persistence',
];

const CODEX_FEATURES = [
  'shell_tool',
  'unified_exec',
  'code_mode_host',
  'apps',
  'plugins',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'multi_agent',
  'goals',
  'view_image',
  'hooks',
  'sleep_tool',
  'skill_search',
  'tool_suggest',
];

const CODEX_ARGS = [
  'exec',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--skip-git-repo-check',
  '--sandbox',
  'read-only',
  ...CODEX_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]),
  '-c',
  'mcp_servers={}',
  '-c',
  'web_search="disabled"',
  '--model',
  'gpt-5-codex',
  '-',
];

describe('claude-cli provider', () => {
  it('runs the CLI with tools disabled and sends the prompt on stdin', async () => {
    const fake = fakeRunner({ stdout: claudeResult('안녕하세요') });
    const provider = createCliProvider({ id: 'claude', kind: 'claude-cli', run: fake.run });

    const response = await provider.complete('sonnet', request());

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.cmd).toBe('claude');
    expect(call.args).toEqual(CLAUDE_ARGS);
    expect(call.args.some((arg) => arg.includes('Answer briefly.'))).toBe(false);
    expect(call.stdin).toContain('Answer briefly.');
    expect(call.stdin).toContain('User: hello');
    expect(call.stdin).toContain('Assistant: hi');
    expect(call.stdin).toContain('User: again');
    expect(call.opts.timeoutMs).toBe(120_000);
    expect(response).toEqual({
      text: '안녕하세요',
      providerId: 'claude',
      model: 'sonnet',
      usage: { inputTokens: 12, outputTokens: 7, costUsd: 0 },
    });
  });

  it('appends the JSON Schema instruction to the prompt', async () => {
    const fake = fakeRunner({ stdout: claudeResult('{"ok":true}') });
    const provider = createCliProvider({ id: 'claude', kind: 'claude-cli', run: fake.run });
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

    await provider.complete('sonnet', request({ jsonSchema: schema }));

    expect(fake.calls[0]?.stdin).toContain(
      `Respond with a single JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}`,
    );
  });

  it('honours a custom command, timeout and abort signal', async () => {
    const fake = fakeRunner({ stdout: claudeResult('ok') });
    const controller = new AbortController();
    const provider = createCliProvider({
      id: 'claude',
      kind: 'claude-cli',
      command: '/opt/homebrew/bin/claude',
      timeoutMs: 5_000,
      run: fake.run,
    });

    await provider.complete('haiku', request({ signal: controller.signal }));

    expect(fake.calls[0]?.cmd).toBe('/opt/homebrew/bin/claude');
    expect(fake.calls[0]?.opts.timeoutMs).toBe(5_000);
    expect(fake.calls[0]?.opts.signal?.aborted).toBe(false);

    // The runner sees the caller's abort through the combined signal.
    let passed: AbortSignal | undefined;
    const waiting = createCliProvider({
      id: 'claude',
      kind: 'claude-cli',
      run: async (_cmd, _args, _stdin, opts) => {
        passed = opts.signal;
        return await new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    const pending = waiting.complete('haiku', request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(passed?.aborted).toBe(true);
  });

  it('reports a non-zero exit with the first 200 characters of stderr and no prompt text', async () => {
    const stderr = 'failure detail '.repeat(40);
    const fake = fakeRunner({ code: 3, stderr });
    const provider = createCliProvider({ id: 'claude', kind: 'claude-cli', run: fake.run });

    const error = await provider.complete('sonnet', request()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('exit code 3');
    expect(message).toContain(stderr.trim().slice(0, 200));
    expect(message).not.toContain(stderr.trim().slice(0, 201));
    expect(message).not.toContain('hello');
  });

  it('asks the owner to log in when the CLI reports an auth failure', async () => {
    const fake = fakeRunner({ code: 1, stderr: 'Invalid API key · Please run /login' });
    const provider = createCliProvider({ id: 'claude', kind: 'claude-cli', run: fake.run });

    await expect(provider.complete('sonnet', request())).rejects.toThrow(/not logged in.*`claude`/s);
  });

  it('rejects an empty answer', async () => {
    const fake = fakeRunner({ stdout: claudeResult(''), stderr: 'nothing came back' });
    const provider = createCliProvider({ id: 'claude', kind: 'claude-cli', run: fake.run });

    await expect(provider.complete('sonnet', request())).rejects.toThrow(
      /empty answer: nothing came back/,
    );
  });

  it('rejects malformed JSON output', async () => {
    const fake = fakeRunner({ stdout: 'not json', stderr: 'parse trouble' });
    const provider = createCliProvider({ id: 'claude', kind: 'claude-cli', run: fake.run });

    await expect(provider.complete('sonnet', request())).rejects.toThrow(/invalid JSON: parse trouble/);
  });
});

describe('codex-cli provider', () => {
  it('runs codex exec in a read-only sandbox with user config and tools disabled', async () => {
    const fake = fakeRunner({ stdout: '  the answer \n' });
    const provider = createCliProvider({ id: 'codex', kind: 'codex-cli', run: fake.run });

    const response = await provider.complete('gpt-5-codex', request());

    const call = fake.calls[0]!;
    expect(call.cmd).toBe('codex');
    expect(call.args).toEqual(CODEX_ARGS);
    expect(call.args).not.toContain('--search');
    expect(call.stdin).toContain('User: hello');
    expect(response.text).toBe('the answer');
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it('suggests the login command on an auth failure', async () => {
    const fake = fakeRunner({ code: 1, stderr: 'Not authenticated. Run codex login.' });
    const provider = createCliProvider({ id: 'codex', kind: 'codex-cli', run: fake.run });

    await expect(provider.complete('gpt-5-codex', request())).rejects.toThrow(/not logged in.*codex login/s);
  });

  it('rejects an empty answer', async () => {
    const fake = fakeRunner({ stdout: '   \n', stderr: 'silence' });
    const provider = createCliProvider({ id: 'codex', kind: 'codex-cli', run: fake.run });

    await expect(provider.complete('gpt-5-codex', request())).rejects.toThrow(/empty answer: silence/);
  });
});

describe('CLI provider config', () => {
  it('accepts both CLI kinds and an optional command', () => {
    const config = parseConfig({
      version: 1,
      assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
      owner: { discordUserId: '12345678901234567' },
      llm: {
        providers: [
          { id: 'claude-cli', kind: 'claude-cli' },
          { id: 'codex-cli', kind: 'codex-cli', command: '/opt/homebrew/bin/codex' },
        ],
        routes: [
          { providerId: 'claude-cli', model: 'sonnet', tiers: ['standard'], maxSensitivity: 'sensitive' },
          { providerId: 'codex-cli', model: 'gpt-5-codex', tiers: ['fast'], maxSensitivity: 'sensitive' },
        ],
      },
    });

    expect(config.llm.providers.map((provider) => provider.kind)).toEqual(['claude-cli', 'codex-cli']);
    expect(config.llm.providers[1]?.command).toBe('/opt/homebrew/bin/codex');
    expect(config.llm.providers[0]?.priceIn).toBe(0);
  });
});
