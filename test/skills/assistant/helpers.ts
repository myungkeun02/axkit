import { z } from 'zod';
import type { IncomingMessage, MessageHandler, OutgoingMessage, Replier } from '../../../src/core/conversation/types.js';
import type { LlmRequest } from '../../../src/core/llm/types.js';
import type { ConfirmPolicyConfig } from '../../../src/core/policy/types.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import type { Tool } from '../../../src/core/tools/types.js';
import { assistantSkill } from '../../../src/skills/assistant/plugin.js';
import { ScriptedLlm, createTestContext } from '../../support/context.js';
import type { TestContext } from '../../support/context.js';

export const TEMPLATE = [
  'You are {{persona}} for {{owner}}.',
  'Tone: {{tone_rule}}',
  'Language: {{language}}',
  'Now: {{now}}',
  'Tools:',
  '{{tools}}',
].join('\n');

export type ScriptEntry = string | ((req: LlmRequest) => string);

export interface HarnessOptions {
  script: ScriptEntry[];
  config?: Record<string, unknown>;
  assistant?: Partial<PluginContext['assistant']>;
  now?: Date;
  policy?: ConfirmPolicyConfig;
  confirmer?: TestContext['confirmer'];
}

export interface Harness {
  ctx: PluginContext;
  test: TestContext;
  llm: ScriptedLlm;
  handler: MessageHandler;
  warnings: string[];
}

export async function makeHarness(opts: HarnessOptions): Promise<Harness> {
  const llm = new ScriptedLlm(opts.script);
  const test = createTestContext({
    llm,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.assistant !== undefined ? { assistant: opts.assistant } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
    ...(opts.confirmer !== undefined ? { confirmer: opts.confirmer } : {}),
  });
  const warnings: string[] = [];
  const ctx: PluginContext = {
    ...test.ctx,
    log: {
      ...test.ctx.log,
      warn: (message: string) => {
        warnings.push(message);
      },
    },
  };

  await assistantSkill({ loadSystemPrompt: async () => TEMPLATE }).setup(ctx);

  const handler = test.handlers[0];
  if (handler === undefined) throw new Error('assistant handler was not registered');
  return { ctx, test, llm, handler, warnings };
}

export function message(text: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'c1', address: 'a1' },
    authorId: 'owner',
    fromOwner: true,
    text,
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export interface RunResult {
  result: 'handled' | 'pass';
  replies: OutgoingMessage[];
}

export async function run(
  handler: MessageHandler,
  text: string,
  overrides: Partial<IncomingMessage> = {},
): Promise<RunResult> {
  const replies: OutgoingMessage[] = [];
  const replier: Replier = {
    reply: async (_to, outgoing) => {
      replies.push(outgoing);
    },
  };
  // like the router: work handed to afterTurn runs once the turn is over
  const later: (() => Promise<void>)[] = [];
  const result = await handler.handle(message(text, overrides), replier, { afterTurn: (work) => void later.push(work) });
  for (const work of later) await work();
  return { result, replies };
}

/** Serializes a plan the way a well-behaved model would. */
export function plan(
  reply: string,
  toolCalls: readonly { name: string; args: Record<string, unknown> }[] = [],
  question: { text: string; choices: string[] } | null = null,
): string {
  return JSON.stringify({ reply, tool_calls: toolCalls, question });
}

export interface NoteTool {
  tool: Tool<{ text: string }, { saved: string }>;
  /** Grounding seen by each run, so tests can check tool call context. */
  seen: string[][];
}

export function noteTool(): NoteTool {
  const seen: string[][] = [];
  return {
    seen,
    tool: {
      name: 'notes.add',
      description: 'Add a note.',
      input: z.object({ text: z.string() }),
      effects: ['write'],
      run: async (input, ctx) => {
        seen.push([...ctx.call.grounding]);
        return { saved: input.text };
      },
    },
  };
}

export interface SendTool {
  tool: Tool<{ body: string }, { messageId: string }>;
  /** Bodies that actually reached the tool, so tests can prove a denial never ran. */
  sent: string[];
}

export function sendTool(): SendTool {
  const sent: string[] = [];
  return {
    sent,
    tool: {
      name: 'mail.send',
      description: 'Send a mail.',
      input: z.object({ body: z.string() }),
      effects: ['send'],
      describe: (input) => `Send mail: ${input.body}`,
      run: async (input) => {
        sent.push(input.body);
        return { messageId: 'm-1' };
      },
    },
  };
}
