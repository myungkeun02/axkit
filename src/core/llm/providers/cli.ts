import type { ChatMessage, LlmProvider, LlmRequest, LlmResponse, Tier } from '../types.js';
import type { DeadlineConfig } from './deadline.js';
import { deadlineFor, withDeadline } from './deadline.js';

export type CliKind = 'claude-cli' | 'codex-cli';

export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs a CLI command with the prompt on stdin, so the prompt never shows up in `ps`. */
export type CliRunner = (
  cmd: string,
  args: string[],
  stdin: string,
  opts: CliRunOptions,
) => Promise<CliRunResult>;

export interface CliProviderOptions {
  id: string;
  kind: CliKind;
  /** Executable name or path; defaults to "claude" or "codex". */
  command?: string;
  run: CliRunner;
  /** One number for every tier, or one per tier. */
  timeoutMs?: DeadlineConfig;
}

const DEFAULT_COMMAND: Record<CliKind, string> = { 'claude-cli': 'claude', 'codex-cli': 'codex' };
const LOGIN_COMMAND: Record<CliKind, string> = { 'claude-cli': 'claude', 'codex-cli': 'codex login' };
const LABEL: Record<CliKind, string> = { 'claude-cli': 'Claude Code CLI', 'codex-cli': 'Codex CLI' };
/** A CLI starts a whole agent process per call, so it gets more room than an HTTP call. */
const CLI_DEADLINES_MS: Readonly<Record<Tier, number>> = { cheap: 120_000, fast: 120_000, standard: 120_000, deep: 300_000 };
/** The runner enforces the timeout itself; this backstop only matters for a runner that never settles. */
const MAX_RUNNER_GRACE_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stderrDetail(stderr: string): string {
  const text = stderr.trim().slice(0, 200);
  return text.length > 0 ? text : 'no error output';
}

function schemaInstruction(schema: Record<string, unknown>): string {
  return `Respond with a single JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}`;
}

function buildPrompt(messages: readonly ChatMessage[], schema: Record<string, unknown> | undefined): string {
  const parts = messages.filter((message) => message.role === 'system').map((message) => message.content);
  for (const message of messages) {
    if (message.role === 'system') continue;
    parts.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`);
  }
  if (schema !== undefined) parts.push(schemaInstruction(schema));
  return parts.join('\n\n');
}

function claudeArgs(model: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    // No tools: the CLI must only return text, never act on the Mac. No MCP servers, no saved sessions,
    // and only project settings (the runner starts in an empty folder) so the user's own CLAUDE.md and
    // memory do not leak into the assistant.
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--no-session-persistence',
  ];
}

// Verified on codex-cli 0.163. User config, MCP servers, web access, shell and file tools must not
// reach the assistant: the CLI may only turn stdin into text.
const CODEX_DISABLED_FEATURES = [
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

function codexArgs(model: string): string[] {
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
  ];
  for (const feature of CODEX_DISABLED_FEATURES) args.push('-c', `features.${feature}=false`);
  args.push('-c', 'mcp_servers={}', '-c', 'web_search="disabled"', '--model', model, '-');
  return args;
}

function failed(kind: CliKind, result: CliRunResult): Error {
  if (/log ?in|auth/i.test(result.stderr)) {
    return new Error(
      `${LABEL[kind]} is not logged in. Run \`${LOGIN_COMMAND[kind]}\` once in a terminal, sign in, then try again.`,
    );
  }
  return new Error(`${LABEL[kind]} failed with exit code ${result.code}: ${stderrDetail(result.stderr)}`);
}

function parseClaude(stdout: string, result: CliRunResult): { text: string; inputTokens: number; outputTokens: number } {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`${LABEL['claude-cli']} returned invalid JSON: ${stderrDetail(result.stderr)}`);
  }
  if (!isRecord(data) || typeof data.result !== 'string') {
    throw new Error(`${LABEL['claude-cli']} returned an unexpected response: ${stderrDetail(result.stderr)}`);
  }
  const usage = isRecord(data.usage) ? data.usage : {};
  return {
    text: data.result,
    inputTokens: numberOrZero(usage.input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
  };
}

export function createCliProvider(opts: CliProviderOptions): LlmProvider {
  const command = opts.command ?? DEFAULT_COMMAND[opts.kind];
  return {
    id: opts.id,
    async complete(model: string, request: LlmRequest): Promise<LlmResponse> {
      const prompt = buildPrompt(request.messages, request.jsonSchema);
      const args = opts.kind === 'claude-cli' ? claudeArgs(model) : codexArgs(model);
      const timeoutMs = deadlineFor(request.tier, opts.timeoutMs, CLI_DEADLINES_MS);
      const result = await withDeadline(timeoutMs + Math.min(MAX_RUNNER_GRACE_MS, timeoutMs), request.signal, (signal) =>
        opts.run(command, args, prompt, { timeoutMs, signal }),
      );
      if (result.code !== 0) throw failed(opts.kind, result);

      if (opts.kind === 'claude-cli') {
        const parsed = parseClaude(result.stdout, result);
        if (parsed.text.trim().length === 0) {
          throw new Error(`${LABEL[opts.kind]} returned an empty answer: ${stderrDetail(result.stderr)}`);
        }
        return {
          text: parsed.text,
          providerId: opts.id,
          model,
          usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, costUsd: 0 },
        };
      }

      const text = result.stdout.trim();
      if (text.length === 0) {
        throw new Error(`${LABEL[opts.kind]} returned an empty answer: ${stderrDetail(result.stderr)}`);
      }
      return {
        text,
        providerId: opts.id,
        model,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    },
  };
}
